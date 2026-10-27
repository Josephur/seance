/**
 * Sandboxed Lua execution engine using Fengari.
 *
 * Provides a secure, isolated runtime with:
 * - Lazy-loaded Fengari chunk
 * - Instruction limit hook (LUA_MASKCOUNT) to safely abort infinite loops
 * - Stripped dangerous Lua globals (io, os, package, debug, file loaders)
 * - Safe bridge for the `seance` API
 */

import type * as FengariType from "fengari";
import type {ScriptMessageEvent} from "./types";
import {loadScriptData, saveScriptData} from "./storage";

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

export class LuaSandbox {
	private fengari: typeof FengariType;
	private L: any;
	private host: SandboxHost;
	private currentScriptId?: string;
	private instructionCount = 0;

	private constructor(fengari: typeof FengariType, host: SandboxHost) {
		this.fengari = fengari;
		this.host = host;
		const {lua, lauxlib, lualib} = fengari;

		this.L = lauxlib.luaL_newstate();
		lualib.luaL_openlibs(this.L);

		this.setupInstructionHook();
		this.sanitizeGlobals();
		this.injectHostBridge();
	}

	public static async create(host: SandboxHost): Promise<LuaSandbox> {
		const fengari = await getFengari();
		return new LuaSandbox(fengari, host);
	}

	private setupInstructionHook(): void {
		const {lua, to_luastring} = this.fengari;
		lua.lua_sethook(
			this.L,
			(state: any) => {
				this.instructionCount += 1000;

				if (this.instructionCount > MAX_INSTRUCTIONS) {
					lua.lua_pushstring(
						state,
						to_luastring("Instruction limit exceeded (possible infinite loop)")
					);
					lua.lua_error(state);
				}
			},
			lua.LUA_MASKCOUNT,
			1000
		);
	}

	private resetInstructions(): void {
		this.instructionCount = 0;
	}

	private sanitizeGlobals(): void {
		const {lua, to_luastring} = this.fengari;
		const dangerous = ["io", "os", "package", "debug", "dofile", "loadfile"];

		for (const name of dangerous) {
			lua.lua_pushnil(this.L);
			lua.lua_setglobal(this.L, to_luastring(name));
		}
	}

	private getString(state: any, idx: number): string {
		const {lua, to_jsstring} = this.fengari;
		const str = lua.lua_tostring(state, idx);
		return str ? to_jsstring(str) : "";
	}

