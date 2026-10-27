/**
 * Sandboxed Lua execution engine using Fengari.
 *
 * Provides an isolated runtime with:
 * - Lazy-loaded Fengari chunk
 * - Only the base, coroutine, table, string, math and utf8 libraries: no
 *   `io`, `os`, `package`/`require` or `debug` exist, not even in the
 *   registry's loaded-module table
 * - `load` limited to source text (no bytecode), no `string.dump`, `dofile`
 *   or `loadfile`, and a cap on what `string.rep` may build
 * - An instruction limit hook (LUA_MASKCOUNT) that aborts runaway code; new
 *   coroutines inherit it and count against the same budget
 * - One environment per script, each with its own read-only `seance` table
 *   bound to that script's id, and the dispatch tables kept in locals no
 *   script can reach
 */

import type * as FengariType from "fengari";
import type {ScriptMessageEvent} from "./types";
import {ScriptStorageError, loadScriptData, saveScriptData} from "./storage";

let fengariPromise: Promise<typeof FengariType> | null = null;

export function getFengari(): Promise<typeof FengariType> {
	if (!fengariPromise) {
		fengariPromise = import(/* webpackChunkName: "fengari" */ "fengari");
	}

	return fengariPromise;
}

export interface SandboxHost {
	send(line: string, networkUuid?: string): void;
	reply(msg: ScriptMessageEvent, text: string): void;
	print(text: string): void;
	getCurrentContext(): {channel: string; network: string; nick: string};
	onError(error: string, scriptId?: string): void;
}

const MAX_INSTRUCTIONS = 100000;
const HOOK_INTERVAL = 1000;
/** The longest string `string.rep` may build, in bytes. */
export const MAX_REP_LENGTH = 1 << 20;
/** The storage bucket and error owner of `/lua` snippets. */
const SNIPPET_ID = "global";
/** How deep a Lua table is followed when it is handed to JavaScript. */
const MAX_TABLE_DEPTH = 8;

// Runs once per state with the host functions as its argument and returns
// the internals the engine calls. Everything a script could use to break
// another script lives in its locals.
const BOOTSTRAP = `
	local host = ...
	local base_load, pcall, error, type, tostring, setmetatable, select, ipairs, pairs =
		load, pcall, error, type, tostring, setmetatable, select, ipairs, pairs
	local lower, insert, rep = string.lower, table.insert, string.rep
	local max_rep = host.max_rep

	-- Source text only: Lua's undumper trusts the bytecode it is given.
	load = function(chunk, name, mode, ...)
		if select("#", ...) > 0 then
			return base_load(chunk, name, "t", ...)
		end
		return base_load(chunk, name, "t")
	end
	dofile, loadfile, string.dump = nil, nil, nil

	string.rep = function(s, n, sep)
		if type(n) == "number" and n > 1 then
			local size = #tostring(s) * n
			if sep ~= nil then
				size = size + #tostring(sep) * (n - 1)
			end
			if size > max_rep then
				error("string.rep: result too large", 2)
			end
		end
		return rep(s, n, sep)
	end

	local handlers, commands, envs = {}, {}, {}

	local function readonly()
		error("seance is read-only", 2)
	end

	local function api_for(id)
		local storage = setmetatable({}, {
			__index = {
				get = function(key) return host.storage_get(id, key) end,
				set = function(key, value)
					local err = host.storage_set(id, key, value)
					if err then error(err, 2) end
				end,
			},
			__newindex = readonly,
			__metatable = false,
		})

		local api = {
			send = host.send,
			reply = host.reply,
			print = host.print,
			storage = storage,
			on = function(evt, fn)
				if type(evt) ~= "string" or type(fn) ~= "function" then return end
				local key = lower(evt)
				local list = handlers[key]
				if not list then
					list = {}
					handlers[key] = list
				end
				insert(list, {id = id, fn = fn})
			end,
			register_command = function(name, fn)
				if type(name) ~= "string" or type(fn) ~= "function" then return end
				commands[lower(name)] = {id = id, fn = fn}
			end,
		}

		return setmetatable({}, {
			__index = function(_, k)
				local v = api[k]
				if v ~= nil then return v end
				return host.context(k)
			end,
			__newindex = readonly,
			__metatable = false,
		})
	end

	local function env_for(id)
		local env = envs[id]
		if not env then
			env = setmetatable({seance = api_for(id)}, {__index = _G})
			envs[id] = env
		end
		return env
	end

	local function load_script(id, code)
		return base_load(code, nil, "t", env_for(id))
	end

	local function dispatch(evt, data)
		local list = handlers[lower(evt)]
		if not list then return end
		for _, h in ipairs(list) do
			host.begin()
			local ok, err = pcall(h.fn, data)
			if not ok then
				host.error(h.id, "Error in " .. evt .. " handler: " .. tostring(err))
			end
		end
	end

	local function run_command(name, args, rest)
		local cmd = commands[lower(name)]
		if not cmd then return false end
		host.begin()
		local ok, err = pcall(cmd.fn, args, rest)
		if not ok then
			host.error(cmd.id, "Error in /" .. name .. " command: " .. tostring(err))
		end
		return true
	end

	local function has_command(name)
		return commands[lower(name)] ~= nil
	end

	local function command_names()
		local names = {}
		for k in pairs(commands) do
			insert(names, k)
		end
		return names
	end

	return {
		load = load_script,
		dispatch = dispatch,
		run = run_command,
		has = has_command,
		names = command_names,
	}
`;

