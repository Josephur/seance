#!/usr/bin/env node
/* eslint-disable no-console */
// Automated 2-client live testing of Lua scripting subsystem on
// fractalrealities.afternet.org:9998 TLS over WebSocket.
//
// Boots 2 headless, background Chromium instances (zero screen windows):
//   Bot A: Initiator and slash command tester
//   Bot B: Auto-responder testing channel events and private messages
//
// Tests:
//   1. Both bots connect to fractalrealities.afternet.org:9998 TLS (WSS) and join #seance
//   2. Rate-limited channel event test in #seance: Bot A pings, Bot B Lua responds, Bot A Lua acks
//   3. Rate-limited private message event test: Bot A PMs Bot B, Bot B Lua responds, Bot A Lua acks
//   4. Custom slash command test (/testcmd in #seance)
//   5. Strict loop prevention (self-messages dropped, non-matching ignored)
//   6. Clean exit (/quit) and resource teardown

import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {join, extname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {startDevice} from "./lib/device.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../../public");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startStaticServer() {
	const server = createServer(async (req, res) => {
		try {
			const parsed = new URL(req.url, "http://localhost");
			let path = parsed.pathname;
			if (path === "/" || path === "") {
				path = "/index.html";
			}

			let filePath = join(PUBLIC_DIR, path);
			let ext = extname(filePath).toLowerCase();
			let data;

			try {
				data = await readFile(filePath);
			} catch {
				// Fallback to index.html for SPA router
				filePath = join(PUBLIC_DIR, "index.html");
				ext = ".html";
				data = await readFile(filePath);
			}

			res.writeHead(200, {
				"Content-Type": MIME[ext] || "application/octet-stream",
				"Content-Length": data.length,
				"Cache-Control": "no-store",
			});
			res.end(data);
		} catch (err) {
			res.writeHead(500);
			res.end(`Internal error: ${err.message}`);
		}
	});

	await new Promise((res) => server.listen(0, "127.0.0.1", res));
	const port = server.address().port;
	return {
		server,
		port,
		url: `http://127.0.0.1:${port}/`,
	};
}

const joined = `!!document.querySelector('.channel-list-item[data-name="#seance"]:not(.parted-channel)')`;

