import {expect} from "chai";
import {
	loadScripts,
	saveScripts,
	deleteScript,
	isValidScriptName,
	loadScriptData,
	saveScriptData,
	useStorageBackend,
	STORAGE_KEY,
	STORAGE_PREFIX,
	compareScripts,
	DEFAULT_FOLDER,
	normalizeFolder,
	scriptFolders,
} from "../../client/js/irc/scripting/storage";
import {LuaSandbox, type SandboxHost} from "../../client/js/irc/scripting/engine";
import type {Script, ScriptMessageEvent} from "../../client/js/irc/scripting/types";
import {scriptManager, SCRIPTING_DISABLED_ERROR} from "../../client/js/irc/scripting/manager";
import {isScriptingEnabled, setScriptingEnabled} from "../../client/js/irc/scripting/enabled";

describe("Lua scripting subsystem", function () {
	describe("storage (irc/scripting/storage.ts)", function () {
		let store: Map<string, string>;

		beforeEach(function () {
			store = new Map<string, string>();
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				set: (k, v) => void store.set(k, v),
				remove: (k) => void store.delete(k),
			});
		});

		afterEach(function () {
			useStorageBackend(null);
		});

		it("validates script names", function () {
			expect(isValidScriptName("hello")).to.be.true;
			expect(isValidScriptName("auto_ping")).to.be.true;
			expect(isValidScriptName("my-script-1")).to.be.true;
			expect(isValidScriptName("")).to.be.false;
			expect(isValidScriptName("hello world")).to.be.false;
			expect(isValidScriptName("a".repeat(33))).to.be.false;
			expect(isValidScriptName("$invalid")).to.be.false;
		});

		it("loads and saves script definitions", function () {
			expect(loadScripts()).to.deep.equal([]);

			const script: Script = {
				id: "s1",
				name: "test_script",
				code: "print('hello')",
				enabled: true,
				folder: "Automation",
				description: "Says hello",
			};
			saveScripts([script]);

			const loaded = loadScripts();
			expect(loaded).to.have.lengthOf(1);
			expect(loaded[0].id).to.equal("s1");
			expect(loaded[0].name).to.equal("test_script");
			expect(loaded[0].code).to.equal("print('hello')");
			expect(loaded[0].enabled).to.be.true;
		});

		it("deletes script and associated data", function () {
			const script: Script = {
				id: "del_me",
				name: "to_delete",
				code: "seance.print('hi')",
				enabled: false,
				folder: DEFAULT_FOLDER,
			};
			saveScripts([script]);
			saveScriptData("del_me", {testKey: "testVal"});

			expect(loadScriptData("del_me")).to.deep.equal({testKey: "testVal"});
			deleteScript("del_me");

			expect(loadScripts()).to.have.lengthOf(0);
			expect(loadScriptData("del_me")).to.deep.equal({});
		});

		it("normalizes folders and descriptions", function () {
			expect(normalizeFolder("  My  Scripts ")).to.equal("My Scripts");
			expect(normalizeFolder("")).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder("a/b")).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder("x".repeat(41))).to.equal(DEFAULT_FOLDER);
			expect(normalizeFolder(undefined)).to.equal(DEFAULT_FOLDER);
		});

		it("files legacy scripts without a folder under Unsorted", function () {
			store.set(
				STORAGE_KEY,
				JSON.stringify([
					{id: "old", name: "legacy", code: "return 1", enabled: true},
					{
						id: "new",
						name: "filed",
						code: "return 2",
						enabled: false,
						folder: "Commands",
						description: "  Adds  a command ",
					},
				])
			);
			const loaded = loadScripts();
			expect(loaded[0].folder).to.equal(DEFAULT_FOLDER);
			expect(loaded[0].description).to.equal(undefined);
			expect(loaded[1].folder).to.equal("Commands");
			expect(loaded[1].description).to.equal("Adds a command");
		});

		it("lists folders once, Unsorted last, and orders the library by folder then name", function () {
			const mk = (name: string, folder: string): Script => ({
				id: name,
				name,
				folder,
				code: "",
				enabled: true,
			});
			const list = [
				mk("b", "commands"),
				mk("a", "Commands"),
				mk("z", DEFAULT_FOLDER),
				mk("c", "Automation"),
			];
			// First-seen spelling wins for a folder that differs only by case.
			expect(scriptFolders(list)).to.deep.equal(["Automation", "commands", DEFAULT_FOLDER]);
			expect([...list].sort(compareScripts).map((s) => s.name)).to.deep.equal([
				"c",
				"a",
				"b",
				"z",
			]);
		});
	});

	describe("sandbox engine (irc/scripting/engine.ts)", function () {
		let sentLines: {line: string; net?: string}[] = [];
		let repliedLines: {msg: ScriptMessageEvent; text: string}[] = [];
		let printedLines: string[] = [];
		let errors: string[] = [];
		let sandbox: LuaSandbox;

		const mockHost: SandboxHost = {
			send(line, net) {
				sentLines.push({line, net});
			},
			reply(msg, text) {
				repliedLines.push({msg, text});
			},
			print(text) {
				printedLines.push(text);
			},
			getCurrentContext() {
				return {
					channel: "#seance",
					network: "SeanceDev",
					nick: "tester",
				};
			},
			onError(err) {
				errors.push(err);
			},
		};

		let mockStore: Map<string, string>;

		beforeEach(async function () {
			sentLines = [];
			repliedLines = [];
			printedLines = [];
			errors = [];
			mockStore = new Map<string, string>();
			useStorageBackend({
				get: (k) => mockStore.get(k) ?? null,
				set: (k, v) => void mockStore.set(k, v),
				remove: (k) => void mockStore.delete(k),
			});
			sandbox = await LuaSandbox.create(mockHost);
		});

		afterEach(function () {
			useStorageBackend(null);
			sandbox.close();
		});

		it("evaluates basic Lua code and returns results", function () {
			const res = sandbox.eval("return 40 + 2");
			expect(res.success).to.be.true;
			expect(res.result).to.equal("42");
		});

		it("catches syntax errors", function () {
			const res = sandbox.eval("function unclosed(");
			expect(res.success).to.be.false;
			expect(res.error).to.be.a("string");
		});

		it("sanitizes dangerous globals (io, os, package, debug)", function () {
			const res = sandbox.eval(`
				assert(io == nil, "io should be nil")
				assert(os == nil, "os should be nil")
				assert(package == nil, "package should be nil")
				assert(debug == nil, "debug should be nil")
				assert(dofile == nil, "dofile should be nil")
				assert(loadfile == nil, "loadfile should be nil")
				return "secure"
			`);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("secure");
		});

		it("aborts infinite loops with instruction count hook", function () {
			this.timeout(5000);
			const res = sandbox.eval("while true do end");
			expect(res.success).to.be.false;
			expect(res.error).to.include("Instruction limit exceeded");
		});

		it("supports seance.on('message') event handlers", function () {
			const code = `
				seance.on("message", function(msg)
					if msg.text == "!ping" then
						seance.reply(msg, "pong " .. msg.from)
					end
				end)
			`;
			const res = sandbox.eval(code);
			expect(res.success).to.be.true;

			const event: ScriptMessageEvent = {
				network: "SeanceDev",
				target: "#seance",
				from: "alice",
				text: "!ping",
				type: "message",
				self: false,
			};

			sandbox.dispatch("message", event);
			expect(repliedLines).to.have.lengthOf(1);
			expect(repliedLines[0].text).to.equal("pong alice");
			expect(repliedLines[0].msg.target).to.equal("#seance");
			expect(repliedLines[0].msg.from).to.equal("alice");
		});

		it("supports registering and running custom slash commands", function () {
			const code = `
				seance.register_command("wave", function(args, rest)
					seance.send("PRIVMSG " .. seance.current_channel .. " :*waves at " .. rest .. "*")
				end)
			`;
			const res = sandbox.eval(code);
			expect(res.success).to.be.true;

			expect(sandbox.hasCommand("wave")).to.be.true;
			expect(sandbox.hasCommand("unknown")).to.be.false;

			const handled = sandbox.runCommand("wave", ["bob"], "bob");
			expect(handled).to.be.true;
			expect(sentLines).to.have.lengthOf(1);
			expect(sentLines[0].line).to.equal("PRIVMSG #seance :*waves at bob*");
		});

		it("provides read-only context properties", function () {
			const res = sandbox.eval(`
				return seance.current_channel .. " on " .. seance.current_network .. " as " .. seance.nick
			`);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("#seance on SeanceDev as tester");
		});

		it("provides persistent key-value storage per script", function () {
			const res = sandbox.eval(
				`
				seance.storage.set("counter", "10")
				return seance.storage.get("counter")
			`,
				"script_123"
			);
			expect(res.success).to.be.true;
			expect(res.result).to.equal("10");

			// Clear key
			const res2 = sandbox.eval(
				`
				seance.storage.set("counter", nil)
				return tostring(seance.storage.get("counter"))
			`,
				"script_123"
			);
			expect(res2.success).to.be.true;
			expect(res2.result).to.equal("nil");
		});

		it("persists storage across sandbox reloads and isolates scripts", async function () {
			sandbox.eval(`seance.storage.set("shared_key", "value_for_s1")`, "script_1");
			sandbox.eval(`seance.storage.set("shared_key", "value_for_s2")`, "script_2");

			// Values are isolated per script
			const r1 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_1");
			const r2 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_2");
			expect(r1.result).to.equal("value_for_s1");
			expect(r2.result).to.equal("value_for_s2");

			// Close sandbox and re-open to simulate page reload / client restart
			sandbox.close();
			sandbox = await LuaSandbox.create(mockHost);

			const rReload1 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_1");
			const rReload2 = sandbox.eval(`return seance.storage.get("shared_key")`, "script_2");
			expect(rReload1.result).to.equal("value_for_s1");
			expect(rReload2.result).to.equal("value_for_s2");
		});

		it("supports join, part, quit, kick, nick, topic, mode, and send events", function () {
			const events: Record<string, any> = {};

			sandbox.eval(
				`
				seance.on("join", function(d) seance.storage.set("join_nick", d.nick) end)
				seance.on("part", function(d) seance.storage.set("part_nick", d.nick) end)
				seance.on("quit", function(d) seance.storage.set("quit_nick", d.nick) end)
				seance.on("kick", function(d) seance.storage.set("kick_kicked", d.kicked) end)
				seance.on("nick", function(d) seance.storage.set("nick_new", d.newNick) end)
				seance.on("topic", function(d) seance.storage.set("topic_val", d.topic) end)
				seance.on("mode", function(d) seance.storage.set("mode_val", d.mode) end)
				seance.on("send", function(d) seance.storage.set("send_line", d.line) end)
			`,
				"events_script"
			);

			sandbox.dispatch("join", {
				nick: "alice",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("part", {
				nick: "bob",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("quit", {nick: "charlie", network: "test"});
			sandbox.dispatch("kick", {
				nick: "op",
				kicked: "dave",
				channel: "#seance",
				network: "test",
				self: false,
			});
			sandbox.dispatch("nick", {
				oldNick: "eve",
				newNick: "eve2",
				network: "test",
				self: false,
			});
			sandbox.dispatch("topic", {
				channel: "#seance",
				topic: "New Topic",
				nick: "alice",
				network: "test",
			});
			sandbox.dispatch("mode", {
				target: "#seance",
				mode: "+o",
				params: ["alice"],
				from: "op",
				network: "test",
			});
			sandbox.dispatch("send", {line: "Hello world", target: "#seance"});

			const check = (key: string) =>
				sandbox.eval(`return seance.storage.get("${key}")`, "events_script").result;
			expect(check("join_nick")).to.equal("alice");
			expect(check("part_nick")).to.equal("bob");
			expect(check("quit_nick")).to.equal("charlie");
			expect(check("kick_kicked")).to.equal("dave");
			expect(check("nick_new")).to.equal("eve2");
			expect(check("topic_val")).to.equal("New Topic");
			expect(check("mode_val")).to.equal("+o");
			expect(check("send_line")).to.equal("Hello world");
		});
	});

	describe("manager gate (irc/scripting/manager.ts + enabled.ts)", function () {
		let store: Map<string, string>;

		beforeEach(function () {
			store = new Map<string, string>();
			useStorageBackend({
				get: (k) => store.get(k) ?? null,
				set: (k, v) => void store.set(k, v),
				remove: (k) => void store.delete(k),
			});
			setScriptingEnabled(false);
			scriptManager.teardown();
		});

		afterEach(function () {
			setScriptingEnabled(false);
			scriptManager.teardown();
			useStorageBackend(null);
		});

		it("does not load the parser or run anything while disabled", async function () {
			expect(isScriptingEnabled()).to.be.false;
			const res = await scriptManager.evalSnippet("return 1");
			expect(res.success).to.be.false;
			expect(res.error).to.equal(SCRIPTING_DISABLED_ERROR);
			expect(scriptManager.loaded).to.be.false;
			expect(scriptManager.hasCommand("anything")).to.be.false;
			expect(scriptManager.getCommandNames()).to.deep.equal([]);
			await scriptManager.init();
			expect(scriptManager.loaded).to.be.false;
		});

		it("loads enabled scripts when turned on and tears them down when turned off", async function () {
			saveScripts([
				{
					id: "gated",
					name: "gated_cmd",
					folder: "Commands",
					code: `seance.register_command("gatedwave", function(args, rest) end)`,
					enabled: true,
				},
			]);
			setScriptingEnabled(true);
			// The manager defers its first load by a microtask (boot ordering).
			await new Promise((resolve) => setTimeout(resolve, 0));
			await scriptManager.init();
			expect(scriptManager.loaded).to.be.true;
			expect(scriptManager.hasCommand("gatedwave")).to.be.true;

			setScriptingEnabled(false);
			expect(scriptManager.loaded).to.be.false;
			expect(scriptManager.hasCommand("gatedwave")).to.be.false;
			const res = await scriptManager.evalSnippet("return 1");
			expect(res.success).to.be.false;
		});
	});
});