export class LuaSandbox {
	private fengari: typeof FengariType;
	private L: any;
	private host: SandboxHost;
	private instructionCount = 0;
	/** Registry reference to the table BOOTSTRAP returned. */
	private internals = 0;

	private constructor(fengari: typeof FengariType, host: SandboxHost) {
		this.fengari = fengari;
		this.host = host;

		this.L = fengari.lauxlib.luaL_newstate();
		this.openSafeLibs();
		this.setupInstructionHook();
		this.bootstrap();
	}

	public static async create(host: SandboxHost): Promise<LuaSandbox> {
		const fengari = await getFengari();
		return new LuaSandbox(fengari, host);
	}

	private openSafeLibs(): void {
		const {lua, lauxlib, lualib, to_luastring} = this.fengari;
		const libs: [string, (L: any) => number][] = [
			["_G", lualib.luaopen_base],
			[lualib.LUA_COLIBNAME, lualib.luaopen_coroutine],
			[lualib.LUA_TABLIBNAME, lualib.luaopen_table],
			[lualib.LUA_STRLIBNAME, lualib.luaopen_string],
			[lualib.LUA_MATHLIBNAME, lualib.luaopen_math],
			[lualib.LUA_UTF8LIBNAME, lualib.luaopen_utf8],
		];

		for (const [name, open] of libs) {
			lauxlib.luaL_requiref(this.L, to_luastring(name), open, 1);
			lua.lua_pop(this.L, 1);
		}
	}

	private readonly hook = (state: any): void => {
		const {lua, to_luastring} = this.fengari;
		this.instructionCount += lua.lua_gethookcount(state);

		if (this.instructionCount > MAX_INSTRUCTIONS) {
			// From here every instruction raises, so a pcall in a loop cannot
			// catch the error and go round again: the loop around it dies on
			// its next instruction.
			lua.lua_sethook(state, this.hook, lua.LUA_MASKCOUNT, 1);
			lua.lua_sethook(this.L, this.hook, lua.LUA_MASKCOUNT, 1);
			lua.lua_pushstring(
				state,
				to_luastring("Instruction limit exceeded (possible infinite loop)")
			);
			lua.lua_error(state);
		}
	};

	private setupInstructionHook(): void {
		// Set on the main state before any script runs; lua_newthread copies
		// it to every coroutine, and they all charge the same counter.
		this.fengari.lua.lua_sethook(
			this.L,
			this.hook,
			this.fengari.lua.LUA_MASKCOUNT,
			HOOK_INTERVAL
		);
	}

	private resetInstructions(): void {
		this.instructionCount = 0;
		this.setupInstructionHook();
	}

	private getString(state: any, idx: number): string {
		const {lua, to_jsstring} = this.fengari;
		const str = lua.lua_tostring(state, idx);
		return str ? to_jsstring(str) : "";
	}