	private injectHostBridge(): void {
		const {lua, lauxlib, to_luastring} = this.fengari;

		// 1. Error callback: _SEANCE_ERROR(msg)
		lua.lua_pushcfunction(this.L, (state: any) => {
			const str = this.getString(state, 1);
			this.host.onError(str, this.currentScriptId);
			return 0;
		});
		lua.lua_setglobal(this.L, to_luastring("_SEANCE_ERROR"));

		// 2. seance table
		lua.lua_newtable(this.L);

		// seance.send(line, networkUuid?)
		lua.lua_pushcfunction(this.L, (state: any) => {
			const line = this.getString(state, 1);
			let net: string | undefined;

			if (lua.lua_isstring(state, 2)) {
				net = this.getString(state, 2);
			}

			this.host.send(line, net);
			return 0;
		});
		lua.lua_setfield(this.L, -2, to_luastring("send"));

		// seance.reply(msgTable, text)
		lua.lua_pushcfunction(this.L, (state: any) => {
			if (!lua.lua_istable(state, 1)) {
				return 0;
			}

			const text = this.getString(state, 2);
			const msgObj = this.toJsValue(1) as ScriptMessageEvent;

			if (msgObj && typeof text === "string") {
				this.host.reply(msgObj, text);
			}

			return 0;
		});
		lua.lua_setfield(this.L, -2, to_luastring("reply"));

		// seance.print(text)
		lua.lua_pushcfunction(this.L, (state: any) => {
			const text = this.getString(state, 1);
			this.host.print(text);
			return 0;
		});
		lua.lua_setfield(this.L, -2, to_luastring("print"));

		// storage table: seance.storage.get(k), seance.storage.set(k, v)
		lua.lua_newtable(this.L);

		lua.lua_pushcfunction(this.L, (state: any) => {
			const key = this.getString(state, 1);
			const id = this.currentScriptId || "global";
			const data = loadScriptData(id);
			const val = data[key];

			if (val === undefined) {
				lua.lua_pushnil(state);
			} else {
				lua.lua_pushstring(state, to_luastring(val));
			}

			return 1;
		});
		lua.lua_setfield(this.L, -2, to_luastring("get"));

		lua.lua_pushcfunction(this.L, (state: any) => {
			const key = this.getString(state, 1);
			const id = this.currentScriptId || "global";
			const data = loadScriptData(id);

			if (lua.lua_isnil(state, 2)) {
				delete data[key];
			} else {
				const val = this.getString(state, 2);
				data[key] = val;
			}

			saveScriptData(id, data);
			return 0;
		});
		lua.lua_setfield(this.L, -2, to_luastring("set"));

		lua.lua_setfield(this.L, -2, to_luastring("storage"));

		// Add metatable for dynamic properties (current_channel, current_network, nick)
		lua.lua_newtable(this.L); // metatable
		lua.lua_pushcfunction(this.L, (state: any) => {
			const prop = this.getString(state, 2);
			const ctx = this.host.getCurrentContext();

			if (prop === "current_channel") {
				lua.lua_pushstring(state, to_luastring(ctx.channel));
				return 1;
			}

			if (prop === "current_network") {
				lua.lua_pushstring(state, to_luastring(ctx.network));
				return 1;
			}

			if (prop === "nick") {
				lua.lua_pushstring(state, to_luastring(ctx.nick));
				return 1;
			}

			lua.lua_pushnil(state);
			return 1;
		});
		lua.lua_setfield(this.L, -2, to_luastring("__index"));
		lua.lua_setmetatable(this.L, -2);

		lua.lua_setglobal(this.L, to_luastring("seance"));

		// 3. Bootstrap standard dispatch structures and helper functions
		const bootstrap = `
			_SEANCE_HANDLERS = {}
			_SEANCE_COMMANDS = {}

			seance.on = function(evt, fn)
				if type(evt) ~= "string" or type(fn) ~= "function" then return end
				local key = string.lower(evt)
				if not _SEANCE_HANDLERS[key] then _SEANCE_HANDLERS[key] = {} end
				table.insert(_SEANCE_HANDLERS[key], fn)
			end

			seance.register_command = function(name, fn)
				if type(name) ~= "string" or type(fn) ~= "function" then return end
				_SEANCE_COMMANDS[string.lower(name)] = fn
			end

			function _SEANCE_DISPATCH(evt, data)
				local handlers = _SEANCE_HANDLERS[string.lower(evt)]
				if not handlers then return end
				for _, fn in ipairs(handlers) do
					local ok, err = pcall(fn, data)
					if not ok then
						_SEANCE_ERROR("Error in " .. evt .. " handler: " .. tostring(err))
					end
				end
			end

			function _SEANCE_RUN_COMMAND(name, args, rest)
				local cmd = _SEANCE_COMMANDS[string.lower(name)]
				if cmd then
					local ok, err = pcall(cmd, args, rest)
					if not ok then
						_SEANCE_ERROR("Error in /" .. name .. " command: " .. tostring(err))
					end
					return true
				end
				return false
			end

			function _SEANCE_HAS_COMMAND(name)
				return _SEANCE_COMMANDS[string.lower(name)] ~= nil
			end

			function _SEANCE_COMMAND_NAMES()
				local names = {}
				for k, _ in pairs(_SEANCE_COMMANDS) do
					table.insert(names, k)
				end
				return names
			end
		`;

		lauxlib.luaL_dostring(this.L, to_luastring(bootstrap));
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

	public toJsValue(idx: number): unknown {
		const {lua, lauxlib, to_jsstring} = this.fengari;
		const type = lua.lua_type(this.L, idx);

		switch (type) {
			case lua.LUA_TNIL:
				return undefined;
			case lua.LUA_TBOOLEAN:
				return lua.lua_toboolean(this.L, idx);
			case lua.LUA_TNUMBER:
				return lua.lua_tonumber(this.L, idx);

			case lua.LUA_TSTRING: {
				const str = lua.lua_tostring(this.L, idx);
				return str ? to_jsstring(str) : "";
			}

			case lua.LUA_TTABLE: {
				const obj: Record<string, unknown> = {};
				const absIdx = idx < 0 ? lua.lua_gettop(this.L) + idx + 1 : idx;
				lua.lua_pushnil(this.L);

				while (lua.lua_next(this.L, absIdx) !== 0) {
					const k = String(this.toJsValue(-2));
					const v = this.toJsValue(-1);
					obj[k] = v;
					lua.lua_pop(this.L, 1);
				}

				return obj;
			}

			default:
				return `[lua ${to_jsstring(lua.lua_typename(this.L, type))}]`;
		}
	}

	public eval(
		code: string,
		scriptId?: string
	): {success: boolean; result?: string; error?: string} {
		const {lua, lauxlib, to_luastring, to_jsstring} = this.fengari;
		this.resetInstructions();
		this.currentScriptId = scriptId;

		const loadStatus = lauxlib.luaL_loadstring(this.L, to_luastring(code));

		if (loadStatus !== lua.LUA_OK) {
			const err = to_jsstring(lauxlib.luaL_tolstring(this.L, -1));
			lua.lua_pop(this.L, 1);
			return {success: false, error: err};
		}

		const callStatus = lua.lua_pcall(this.L, 0, lua.LUA_MULTRET, 0);

		if (callStatus !== lua.LUA_OK) {
			const err = to_jsstring(lauxlib.luaL_tolstring(this.L, -1));
			lua.lua_pop(this.L, 1);
			return {success: false, error: err};
		}

		const nres = lua.lua_gettop(this.L);
		const results: string[] = [];

		for (let i = 1; i <= nres; i++) {
			results.push(String(this.toJsValue(i)));
		}

		lua.lua_settop(this.L, 0);

		return {
			success: true,
			result: results.length > 0 ? results.join("  ") : undefined,
		};
	}

	public dispatch(event: string, payload: unknown): void {
		const {lua, to_luastring} = this.fengari;
		this.resetInstructions();
		lua.lua_getglobal(this.L, to_luastring("_SEANCE_DISPATCH"));
		this.pushValue(event);
		this.pushValue(payload);
		lua.lua_pcall(this.L, 2, 0, 0);
	}

	public runCommand(name: string, args: string[], rest: string): boolean {
		const {lua, to_luastring} = this.fengari;
		this.resetInstructions();
		lua.lua_getglobal(this.L, to_luastring("_SEANCE_RUN_COMMAND"));
		this.pushValue(name);
		this.pushValue(args);
		this.pushValue(rest);
		const status = lua.lua_pcall(this.L, 3, 1, 0);

		if (status !== lua.LUA_OK) {
			lua.lua_pop(this.L, 1);
			return false;
		}

		const handled = lua.lua_toboolean(this.L, -1);
		lua.lua_pop(this.L, 1);
		return Boolean(handled);
	}

	public hasCommand(name: string): boolean {
		const {lua, to_luastring} = this.fengari;
		lua.lua_getglobal(this.L, to_luastring("_SEANCE_HAS_COMMAND"));
		this.pushValue(name);
		const status = lua.lua_pcall(this.L, 1, 1, 0);

		if (status !== lua.LUA_OK) {
			lua.lua_pop(this.L, 1);
			return false;
		}

		const has = lua.lua_toboolean(this.L, -1);
		lua.lua_pop(this.L, 1);
		return Boolean(has);
	}

	public getRegisteredCommandNames(): string[] {
		const {lua, to_luastring} = this.fengari;
		lua.lua_getglobal(this.L, to_luastring("_SEANCE_COMMAND_NAMES"));
		const status = lua.lua_pcall(this.L, 0, 1, 0);

		if (status !== lua.LUA_OK) {
			lua.lua_pop(this.L, 1);
			return [];
		}

		const res = this.toJsValue(-1);
		lua.lua_pop(this.L, 1);
		return res && typeof res === "object" ? Object.values(res as Record<string, string>) : [];
	}

	public close(): void {
		if (this.L) {
			this.fengari.lua.lua_close(this.L);
			this.L = null;
		}
	}
}
