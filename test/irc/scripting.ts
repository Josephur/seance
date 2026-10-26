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
	type Script,
} from "../../client/js/irc/scripting/storage";
import {LuaSandbox, type SandboxHost} from "../../client/js/irc/scripting/engine";
import type {ScriptMessageEvent} from "../../client/js/irc/scripting/types";

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
			};
			saveScripts([script]);
			saveScriptData("del_me", {testKey: "testVal"});

			expect(loadScriptData("del_me")).to.deep.equal({testKey: "testVal"});
			deleteScript("del_me");

			expect(loadScripts()).to.have.lengthOf(0);
			expect(loadScriptData("del_me")).to.deep.equal({});
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
	});
});
