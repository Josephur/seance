// Away with TWO devices on one account, as other users and the server see it
// (docs/projects/do-not-disturb.md). Device A is browser-drive's page; device
// B is a second Chromium with a profile of its own (lib/device.mjs), so its
// storage, IndexedDB and service worker are its own, as a phone's are beside
// a desktop's. An observer with away-notify in #seance records every AWAY
// about the account's nick and asks WHOIS (301) and WHO (H/G) after each step.
//
// nefarious2 aggregates the account's connections
// (bounce_compute_effective_away): one present connection makes the account
// present, `AWAY *` connections do not count, and a human away message wins
// over stars.
//
// Needs the testnet rig (SASL, draft/persistence, draft/pre-away,
// draft/metadata-2, draft/webpush) and an account of its own:
//
//   CHROME_BIN=/seance/tmp/chrome-pw.sh SEANCE_SASL_ACCOUNT=idleuser \
//     SEANCE_SASL_PASSWORD=idlepass node tools/browser-drive.mjs \
//     tools/scenarios/away-two-devices.mjs --no-ws
//
// Both devices fake the Push API (lib/fake-push.mjs) with notifications
// granted, so each subscribes without a prompt and its worker stashes the
// login it needs to say a closed page's AWAY *.

import {observe} from "./lib/irc-observer.mjs";
import {FAKE_PUSH_API} from "./lib/fake-push.mjs";
import {startDevice} from "./lib/device.mjs";

const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PASSWORD = process.env.SEANCE_SASL_PASSWORD;
const RUN = Date.now().toString(36);
const BASE = process.env.SEANCE_URL ?? "http://localhost:8001/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const IRCD_PORT = Number(new URL(IRCD).port || 8067);
const SETTLE = 1500; // a line's round trip through the server, generously

const linkFor = (nick) =>
	`${BASE}?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${nick}&join=%23seance&saslAccount=${encodeURIComponent(
		ACCOUNT ?? ""
	)}&saslPassword=${encodeURIComponent(PASSWORD ?? "")}`;

export const url = linkFor(`twa${RUN.slice(-6)}`);

const LOBBY = '.channel-list-item[data-type="lobby"]';
const PILL = "#sidebar .presence-pill";
const DOT = `${LOBBY} .lobby-presence .presence-dot`;
const MENU_ITEM = (cls) => `#context-menu .context-menu-${cls}`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;
const OUR_NICK = `document.querySelector('${LOBBY} .lobby-nick')?.textContent.replace(/^\\s*Nickname:\\s*/, "").trim()`;

const PUSH_API = `if (typeof ServiceWorkerRegistration !== "undefined") ${FAKE_PUSH_API}`;
// Navigating away puts a page in the back/forward cache (a hide); an unload
// listener makes Chromium unload it for real, as closing the tab does.
const CLOSE_FOR_REAL = `addEventListener("unload", () => {})`;
const STASHED_LOGIN = `(async () => {
	if (!navigator.serviceWorker.controller) return false;
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("seance-push", 1);
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const stash = await new Promise((res) => {
		const g = db.transaction("kv").objectStore("kv").get("stash");
		g.onsuccess = () => res(g.result);
		g.onerror = () => res(undefined);
	});
	db.close();
	return (stash?.networks ?? []).some((n) => n.saslPassword);
})()`;

const HIDE = `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "hidden"});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
	window.dispatchEvent(new Event("blur"));
	document.dispatchEvent(new Event("visibilitychange"));
})()`;
const SHOW = `(() => {
	delete document.visibilityState;
	delete document.hidden;
	document.dispatchEvent(new Event("visibilitychange"));
	window.dispatchEvent(new Event("focus"));
})()`;