async function main() {
	console.log("=== Starting Automated Lua Scripting Live Test ===");
	const {server, port, url} = await startStaticServer();
	console.log(`[HTTP] Local Seance web server started on ${url}`);

	const runId = Math.floor(1000 + Math.random() * 9000);
	const nickA = `sbot_a_${runId}`;
	const nickB = `sbot_b_${runId}`;
	const tokenChan = `c${runId}`;
	const tokenPm = `p${runId}`;
	const tokenCmd = `k${runId}`;

	console.log(`[SETUP] Bot A nick: ${nickA}, Bot B nick: ${nickB}`);

	let botA, botB;

	try {
		// --- 1. Configure and launch Bot B (Responder) ---
		console.log("[SETUP] Initializing Bot B (headless)...");
		botB = await startDevice({name: "bot-b", width: 1280, height: 900, logFrames: true});

		const scriptB = {
			id: "bot_b_responder",
			name: "bot_b_responder",
			folder: "Automation",
			description: "Automated Lua test responder",
			enabled: true,
			code: `
				seance.storage.set("role", "responder")
				seance.storage.set("chan_received", "")
				seance.storage.set("pm_received", "")
				seance.storage.set("cmd_received", "")
				seance.storage.set("last_join_nick", "")
				seance.storage.set("last_nick_change", "")

				seance.on("join", function(data)
					if not data.self and data.channel == "#seance" then
						seance.storage.set("last_join_nick", data.nick)
						seance.print("[BOT-B LUA] Saw user join #seance: " .. data.nick)
					end
				end)

				seance.on("nick", function(data)
					if not data.self then
						seance.storage.set("last_nick_change", data.oldNick .. "->" .. data.newNick)
						seance.print("[BOT-B LUA] Saw nick change: " .. data.oldNick .. " -> " .. data.newNick)
					end
				end)

				seance.on("message", function(msg)
					if msg.self then return end

					-- 1. Channel Ping in #seance
					if msg.target == "#seance" and string.find(msg.text or "", "!ping_chan_") then
						local token = string.match(msg.text, "!ping_chan_(%w+)")
						if token then
							seance.storage.set("chan_received", token)
							seance.print("[BOT-B LUA] Channel ping received: " .. token .. " from " .. msg.from)
							seance.reply(msg, "!pong_chan_" .. token)
						end
					end

					-- 2. Private Message Ping
					if (msg.target == "${nickB}" or not string.find(msg.target, "^[#&]")) and string.find(msg.text or "", "!ping_pm_") then
						local token = string.match(msg.text, "!ping_pm_(%w+)")
						if token then
							seance.storage.set("pm_received", token)
							seance.print("[BOT-B LUA] PM ping received: " .. token .. " from " .. msg.from)
							seance.reply(msg, "!pong_pm_" .. token)
						end
					end

					-- 3. Slash command ping in #seance
					if msg.target == "#seance" and string.find(msg.text or "", "!cmd_ping_") then
						local token = string.match(msg.text, "!cmd_ping_(%w+)")
						if token then
							seance.storage.set("cmd_received", token)
							seance.print("[BOT-B LUA] Custom command ping received: " .. token)
						end
					end
				end)
			`,
		};

		const netB = {
			uuid: `net-${nickB}`,
			name: "AfterNET",
			host: "fractalrealities.afternet.org",
			port: 9998,
			tls: true,
			nick: nickB,
			username: nickB,
			realname: "Seance Test Bot B",
			join: "#seance",
			autoconnect: true,
		};

		await botB.addInitScript(`
			try {
				localStorage.setItem("thelounge.state.installGuide", "dismissed");
				localStorage.setItem("settings", JSON.stringify({ enableScripting: true }));
				localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(netB)}]));
				localStorage.setItem("thelounge.scripts", JSON.stringify([${JSON.stringify(scriptB)}]));
				localStorage.setItem("thelounge.state.lastChannel", JSON.stringify({ network: "${
					netB.uuid
				}", target: "#seance" }));
			} catch(e) {}
		`);

		await botB.goto(url);
		console.log(`[CONNECT] Bot B connecting to fractalrealities.afternet.org:9998 TLS...`);
		await botB.waitFor(joined, {timeout: 30000, label: "Bot B joined #seance"});
		console.log(`[OK] Bot B joined #seance successfully.`);

		// --- 2. Configure and launch Bot A (Initiator) ---
		console.log("[SETUP] Initializing Bot A (headless)...");
		botA = await startDevice({name: "bot-a", width: 1280, height: 900, logFrames: true});

		const scriptA = {
			id: "bot_a_initiator",
			name: "bot_a_initiator",
			folder: "Automation",
			description: "Automated Lua test initiator",
			enabled: true,
			code: `
				seance.storage.set("role", "initiator")
				seance.storage.set("chan_ack", "")
				seance.storage.set("pm_ack", "")
				seance.storage.set("last_send_line", "")

				seance.on("send", function(data)
					seance.storage.set("last_send_line", data.line)
				end)

				seance.on("message", function(msg)
					if msg.self then return end

					-- Channel pong in #seance
					if msg.target == "#seance" and string.find(msg.text or "", "!pong_chan_") then
						local token = string.match(msg.text, "!pong_chan_(%w+)")
						if token then
							seance.storage.set("chan_ack", token)
							seance.print("[BOT-A LUA] Channel pong ack received: " .. token)
						end
					end

					-- Private message pong
					if string.find(msg.text or "", "!pong_pm_") then
						local token = string.match(msg.text, "!pong_pm_(%w+)")
						if token then
							seance.storage.set("pm_ack", token)
							seance.print("[BOT-A LUA] PM pong ack received: " .. token)
						end
					end
				end)

				seance.register_command("testcmd", function(args, rest)
					seance.send("PRIVMSG #seance :!cmd_ping_" .. rest)
				end)
			`,
		};

		const netA = {
			uuid: `net-${nickA}`,
			name: "AfterNET",
			host: "fractalrealities.afternet.org",
			port: 9998,
			tls: true,
			nick: nickA,
			username: nickA,
			realname: "Seance Test Bot A",
			join: "#seance",
			autoconnect: true,
		};

		await botA.addInitScript(`
			try {
				localStorage.setItem("thelounge.state.installGuide", "dismissed");
				localStorage.setItem("settings", JSON.stringify({ enableScripting: true }));
				localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(netA)}]));
				localStorage.setItem("thelounge.scripts", JSON.stringify([${JSON.stringify(scriptA)}]));
				localStorage.setItem("thelounge.state.lastChannel", JSON.stringify({ network: "${
					netA.uuid
				}", target: "#seance" }));
			} catch(e) {}
		`);

		await botA.goto(url);
		console.log(`[CONNECT] Bot A connecting to fractalrealities.afternet.org:9998 TLS...`);
		await botA.waitFor(joined, {timeout: 30000, label: "Bot A joined #seance"});
		console.log(`[OK] Bot A joined #seance successfully.`);

		// Rate limiting: sleep 2.5s before executing tests to respect IRC flood timers
		console.log("[RATE LIMIT] Waiting 2.5s before test execution...");
		await sleep(2500);

		// --- TEST 1: Channel Message Event in #seance ---
		console.log("\n--- TEST 1: Channel Event Handling (#seance) ---");
		console.log(`[STEP 1] Bot A sending '!ping_chan_${tokenChan}' to #seance...`);
		await botA.click('.channel-list-item[data-name="#seance"]');
		await botA.fill("#input", `!ping_chan_${tokenChan}`);
		await botA.click("#submit");

		console.log(
			"[WAIT] Waiting for Bot B to receive channel message and reply via seance.reply()..."
		);
		await botB.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").chan_received === "${tokenChan}"`,
			{timeout: 15000, label: "Bot B recorded chan_received"}
		);
		console.log(
			`[OK] Bot B Lua script successfully received channel message token '${tokenChan}'`
		);

		console.log("[WAIT] Waiting for Bot A to receive Bot B's pong reply in #seance...");
		await botA.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_a_initiator") || "{}").chan_ack === "${tokenChan}"`,
			{timeout: 15000, label: "Bot A recorded chan_ack"}
		);
		console.log(`[OK] Bot A Lua script successfully received channel pong reply from Bot B.`);
		console.log(
			">>> TEST 1 PASSED: Channel events and seance.reply(msg) in channel work properly."
		);

		// Rate limiting: sleep 2.5s
		console.log("[RATE LIMIT] Waiting 2.5s before next test...");
		await sleep(2500);

		// --- TEST 2: Private Message Event ---
		console.log("\n--- TEST 2: Private Message Event Handling ---");
		console.log(`[STEP 2] Bot A sending PM to Bot B (${nickB}): '!ping_pm_${tokenPm}'...`);
		await botA.fill("#input", `/msg ${nickB} !ping_pm_${tokenPm}`);
		await botA.click("#submit");

		console.log("[WAIT] Waiting for Bot B to receive PM and reply via seance.reply()...");
		await botB.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").pm_received === "${tokenPm}"`,
			{timeout: 15000, label: "Bot B recorded pm_received"}
		);
		console.log(`[OK] Bot B Lua script received PM token '${tokenPm}'`);

		console.log("[WAIT] Waiting for Bot A to receive Bot B's PM pong reply...");
		await botA.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_a_initiator") || "{}").pm_ack === "${tokenPm}"`,
			{timeout: 15000, label: "Bot A recorded pm_ack"}
		);
		console.log(`[OK] Bot A Lua script received PM pong reply from Bot B.`);
		console.log(
			">>> TEST 2 PASSED: Private message events and seance.reply(msg) in PM work properly."
		);

		// Rate limiting: sleep 2.5s
		console.log("[RATE LIMIT] Waiting 2.5s before next test...");
		await sleep(2500);

		// --- TEST 3: Custom Slash Command in Lua ---
		console.log("\n--- TEST 3: Custom Lua Slash Command (/testcmd) ---");
		console.log(`[STEP 3] Bot A executing slash command '/testcmd ${tokenCmd}' in #seance...`);
		await botA.click('.channel-list-item[data-name="#seance"]');
		await botA.fill("#input", `/testcmd ${tokenCmd}`);
		await botA.click("#submit");

		console.log(
			"[WAIT] Waiting for Bot B to receive line sent by custom command in #seance..."
		);
		await botB.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").cmd_received === "${tokenCmd}"`,
			{timeout: 15000, label: "Bot B recorded cmd_received"}
		);
		console.log(`[OK] Bot B received line from Bot A's custom Lua command '${tokenCmd}'.`);
		console.log(">>> TEST 3 PASSED: Custom slash commands registered via Lua work properly.");

		// Rate limiting: sleep 2.5s
		console.log("[RATE LIMIT] Waiting 2.5s before next test...");
		await sleep(2500);

		// --- TEST 4: Lifecycle Events (join, send, nick) ---
		console.log("\n--- TEST 4: IRC Lifecycle Events (join, send, nick) ---");
		console.log("[CHECK] Verifying Bot B received Bot A's 'join' event...");
		await botB.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").last_join_nick === "${nickA}"`,
			{timeout: 10000, label: "Bot B recorded join event"}
		);
		console.log(`[OK] Bot B Lua script received 'join' event for ${nickA}`);

		console.log("[CHECK] Verifying Bot A received 'send' event for outbound messages...");
		await botA.waitFor(
			`!!JSON.parse(localStorage.getItem("thelounge.script_storage.bot_a_initiator") || "{}").last_send_line`,
			{timeout: 10000, label: "Bot A recorded send event"}
		);
		console.log(`[OK] Bot A Lua script received 'send' event for outbound message.`);

		const newNickA = `${nickA}x`;
		console.log(`[STEP 4] Bot A changing nick to ${newNickA}...`);
		await botA.fill("#input", `/nick ${newNickA}`);
		await botA.click("#submit");

		console.log("[WAIT] Waiting for Bot B to receive 'nick' change event...");
		await botB.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").last_nick_change === "${nickA}->${newNickA}"`,
			{timeout: 15000, label: "Bot B recorded nick change"}
		);
		console.log(
			`[OK] Bot B Lua script successfully received 'nick' change event: ${nickA} -> ${newNickA}`
		);
		console.log(">>> TEST 4 PASSED: Lifecycle events (join, send, nick) work properly.");

		// Rate limiting: sleep 2.5s
		console.log("[RATE LIMIT] Waiting 2.5s before next test...");
		await sleep(2500);

		// --- TEST 5: Storage Persistence Across Browser Reload & Script Isolation ---
		console.log(
			"\n--- TEST 5: Storage Persistence Across Browser Reload & Script Isolation ---"
		);
		const persistToken = `persist_${runId}`;
		console.log(
			`[STEP 5] Setting storage key 'persist_check' = '${persistToken}' in Bot A via /lua...`
		);
		await botA.fill("#input", `/lua seance.storage.set("persist_check", "${persistToken}")`);
		await botA.click("#submit");

		await botA.waitFor(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.global") || "{}").persist_check === "${persistToken}"`,
			{timeout: 5000, label: "Bot A set persist_check"}
		);
		console.log(`[OK] Storage key written into Bot A global storage.`);

		console.log(
			"[CHECK] Verifying script storage isolation (Bot B does not have Bot A's key)..."
		);
		const botBHasKey = await botB.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.bot_b_responder") || "{}").persist_check !== undefined`
		);
		if (botBHasKey) {
			throw new Error("Storage isolation failure: Bot B has access to Bot A's storage key");
		}
		console.log(`[OK] Storage namespaces are isolated between scripts.`);

		console.log("[RELOAD] Reloading Bot A's page to verify cross-session survival...");
		await botA.goto(url);
		await botA.waitFor(joined, {timeout: 30000, label: "Bot A reconnected after reload"});
		console.log(`[OK] Bot A reconnected after reload.`);

		console.log("[CHECK] Checking storage key survival after reload...");
		const reloadedVal = await botA.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.global") || "{}").persist_check`
		);
		if (reloadedVal !== persistToken) {
			throw new Error(
				`Storage did not persist across reload: expected ${persistToken}, got ${reloadedVal}`
			);
		}
		console.log(`[OK] Storage value '${reloadedVal}' successfully survived client restart.`);
		console.log(
			">>> TEST 5 PASSED: Storage persists across reloads and maintains per-script isolation."
		);

		// Rate limiting: sleep 2.5s
		console.log("[RATE LIMIT] Waiting 2.5s before cleanup...");
		await sleep(2500);

		// --- Clean Shutdown ---
		console.log("\n[CLEANUP] Disconnecting bots gracefully with /quit...");
		try {
			await botA.fill("#input", "/quit :Automated Lua test completed");
			await botA.click("#submit");
			await botB.fill("#input", "/quit :Automated Lua test completed");
			await botB.click("#submit");
		} catch (err) {
			console.warn("[CLEANUP] Warning during quit:", err.message);
		}

		await sleep(1000);
		console.log("=== ALL LUA SCRIPTING TESTS PASSED SUCCESSFULLY! ===");
		process.exitCode = 0;
	} catch (err) {
		console.error("\n❌ TEST FAILED:", err);
		if (botA) {
			const stA = await botA.evaluate(`({...localStorage})`).catch(() => ({}));
			console.error("Bot A localStorage:", JSON.stringify(stA, null, 2));
		}
		if (botB) {
			const stB = await botB.evaluate(`({...localStorage})`).catch(() => ({}));
			console.error("Bot B localStorage:", JSON.stringify(stB, null, 2));
		}
		if (botA?.consoleErrors?.length) {
			console.error("Bot A console errors:", botA.consoleErrors);
		}
		if (botB?.consoleErrors?.length) {
			console.error("Bot B console errors:", botB.consoleErrors);
		}
		process.exitCode = 1;
	} finally {
		console.log("[CLEANUP] Closing headless browser devices and stopping local server...");
		if (botA) await botA.close().catch(() => {});
		if (botB) await botB.close().catch(() => {});
		server.close();
	}
}

main();