	private bootstrap(): void {
		const {lua, lauxlib, to_luastring} = this.fengari;
		const L = this.L;

		const fn = (name: string, f: (state: any) => number) => {
			lua.lua_pushcfunction(L, f);
			lua.lua_setfield(L, -2, to_luastring(name));
		};

		if (lauxlib.luaL_loadstring(L, to_luastring(BOOTSTRAP)) !== lua.LUA_OK) {
			throw new Error(`Lua bootstrap: ${this.getString(L, -1)}`);
		}

		lua.lua_newtable(L);
		lua.lua_pushinteger(L, MAX_REP_LENGTH);
		lua.lua_setfield(L, -2, to_luastring("max_rep"));

		fn("begin", () => {
			this.resetInstructions();
			return 0;
		});

		fn("error", (state) => {
			const id = this.getString(state, 1);
			this.host.onError(this.getString(state, 2), id === SNIPPET_ID ? undefined : id);
			return 0;
		});

		// seance.send(line, networkUuid?)
		fn("send", (state) => {
			const line = this.getString(state, 1);
			const net = lua.lua_isstring(state, 2) ? this.getString(state, 2) : undefined;
			this.host.send(line, net);
			return 0;
		});

		// seance.reply(msgTable, text)
		fn("reply", (state) => {
			if (!lua.lua_istable(state, 1)) {
				return 0;
			}

			const text = this.getString(state, 2);
			const msgObj = this.toJsValue(1, state) as ScriptMessageEvent;

			if (msgObj && typeof msgObj.target === "string") {
				this.host.reply(msgObj, text);
			}

			return 0;
		});

		fn("print", (state) => {
			this.host.print(this.getString(state, 1));
			return 0;
		});

		fn("storage_get", (state) => {
			const data = loadScriptData(this.getString(state, 1));
			const val = data[this.getString(state, 2)];

			if (val === undefined) {
				lua.lua_pushnil(state);
			} else {
				lua.lua_pushstring(state, to_luastring(val));
			}

			return 1;
		});

		fn("storage_set", (state) => {
			const id = this.getString(state, 1);
			const key = this.getString(state, 2);
			const data = loadScriptData(id);

			if (lua.lua_isnoneornil(state, 3)) {
				delete data[key];
			} else {
				data[key] = this.getString(state, 3);
			}

			try {
				saveScriptData(id, data);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				lua.lua_pushstring(state, to_luastring(`seance.storage: ${err.message}`));
				return 1; // raised by the Lua side, at the caller's level
			}

			return 0;
		});

		// seance.current_channel, seance.current_network, seance.nick
		fn("context", (state) => {
			const prop = this.getString(state, 1);
			const ctx = this.host.getCurrentContext();
			const value =
				prop === "current_channel"
					? ctx.channel
					: prop === "current_network"
					? ctx.network
					: prop === "nick"
					? ctx.nick
					: undefined;

			if (value === undefined) {
				lua.lua_pushnil(state);
			} else {
				lua.lua_pushstring(state, to_luastring(value));
			}

			return 1;
		});

		if (lua.lua_pcall(L, 1, 1, 0) !== lua.LUA_OK) {
			throw new Error(`Lua bootstrap: ${this.getString(L, -1)}`);
		}

		this.internals = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
	}