export default async function run(page) {
	if (!ACCOUNT || !PASSWORD) {
		throw new Error("set SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD (an account of its own)");
	}

	const origin = new URL(BASE).origin;
	const b = await startDevice({name: "B"});

	const command = async (dev, text) => {
		await dev.fill("#input", text);
		await dev.click("#submit");
	};
	const menu = async (dev, opener, cls) => {
		await dev.click(opener);
		await dev.waitFor(`!!document.querySelector('${MENU_ITEM(cls)}')`, {label: `menu ${cls}`});
		await dev.click(MENU_ITEM(cls));
		await dev.sleep(200);
	};
	const pillText = (dev) => dev.evaluate(`document.querySelector('${PILL}')?.textContent.trim()`);
	const dotIsDnd = (dev) =>
		dev.evaluate(`!!document.querySelector('${DOT}')?.classList.contains("is-dnd")`);

	// Log in from the connect form, remembering the password (so the worker
	// can stash it) and autoconnecting (so a reopen comes back by itself).
	const login = async (dev, link) => {
		await dev.addInitScript(PUSH_API);
		await dev.grantPermissions(["notifications"], origin);
		await dev.goto(link, {waitForSelector: "#connect form"});
		await dev.fill('#connect input[name="saslPassword"]', PASSWORD);

		for (const name of ["rememberPassword", "autoconnect"]) {
			if (
				!(await dev.evaluate(
					`document.querySelector('#connect input[name="${name}"]').checked`
				))
			) {
				await dev.click(`#connect input[name="${name}"]`);
			}
		}

		await dev.click('#connect button[type="submit"]');
		await dev.waitFor(joined("#seance"), {timeout: 25000, label: `${dev.name ?? "A"}: joined`});
		await dev.waitFor(STASHED_LOGIN, {
			timeout: 20000,
			label: "the worker's stash holds the login",
		});
	};
	const close = async (dev) => {
		await dev.evaluate(CLOSE_FOR_REAL);
		await dev.goto("about:blank");
	};
	const reopen = async (dev) => {
		await dev.goto(BASE, {waitForSelector: "#chat-container"});
		await dev.waitFor(joined("#seance"), {timeout: 25000, label: "session restored"});
		await dev.evaluate(SHOW);
	};

	let obs;

	try {
		await login(page, page.url);
		const me = await page.evaluate(OUR_NICK);
		page.check(`A logged in as ${me}, its worker holds the login`, !!me);

		obs = await observe(IRCD, `tob${RUN.slice(-6)}`, {
			caps: ["away-notify", "draft/metadata-2"],
			join: "#seance",
		});
		const state = async (label) => {
			const w = await obs.whois(me);
			const flag = await obs.who(me);
			console.log(`  ${label}: WHO ${flag}, WHOIS away=${JSON.stringify(w.away)}`);
			return {flag, away: w.away};
		};
		const step = async (label, action, wait = SETTLE) => {
			const t = Date.now();
			await action();
			await page.sleep(wait);
			const lines = obs.awaysSince(me, t);
			return {lines, ...(await state(label))};
		};

		// Clean start: wait out the account's mute read, then Off and /back.
		await page.sleep(11000);
		await menu(page, PILL, "dnd-off");
		await command(page, "/back");
		await page.evaluate(SHOW);

		await login(b, linkFor(`twb${RUN.slice(-6)}`));
		const bNick = await b.evaluate(OUR_NICK);
		page.check(`B logged in to the same session (${bNick})`, bNick === me);
		await b.evaluate(SHOW);
		await page.sleep(11000); // B's own read of the mute list
		await page.sleep(SETTLE);
		let s = await state("start, A and B present");
		page.check(
			`start: present to others (${s.flag}, ${JSON.stringify(s.away)})`,
			s.flag === "H" && s.away === null
		);

		// --- 1. Both present; A closes. -------------------------------------
		let r = await step("A closed, B present", () => close(page), 8000);
		page.check(
			`1. A closed while B is present: the account stays present, no AWAY line (${
				r.flag
			}, ${JSON.stringify(r.lines)})`,
			r.lines.length === 0 && r.flag === "H" && r.away === null
		);

		// --- 2. A back, /away lunch; B present outranks it. ---------------
		await reopen(page);
		await page.sleep(SETTLE);
		r = await step("A /away lunch, B present", () => command(page, "/away lunch"));
		page.check(
			`2. A /away lunch, B present: the account present to others (${
				r.flag
			}, ${JSON.stringify(r.away)}, ${JSON.stringify(r.lines)})`,
			r.flag === "H" && r.away === null
		);

		// --- 3. B hidden: A's message wins over B's star; B back: present. --
		r = await step("B hidden", () => b.evaluate(HIDE));
		page.check(
			`3. B hidden: the account away with "lunch" (${r.flag}, ${JSON.stringify(
				r.away
			)}, ${JSON.stringify(r.lines)})`,
			r.flag === "G" && r.away === "lunch" && r.lines.some((l) => l.endsWith(":lunch"))
		);
		r = await step("B shown", () => b.evaluate(SHOW));
		page.check(
			`3. B shown again: the account present (${r.flag}, ${JSON.stringify(r.lines)})`,
			r.flag === "H" && r.away === null && r.lines.some((l) => /AWAY\s*$/.test(l))
		);
		// A's /away would keep A away through case 4's Off; take it back.
		r = await step("A /back", () => command(page, "/back"));
		page.check(`A /back: present (${r.flag})`, r.flag === "H");

		// --- 4. DND on A reaches B; Off on B reaches A. --------------------
		const t4 = Date.now();
		r = await step("DND on A", () => menu(page, PILL, "dnd-indefinite"));
		let bDnd = false;

		for (let waited = 0; waited < 15000 && !bDnd; waited += 250) {
			bDnd = /Do not disturb/i.test((await pillText(b)) ?? "") && (await dotIsDnd(b));
			await page.sleep(250);
		}

		await page.sleep(SETTLE);
		s = await state("DND on A, read by B");
		const dndLines = obs.awaysSince(me, t4);
		page.check(`4. B's pill and network show "Do not disturb" (${await pillText(b)})`, bDnd);
		page.check(
			`4. B silences its notifications (its network's presence says dnd)`,
			await dotIsDnd(b)
		);
		page.check(
			`4. the account away to others (${s.flag}, ${JSON.stringify(s.away)}, ${JSON.stringify(
				dndLines
			)})`,
			s.flag === "G" && s.away !== null
		);
		r = await step("Off on B", () => menu(b, PILL, "dnd-off"), 3000);
		const aOff =
			!/Do not disturb/i.test((await pillText(page)) ?? "") && !(await dotIsDnd(page));
		page.check(`4. Off on B turns A's DND off (A's pill ${await pillText(page)})`, aOff);
		page.check(
			`4. both present, the account present (${r.flag}, ${JSON.stringify(r.lines)})`,
			r.flag === "H" && r.away === null && !(await dotIsDnd(b))
		);

		// --- 5. A reloads while B is present. -------------------------------
		r = await step(
			"A reloaded, B present",
			async () => {
				await page.send("Page.reload");
				await page.waitFor(joined("#seance"), {timeout: 25000, label: "A reloaded"});
				await page.evaluate(SHOW);
			},
			8000
		);
		page.check(
			`5. A reloads while B is present: no AWAY line at all (${r.flag}, ${JSON.stringify(
				r.lines
			)})`,
			r.lines.length === 0 && r.flag === "H"
		);

		// --- 6. Both close: one away, from the workers, while held. --------
		const t6 = Date.now();
		await close(b);
		await close(page);

		for (let waited = 0; waited < 9000 && obs.awaysSince(me, t6).length === 0; waited += 250) {
			await page.sleep(250);
		}

		const after6 = Date.now() - t6;
		await page.sleep(6000); // the other worker's star must change nothing
		let lines = obs.awaysSince(me, t6);
		s = await state("A and B closed");
		page.check(
			`6. both closed: exactly one away within ~8 s (${after6} ms, ${JSON.stringify(lines)})`,
			lines.length === 1 && / AWAY :\S/.test(lines[0]) && after6 < 9000
		);
		page.check(
			`6. held: WHO G and a 301 (${s.flag}, ${JSON.stringify(s.away)})`,
			s.flag === "G" && s.away !== null
		);

		// --- 7. A alone reopens. ---------------------------------------------
		const t7 = Date.now();
		await reopen(page);
		await page.sleep(4000);
		lines = obs.awaysSince(me, t7);
		s = await state("A reopened alone");
		page.check(
			`7. A reopened alone: present (${s.flag}, ${JSON.stringify(lines)})`,
			s.flag === "H" && s.away === null
		);
	} finally {
		await b.close();

		try {
			if (await page.evaluate(joined("#seance"))) {
				await command(page, "/back");
				await page.sleep(500);
			}
		} catch {
			// A is not on the app
		}

		obs?.close();
	}

	page.check(
		`no console errors (A ${page.consoleErrors.length}, B ${b.consoleErrors.length})`,
		page.consoleErrors.length === 0 && b.consoleErrors.length === 0
	);
}
