// The oper tools end to end (docs/projects/oper-tools.md) against the dev
// ircd's oper block: opering up shows the shield in the network header;
// `/stats p` and `/check` come back as cards; an important server notice
// (another oper coming up) shows in the channel being looked at while a
// routine one (a client connecting) stays in the network window without
// unread; the oper panel's three tabs — Opers (the helper's oper-up rolled
// up by oper and by kind), Alerts (the plain-words lines, the raw mask
// folded away still switching CONNEXIT) and Me (the status line, the
// privileges); the badge on a notice opens the route menu and the Alerts
// tab shows the change; a G-line and a KILL from a nick's menu work and say
// so; and the notices come back after a reload (IndexedDB).
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d      # local.conf grants the ban privileges
//   node tools/browser-drive.mjs tools/scenarios/oper-tools.mjs
//   node tools/browser-drive.mjs tools/scenarios/oper-tools.mjs --mobile --width=390 --height=844
//
// `SEANCE_PORT` points it at another port when 8000 is taken.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const MOBILE = process.argv.includes("--mobile");
const ME = "operwatch";
const PORT = process.env.SEANCE_PORT ?? "8000";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=${ME}&join=%23seance`;

/** A helper client on the dev ircd: joins the channel, runs `onReady`. */
function helper(nick, onReady = () => {}) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let ready = () => {};
	let gone = () => {};
	const send = (line) => ws.readyState === 1 && ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :Oper scenario ${nick}`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].startsWith(`:${nick}!`)) {
			onReady(send);
			ready();
		}
	};

	ws.onclose = () => gone();

	return {
		send,
		ready: new Promise((resolve, reject) => {
			ready = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		closed: new Promise((resolve) => (gone = resolve)),
		quit: () => send("QUIT :done"),
	};
}

/** Remove the scenario's G-line on a raw oper connection (also before a run, after a crash). */
async function cleanup() {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	await new Promise((resolve) => {
		ws.onopen = () => {
			ws.send("NICK opclean");
			ws.send("USER opclean 0 * :cleanup");
		};
		ws.onmessage = (ev) => {
			const line = String(ev.data);
			if (line.startsWith("PING")) {
				ws.send(`PONG${line.slice(4)}`);
			} else if (/ 001 /.test(line)) {
				ws.send("OPER seanceop seance");
			} else if (/ 381 /.test(line)) {
				ws.send("REMOVE gline opvictim@172.17.0.1 :oper-tools scenario cleanup");
				ws.send("QUIT :done");
			}
		};
		ws.onclose = resolve;
		setTimeout(resolve, 10000);
	});
}

async function type(page, text) {
	await page.fill("#input", text);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
}

/** The user list is a side panel on a desktop and an overlay on a phone. */
async function openUserList(page) {
	if (
		!(await page.evaluate(
			`!!document.querySelector(".userlist") && document.querySelector(".userlist").offsetParent !== null`
		))
	) {
		await page.click("#chat .header .rt");
		await page.sleep(400);
	}
}

const msgs = (type) => `Array.from(document.querySelectorAll("#chat .msg[data-type='${type}']"))`;

export default async function run(page) {
	await cleanup();
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		label: "the channel row",
		timeout: 20000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500);

	const shield = `.channel-list-item[data-type="lobby"] .oper-panel`;
	page.check(
		"no shield before opering",
		(await page.evaluate(`document.querySelectorAll('${shield}').length`)) === 0
	);

	// ---------------------------------------------------------------- oper up
	await type(page, "/oper seanceop seance");
	await page.waitFor(`!!document.querySelector('${shield}')`, {
		label: "the shield",
		timeout: 15000,
	});
	await page.sleep(1500); // PRIVS, the snomask, the features
	if (!MOBILE) {
		await page.screenshot("1-sidebar-shield", {selector: "#sidebar"});
	}

	// ------------------------------------------------------------ /stats p
	await type(page, "/stats p");
	await page.waitFor(`${msgs("report")}.some((m) => m.querySelector(".oper-report-table"))`, {
		label: "the ports table",
		timeout: 15000,
	});
	const ports = await page.evaluate(`(() => {
		const report = ${msgs("report")}.at(-1);
		return {
			title: report.querySelector(".oper-report-title")?.textContent.trim(),
			heads: Array.from(report.querySelectorAll("th")).map((th) => th.textContent.trim()),
			rows: report.querySelectorAll("tbody tr").length,
			chips: Array.from(report.querySelectorAll(".oper-chip-static")).map((c) => c.textContent.trim()),
		};
	})()`);
	page.check(`/stats p: titled "${ports.title}"`, /port/i.test(ports.title ?? ""));
	page.check(`/stats p: a row per listener (${ports.rows})`, ports.rows >= 5);
	page.check(
		`/stats p: WebSocket flagged (${ports.chips.join(",")})`,
		ports.chips.some((c) => /websocket/i.test(c))
	);
	page.check(
		"no raw [217] lines in the channel",
		(await page.evaluate(
			`${msgs("unhandled")}.filter((m) => m.textContent.includes("217")).length`
		)) === 0
	);
	await page.screenshot("2-stats-p", {selector: "#chat"});

	// ------------------------------------------------------------- /check
	const victim = helper("opvictim");
	await victim.ready;
	await page.sleep(800);
	await type(page, "/check opvictim");
	await page.waitFor(
		`${msgs(
			"report"
		)}.some((m) => m.querySelector(".oper-report-title")?.textContent.includes("opvictim"))`,
		{
			label: "the CHECK card",
			timeout: 15000,
		}
	);
	const card = await page.evaluate(`(() => {
		const report = ${msgs("report")}.at(-1);
		return {
			sections: Array.from(report.querySelectorAll(".oper-report-section-title")).map((h) => h.textContent.trim()),
			ip: report.querySelector(".oper-chip-ip")?.textContent.trim(),
		};
	})()`);
	page.check(
		`/check: Identity and Connection sections (${card.sections.join(", ")})`,
		card.sections.includes("Identity") && card.sections.includes("Connection")
	);
	page.check(
		`/check: the real IP is a chip (${card.ip})`,
		/^\d+\.\d+\.\d+\.\d+$/.test(card.ip ?? "")
	);
	await page.screenshot("3-check-user", {selector: "#chat"});

	await type(page, `/check ${CHANNEL}`);
	await page.waitFor(
		`${msgs(
			"report"
		)}.some((m) => m.querySelector(".oper-report-title")?.textContent.includes("${CHANNEL}"))`,
		{
			label: "the channel CHECK card",
			timeout: 15000,
		}
	);
	const members = await page.evaluate(
		`${msgs("report")}.at(-1).querySelectorAll("tbody tr").length`
	);
	page.check(`/check #seance: a member row each (${members})`, members >= 2);

	// ------------------------------------------- an important notice: active
	const lobbyBadge = `document.querySelector('.channel-list-item[data-type="lobby"] .badge')?.textContent.trim() ?? ""`;
	const badgeBefore = await page.evaluate(lobbyBadge);
	const friend = helper("opfriend", (send) => send("OPER seanceop seance"));
	await friend.ready;
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opfriend"))`, {
		label: "the oper-up notice in the channel",
		timeout: 15000,
	});
	const oper = await page.evaluate(`(() => {
		const m = ${msgs("snotice")}.find((el) => el.textContent.includes("opfriend"));
		return {badge: m.querySelector(".snotice-badge")?.textContent.trim(), text: m.querySelector(".snotice-text")?.textContent.trim()};
	})()`);
	page.check(
		`the oper-up notice reads in plain words: "${oper.text}"`,
		/opfriend .* is now a global operator/.test(oper.text ?? "")
	);
	await page.screenshot("4-active-notice", {selector: "#chat"});
	friend.quit();

	// ----------------------------------------------------- the oper panel
	const openPanel = async () => {
		await page.click(MOBILE ? `#viewport .lt` : shield);
		if (MOBILE) {
			await page.sleep(400);
			await page.click(shield);
		}
		await page.waitFor(`!!document.querySelector("#oper .oper-activity")`, {
			label: "the oper panel, on Opers",
			timeout: 10000,
		});
		await page.sleep(500);
	};
	const closePanel = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(`document.querySelector("#input") && !document.querySelector("#oper")`, {
			label: "back in the channel",
		});
	};

	// Opers: the helper's oper-up is a row by oper, and "Opers coming up" by kind.
	await openPanel();
	const operRow = `Array.from(document.querySelectorAll(".oper-activity .oper-rollup-row")).find((li) => li.querySelector('.oper-row-name .user[data-name="opfriend"]'))`;
	await page.waitFor(`!!${operRow}`, {label: "the oper-up row for opfriend", timeout: 10000});
	const operRowText = await page.evaluate(
		`${operRow}.querySelector(".oper-row").textContent.replace(/\\s+/g, " ").trim()`
	);
	page.check(
		`by oper: "${operRowText}"`,
		/opfriend\s*\d+ actions?\s*\d\d:\d\d/.test(operRowText)
	);
	await page.evaluate(`${operRow}.querySelector(".oper-row").click()`);
	await page.waitFor(`!!${operRow}.querySelector(".oper-tier2 .oper-row")`, {
		label: "the row opens to its kinds",
	});
	const tier2 = await page.evaluate(
		`${operRow}.querySelector(".oper-tier2 .oper-row-name").textContent.trim()`
	);
	page.check(`tier 2 reads "${tier2}"`, /^1 Opers coming up$/.test(tier2));
	await page.evaluate(`${operRow}.querySelector(".oper-tier2 .oper-row").click()`);
	await page.waitFor(`!!${operRow}.querySelector(".oper-timeline button.snotice-badge")`, {
		label: "the notices themselves, with their badge",
	});
	await page.screenshot("5-panel-opers", {selector: ".oper-modal"});
	await page.click(`.oper-activity-view button:nth-child(2)`);
	await page.waitFor(
		`Array.from(document.querySelectorAll(".oper-activity .oper-row-name")).some((el) => el.textContent.trim() === "Opers coming up")`,
		{label: "the by-kind row"}
	);
	page.check(
		"the view switch is remembered",
		(await page.evaluate(`localStorage.getItem("thelounge.oper.activityView")`)) === "kind"
	);
	await page.click(`.oper-activity-view button:nth-child(1)`);

	// Alerts: the raw mask folded at the bottom still switches CONNEXIT (0x4000).
	await page.click(`.settings-menu button.oper-alerts`);
	await page.waitFor(`!!document.querySelector("#oper .oper-alerts .oper-line")`, {
		label: "the alert lines",
	});
	const lines = await page.evaluate(
		`Array.from(document.querySelectorAll(".oper-alerts-section .oper-line-label")).map((l) => l.textContent.trim())`
	);
	page.check(
		`the lines are in plain words (${lines.length})`,
		lines.includes("Bans added or removed") && lines.includes("Every connect and quit")
	);
	await page.screenshot("5b-panel-alerts", {selector: ".oper-modal"});
	await page.evaluate(`document.querySelector(".oper-raw").open = true`);
	await page.waitFor(`!!document.querySelector("#oper .oper-bits")`, {label: "the raw mask"});
	const readMask = `Number(document.querySelector(".oper-mask-readout code")?.textContent)`;
	const maskBefore = await page.evaluate(readMask);
	page.check(
		`the panel shows the server's mask (${maskBefore})`,
		Number.isInteger(maskBefore) && maskBefore > 0
	);
	const connexit = `document.querySelector('.oper-bit[data-bit="CONNEXIT"]')`;
	await page.evaluate(`${connexit}.querySelector("input").scrollIntoView({block: "center"})`);
	await page.sleep(200);
	await page.evaluate(`${connexit}.querySelector("input").click()`);
	await page.waitFor(
		`(${readMask} & 0x4000) !== 0 && !document.querySelector(".oper-mask-readout")?.textContent.includes("Applying")`,
		{
			label: "the mask with CONNEXIT, as the server reports it",
			timeout: 10000,
		}
	);
	page.check(
		"CONNEXIT is on in the mask the server reported",
		((await page.evaluate(readMask)) & 0x4000) !== 0
	);
	await page.screenshot("5c-panel-alerts-raw", {selector: ".oper-modal"});

	// Me: the status line, the privileges (folded when many), the modes grid.
	await page.click(`.settings-menu button.oper-me`);
	await page.waitFor(`!!document.querySelector(".oper-me .oper-privs")`, {
		label: "the privileges",
	});
	const privs = await page.evaluate(
		`Array.from(document.querySelectorAll(".oper-privs .oper-chip-static")).map((c) => c.textContent.trim())`
	);
	page.check(
		`the privileges are listed (${privs.length})`,
		privs.includes("GLINE") && privs.includes("CHECK")
	);
	const status = await page.evaluate(
		`document.querySelector(".oper-me-status").textContent.replace(/\\s+/g, " ").trim()`
	);
	page.check(
		`the status line: "${status}"`,
		/Global operator\s*·\s*\+\w+\s*·\s*nefarious2/.test(status)
	);
	await page.evaluate(`document.querySelector(".oper-me-privs").open = true`);
	await page.screenshot("6-panel-me", {selector: ".oper-modal"});
	await closePanel();

	// ------------------------------- the badge on a notice changes its route
	const operNotice = `${msgs("snotice")}.find((el) => el.textContent.includes("opfriend"))`;
	await page.evaluate(`${operNotice}.scrollIntoView({block: "center"})`);
	await page.sleep(200);
	await page.evaluate(`${operNotice}.querySelector("button.snotice-badge").click()`);
	await page.waitFor(
		`!!document.querySelector("#context-menu .context-menu-oper-route-network")`,
		{label: "the route menu from the badge"}
	);
	const menu = await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu li")).map((li) => li.textContent.trim()).filter(Boolean)`
	);
	page.check(
		`the menu names the kind and the choices (${menu.join(" | ")})`,
		menu[0] === "Opers coming up" &&
			menu.some((m) => /until I change it/.test(m)) &&
			menu.some((m) => /Stop receiving server events/.test(m))
	);
	await page.screenshot("6b-badge-menu");
	await page.click("#context-menu .context-menu-oper-route-network");
	await page.waitFor(`!document.querySelector("#context-menu")`, {label: "the menu closes"});
	await openPanel();
	await page.click(`.settings-menu button.oper-alerts`);
	const operUpPos = `document.querySelector('.oper-line[data-line="oper-up"] [role="radio"][aria-checked="true"]')?.textContent.trim()`;
	await page.waitFor(`${operUpPos} === "Network"`, {label: "the Alerts line on Network"});
	page.check(
		"Alerts shows 'Someone opers up' on Network after the badge menu",
		(await page.evaluate(operUpPos)) === "Network"
	);
	// Back to Here for good, through the control's own menu.
	await page.evaluate(
		`document.querySelector('.oper-line[data-line="oper-up"] [role="radio"]').click()`
	);
	await page.waitFor(
		`!!document.querySelector("#context-menu .context-menu-oper-route-active")`,
		{label: "Here asks how long"}
	);
	await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu .context-menu-oper-route-active")).find((li) => /until I change it/.test(li.textContent)).click()`
	);
	await page.waitFor(`${operUpPos} === "Here"`, {label: "the line back on Here"});
	await closePanel();

	// --------------------------------------- a routine notice: network window
	const routine = helper("opdrive");
	await routine.ready;
	await page.sleep(1500);
	page.check(
		"the connect notice did not come to the channel",
		(await page.evaluate(
			`${msgs("snotice")}.filter((m) => m.textContent.includes("opdrive")).length`
		)) === 0
	);
	page.check(
		`the lobby's unread did not move (${badgeBefore})`,
		(await page.evaluate(lobbyBadge)) === badgeBefore
	);
	routine.quit();

	// ------------------------------------------ G-line from a nick's menu
	await openUserList(page);
	await page.click(`.userlist .user[data-name="opvictim"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-gline")`, {
		label: "the oper entries in the nick menu",
	});
	await page.screenshot("7-nick-menu");
	await page.click("#context-menu .context-menu-oper-gline");
	await page.waitFor(
		`!!document.querySelector("#oper-action-dialog .oper-action-suggestions .oper-chip")`,
		{
			label: "mask suggestions from USERIP/USERHOST",
			timeout: 10000,
		}
	);
	// The ident@IP mask: `*@<ip>` would ban every client of the dev rig.
	await page.evaluate(
		`Array.from(document.querySelectorAll("#oper-action-dialog .oper-action-suggestions .oper-chip")).find((b) => b.textContent.trim().startsWith("opvictim@")).click()`
	);
	await page.waitFor(
		`/Matches 1 user: opvictim/.test(document.querySelector("#oper-action-dialog .oper-action-preview")?.textContent ?? "")`,
		{
			label: "the preview names the one user it hits",
			timeout: 10000,
		}
	);
	await page.fill("#oper-action-reason", "oper-tools scenario");
	await page.screenshot("8-gline-dialog", {selector: "#oper-action-dialog"});
	await page.click(`#oper-action-dialog button[type="submit"]`);
	await page.waitFor(
		`/G-line set/.test(document.querySelector("#oper-action-dialog .oper-action-result")?.textContent ?? "")`,
		{
			label: "the G-line confirmed by listing it back",
			timeout: 15000,
		}
	);
	await victim.closed;
	page.check("the G-lined user was disconnected", true);
	await page.waitFor(`!document.querySelector("#oper-action-dialog")`, {
		label: "the dialog closes",
		timeout: 5000,
	});
	await cleanup();

	// -------------------------------------------------- KILL from the menu
	const target = helper("opkillme");
	await target.ready;
	await openUserList(page);
	await page.waitFor(`!!document.querySelector('.userlist .user[data-name="opkillme"]')`, {
		label: "opkillme in the user list",
	});
	await page.click(`.userlist .user[data-name="opkillme"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-kill")`, {
		label: "the kill entry",
	});
	await page.click("#context-menu .context-menu-oper-kill");
	await page.waitFor(`!!document.querySelector("#oper-action-reason")`, {
		label: "the kill dialog",
	});
	await page.fill("#oper-action-reason", "oper-tools scenario");
	await page.click(`#oper-action-dialog button[type="submit"]`);
	await page.waitFor(
		`/Killed opkillme/.test(document.querySelector("#oper-action-dialog .oper-action-result")?.textContent ?? "")`,
		{
			label: "the kill reported",
			timeout: 10000,
		}
	);
	await target.closed;
	page.check("the killed user was disconnected", true);
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opkillme"))`, {
		label: "the kill notice in the channel",
		timeout: 10000,
	});

	// ------------------------------------------ notices survive a reload
	await page.sleep(1500); // the notice log writes a second after the last line
	await page.goto(page.url, {waitForSelector: "#app"});
	await page.waitFor(`document.querySelector('.channel-list-item[data-type="lobby"]')`, {
		label: "the network after the reload",
		timeout: 20000,
	});
	// The reload lands on the last conversation first (helpers/lastChannel.ts).
	await page.waitFor(
		`!!document.querySelector('.channel-list-item[data-name="${CHANNEL}"].active')`,
		{
			label: "the landing on the channel",
			timeout: 20000,
		}
	);
	await page.sleep(500);
	if (MOBILE) {
		await page.click("#viewport .lt");
		await page.sleep(400);
	}
	await page.click(`.channel-list-item[data-type="lobby"] .name`);
	await page.waitFor(`!!document.querySelector('.channel-list-item[data-type="lobby"].active')`, {
		label: "the lobby open",
	});
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opkillme"))`, {
		label: "the kept notices back in the lobby",
		timeout: 15000,
	});
	await page.screenshot("9-lobby-after-reload", {selector: "#chat"});

	page.check(
		`no console errors (${page.consoleErrors.join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