	/** Push one of the functions BOOTSTRAP returned. */
	private pushInternal(name: string): void {
		const {lua, to_luastring} = this.fengari;
		lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, this.internals);
		lua.lua_getfield(this.L, -1, to_luastring(name));
		lua.lua_remove(this.L, -2);
	}

	public pushValue(val: unknown): void {
		const {lua, to_luastring} = this.fengari;

		if (val === null || val === undefined) {
			lua.lua_pushnil(this.L);
		} else if (typeof val === "string") {
			lua.lua_pushstring(this.L, to_luastring(val));
		} else if (typeof val === "number") {
			lua.lua_pushnumber(this.L, val);
		} else if (typeof val === "boolean") {
			lua.lua_pushboolean(this.L, val);
		} else if (Array.isArray(val)) {
			lua.lua_newtable(this.L);
			val.forEach((item, idx) => {
				lua.lua_pushinteger(this.L, idx + 1);
				this.pushValue(item);
				lua.lua_settable(this.L, -3);
			});
		} else if (typeof val === "object") {
			lua.lua_newtable(this.L);

			for (const [k, v] of Object.entries(val)) {
				lua.lua_pushstring(this.L, to_luastring(k));
				this.pushValue(v);
				lua.lua_settable(this.L, -3);
			}
		} else {
			lua.lua_pushnil(this.L);
		}
	}

	/** A Lua value as JavaScript; tables are followed MAX_TABLE_DEPTH deep (a cycle ends there). */
	public toJsValue(idx: number, state: any = this.L, depth = 0): unknown {
		const {lua, to_jsstring} = this.fengari;
		const type = lua.lua_type(state, idx);

		switch (type) {
			case lua.LUA_TNIL:
				return undefined;
			case lua.LUA_TBOOLEAN:
				return lua.lua_toboolean(state, idx);
			case lua.LUA_TNUMBER:
				return lua.lua_tonumber(state, idx);

			case lua.LUA_TSTRING: {
				const str = lua.lua_tostring(state, idx);
				return str ? to_jsstring(str) : "";
			}

			case lua.LUA_TTABLE: {
				if (depth >= MAX_TABLE_DEPTH) {
					return undefined;
				}

				const obj: Record<string, unknown> = {};
				const absIdx = idx < 0 ? lua.lua_gettop(state) + idx + 1 : idx;
				lua.lua_pushnil(state);

				while (lua.lua_next(state, absIdx) !== 0) {
					const k = String(this.toJsValue(-2, state, depth + 1));
					obj[k] = this.toJsValue(-1, state, depth + 1);
					lua.lua_pop(state, 1);
				}

				return obj;
			}

			default:
				return `[lua ${to_jsstring(lua.lua_typename(state, type))}]`;
		}
	}

	public eval(
		code: string,
		scriptId?: string
	): {success: boolean; result?: string; error?: string} {
		const {lua, lauxlib, to_jsstring} = this.fengari;
		const L = this.L;
		lua.lua_settop(L, 0);
		this.resetInstructions();

		const fail = () => {
			const error = to_jsstring(lauxlib.luaL_tolstring(L, -1));
			lua.lua_settop(L, 0);
			return {success: false, error};
		};

		this.pushInternal("load");
		this.pushValue(scriptId ?? SNIPPET_ID);
		this.pushValue(code);

		if (lua.lua_pcall(L, 2, 2, 0) !== lua.LUA_OK) {
			return fail();
		}

		if (lua.lua_isnil(L, -2)) {
			return fail(); // a syntax error: load's second result
		}

		lua.lua_pop(L, 1);

		if (lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0) !== lua.LUA_OK) {
			return fail();
		}

		const nres = lua.lua_gettop(L);
		const results: string[] = [];

		for (let i = 1; i <= nres; i++) {
			results.push(String(this.toJsValue(i)));
		}

		lua.lua_settop(L, 0);

		return {
			success: true,
			result: results.length > 0 ? results.join("  ") : undefined,
		};
	}

	/** Call one of the internals; its first result, or undefined when it failed. */
	private call(name: string, args: unknown[]): unknown {
		const {lua} = this.fengari;
		const top = lua.lua_gettop(this.L);
		this.resetInstructions();
		this.pushInternal(name);

		for (const arg of args) {
			this.pushValue(arg);
		}

		const status = lua.lua_pcall(this.L, args.length, 1, 0);
		const result = status === lua.LUA_OK ? this.toJsValue(-1) : undefined;
		lua.lua_settop(this.L, top);
		return result;
	}

	public dispatch(event: string, payload: unknown): void {
		this.call("dispatch", [event, payload]);
	}

	public runCommand(name: string, args: string[], rest: string): boolean {
		return this.call("run", [name, args, rest]) === true;
	}

	public hasCommand(name: string): boolean {
		return this.call("has", [name]) === true;
	}

	public getRegisteredCommandNames(): string[] {
		const res = this.call("names", []);
		return res && typeof res === "object" ? Object.values(res as Record<string, string>) : [];
	}

	public close(): void {
		if (this.L) {
			this.fengari.lua.lua_close(this.L);
			this.L = null;
		}
	}
}
