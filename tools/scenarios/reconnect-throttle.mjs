// Never dial into the server's connection throttle (irc/dialLedger.ts): with
// this device's recent dials on record, a connect waits out the gap — and
// says so — instead of dialling into a refusal that would renew the server's
// window.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reconnect-throttle.mjs
//   (also --mobile --width=390 --height=844)
//
// The dev ircd's own throttle is relaxed (100 / 1 s / 1 s), so nothing here
// is refused by the server: what is checked is the client's ledger. The
// page's WebSocket constructor is wrapped to count dials. After /disconnect,
// three dials are written into `thelounge.state.dials` as if the app had
// been reopened three times in quick succession; then:
//  - the strip's Connect waits, with the throttle wording and a countdown;
//  - "Connect now" during the wait waits too, and no socket is opened;
//  - when the countdown ends, exactly one dial goes out and the network
//    registers;
//  - with the record cleared, Connect dials at once.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const KEY = "thelounge.state.dials";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=thr${RUN}&join=%23seance`;

const COUNT_DIALS = `(() => {
	const Real = window.WebSocket;
	window.__dials = 0;
	function Counted(...args) {
		window.__dials++;
		return new Real(...args);
	}
	Counted.prototype = Real.prototype;
	for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Counted[k] = Real[k];
	window.WebSocket = Counted;
})()`;

const LABEL = `document.querySelector(".connection-bar-label")?.textContent ?? ""`;
const BAR_GONE = `!document.querySelector(".connection-bar")`;

async function disconnect(page) {
	await page.fill("#input", "/disconnect");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`(${LABEL}).startsWith("Disconnected from")`, {
		timeout: 10000,
		label: "the network disconnected",
	});
}

export default async function run(page) {
	await page.addInitScript(COUNT_DIALS);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click('.channel-list-item[data-name="#seance"]');
	await page.waitFor(`document.querySelector("#input")`, {label: "the input"});
	await page.sleep(1500);

	await disconnect(page);
	await page.evaluate(
		`localStorage.setItem(${JSON.stringify(
			KEY
		)}, JSON.stringify({localhost: {d: [Date.now() - 30000, Date.now() - 25000, Date.now() - 20000], c: []}}))`
	);
	const before = await page.evaluate("window.__dials");

	await page.click(".connection-bar-connect");
	await page.sleep(700);
	const label = await page.evaluate(LABEL);
	const seconds = Number((label.match(/ in (\d+)s/) ?? [])[1]);
	await page.check(
		`Connect waits, saying why ("${label}")`,
		/the server limits quick reconnects/.test(label)
	);
	await page.check(`with a countdown (${seconds}s)`, seconds >= 15 && seconds <= 45);
	const cut = await page.evaluate(
		`(() => { const el = document.querySelector(".connection-bar-label"); return el.scrollWidth > el.clientWidth + 1; })()`
	);
	await page.check("the reason is not cut off (a phone wraps it)", !cut);
	await page.screenshot("1-throttled", {selector: "#form", pad: 30});

	await page.click(".connection-bar-connect");
	await page.sleep(3000);
	await page.check(
		"Connect now during the wait waits too",
		/the server limits/.test(await page.evaluate(LABEL))
	);
	await page.check(
		"no socket was opened during the wait",
		(await page.evaluate("window.__dials")) === before
	);

	await page.waitFor(BAR_GONE, {timeout: 60000, label: "registered after the wait"});
	await page.check(
		`exactly one dial went out after the wait (${
			(await page.evaluate("window.__dials")) - before
		})`,
		(await page.evaluate("window.__dials")) === before + 1
	);

	await page.sleep(1000);
	await disconnect(page);
	await page.evaluate(`localStorage.removeItem(${JSON.stringify(KEY)})`);
	const again = await page.evaluate("window.__dials");
	await page.click(".connection-bar-connect");
	await page.sleep(300);
	await page.check(
		"with no dials on record, Connect dials at once",
		(await page.evaluate("window.__dials")) === again + 1 &&
			!/the server limits/.test(await page.evaluate(LABEL))
	);
	await page.waitFor(BAR_GONE, {timeout: 15000, label: "registered at once"});

	await page.check("no console errors", page.consoleErrors.length === 0);
}
