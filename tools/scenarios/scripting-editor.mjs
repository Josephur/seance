// Settings → Scripts, no IRC needed: the tab holds the Enable scripting
// switch and, while it is on, the library; a script opens in the editor at
// /settings/scripts/<id> (a page of the tab, as a network's edit form is of
// Networks). There is no scripting icon in the sidebar footer, and the
// Fengari chunk is fetched only once an enabled script exists.
//
//   corepack yarn build && python3 -m http.server -d public 8022 &
//   node tools/browser-drive.mjs tools/scenarios/scripting-editor.mjs
//   (also --mobile --width=390 --height=844)

const BASE = `http://localhost:${process.env.SEANCE_PORT ?? 8022}/`;
export const url = BASE;

const FENGARI_RESOURCES = `performance.getEntriesByType("resource").filter((e) => e.name.includes("fengari")).length`;
const STORED = `JSON.parse(localStorage.getItem("thelounge.scripts") || "[]")`;

async function key(page, code, modifiers = 0) {
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: code,
			code,
			windowsVirtualKeyCode: code === "Tab" ? 9 : 0,
			modifiers,
		});
	}

	await page.sleep(50);
}

export default async function run(page) {
	await page.goto(BASE, {waitForSelector: "#footer button.settings"});

	page.check("no scripting icon in the footer", (await page.count("#footer .scripts")) === 0);
	page.check("fengari not loaded while disabled", (await page.evaluate(FENGARI_RESOURCES)) === 0);

	// The tab is there with scripting off, and holds only the switch. (By
	// URL: on the phone layout the sidebar, and its cog, start closed.)
	await page.evaluate(`location.hash = "#/settings"`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.scripts")`, {
		label: "Scripts tab",
	});
	await page.click(".settings-menu button.scripts");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "Scripts tab open",
	});
	page.check(
		"the URL is /settings/scripts",
		(await page.evaluate("location.hash")) === "#/settings/scripts"
	);
	page.check(
		"Enable scripting starts off",
		(await page.evaluate(`document.querySelector('input[name="enableScripting"]').checked`)) ===
			false
	);
	page.check("no library while off", (await page.count(".scripts-actions")) === 0);
	await page.screenshot("scripts-off");

	await page.click(".settings-menu button.general");
	await page.waitFor(`!!document.querySelector(".settings-backup")`, {label: "General open"});
	page.check(
		"General has no scripting switch",
		(await page.count('input[name="enableScripting"]')) === 0
	);
	await page.click(".settings-menu button.scripts");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "Scripts tab again",
	});

	await page.click('input[name="enableScripting"]');
	await page.waitFor(`!!document.querySelector(".scripts-actions")`, {label: "library shown"});
	page.check(
		"stored setting is on",
		(await page.evaluate(
			`JSON.parse(localStorage.getItem("settings") ?? "{}").enableScripting`
		)) === true
	);
	page.check(
		"parser still not loaded with no enabled scripts",
		(await page.evaluate(FENGARI_RESOURCES)) === 0
	);
	page.check("still no footer icon once on", (await page.count("#footer .scripts")) === 0);
	await page.screenshot("scripts-empty");

	// An example opens straight in the editor and loads the parser.
	await page.click(".scripts-examples .btn", 0);
	await page.waitFor(`!!document.querySelector(".settings-script-edit .script-code")`, {
		label: "editor open",
	});
	const id = await page.evaluate(`${STORED}[0]?.id`);
	page.check(
		"the editor is /settings/scripts/<id>",
		(await page.evaluate("location.hash")) === `#/settings/scripts/${id}`
	);
	page.check(
		"the Scripts tab stays active in the editor",
		(await page.count(".settings-menu button.scripts.active")) === 1
	);
	page.check(
		"the editor's column is the wide one",
		Math.abs(
			(await page.rect(".settings-modal-body .container")).width -
				(await page.evaluate(
					`Math.min(48 * parseFloat(getComputedStyle(document.documentElement).fontSize), document.querySelector(".settings-modal-body").clientWidth)`
				))
		) < 1
	);
	await page.waitFor(`${FENGARI_RESOURCES} > 0`, {label: "fengari loaded for enabled script"});
	page.check("fengari loaded once an enabled script exists", true);
	page.check("code area is tall", (await page.rect(".script-code-wrap")).height > 250);
	await page.screenshot("script-edit-auto-ping");

	await page.click(".script-tools .btn", 0);
	await page.waitFor(`document.querySelector(".script-status")?.textContent === "Syntax OK"`, {
		label: "syntax ok",
		timeout: 10000,
	});
	page.check("Check syntax passes on the example", true);

	// A name the library would drop is never saved; a good one is.
	await page.fill(".script-name", "bad name");
	await page.waitFor(`!!document.querySelector(".script-error-line")`, {label: "name error"});
	await page.sleep(800);
	page.check(
		"an invalid name is not saved",
		(await page.evaluate(`${STORED}[0].name`)) === "auto_ping"
	);
	await page.fill(".script-name", "pinger");
	await page.waitFor(`${STORED}[0].name === "pinger"`, {label: "rename saved"});
	page.check("a valid rename is saved", (await page.count(".script-error-line")) === 0);

	// Tab indents; Shift+Tab leaves the field (no keyboard trap).
	await page.evaluate(`(() => {
		const area = document.querySelector(".script-code");
		area.focus();
		area.selectionStart = area.selectionEnd = area.value.length;
	})()`);
	await key(page, "Tab");
	page.check(
		"Tab inserts four spaces",
		(await page.evaluate(`document.querySelector(".script-code").value.endsWith("    ")`)) ===
			true
	);
	await key(page, "Tab", 8);
	page.check(
		"Shift+Tab moves focus out of the code",
		(await page.evaluate(`document.activeElement?.classList.contains("script-code")`)) === false
	);

	// Back in the list: filed under its folder, and switched off from the row.
	await page.click(".script-back");
	await page.waitFor(`!!document.querySelector(".scripts-item")`, {label: "list again"});
	page.check(
		"listed under Automation",
		(await page.evaluate(`document.querySelector(".scripts-folder")?.textContent`)) ===
			"Automation"
	);
	page.check(
		"the row shows the new name",
		(await page.evaluate(`document.querySelector(".scripts-name")?.textContent`)) === "pinger"
	);
	await page.click(".scripts-item input[type=checkbox]");
	await page.waitFor(`${STORED}[0].enabled === false`, {label: "row switch saved"});
	page.check("the row's switch turns the script off", true);
	await page.screenshot("scripts-list");

	// A backtracking pattern stops at the matcher's step budget
	// (scripts/fengari-match-budget.js) instead of holding the page: the
	// load fails with the limit's error, shown in the editor's banner.
	await page.click(".scripts-summary");
	await page.waitFor(`!!document.querySelector(".script-code")`, {label: "editor again"});
	await page.click(".script-run input");
	await page.waitFor(`${STORED}[0].enabled === true`, {label: "run switch saved"});
	await page.fill(".script-code", `string.find(string.rep("a", 100000), ".-.-.-.-b")`);
	await page.waitFor(`(${STORED}[0].lastError ?? "").includes("step limit")`, {
		label: "pattern stopped at its step budget",
		timeout: 15000,
	});
	await page.waitFor(
		`[...document.querySelectorAll(".script-banner")].some((b) => b.textContent.includes("step limit"))`,
		{label: "error banner"}
	);
	page.check("a backtracking pattern stops at the step budget, and says so", true);
	await page.screenshot("script-edit-error");

	// Duplicate opens the copy (a fresh editor), switched off.
	await page.click(".script-tools .btn", 1);
	await page.waitFor(`document.querySelector(".script-name")?.value === "pinger_copy"`, {
		label: "copy open",
	});
	const copy = await page.evaluate(`${STORED}.find((s) => s.name === "pinger_copy")`);
	page.check("the copy is off", copy?.enabled === false);
	page.check(
		"the URL follows the copy",
		(await page.evaluate("location.hash")) === `#/settings/scripts/${copy?.id}`
	);

	// Delete asks first, then goes back to the list.
	await page.click(".script-delete");
	await page.waitFor(`!!document.querySelector("#confirm-dialog .btn-danger")`, {
		label: "confirm",
	});
	await page.click("#confirm-dialog .btn-danger");
	await page.waitFor(`!!document.querySelector(".scripts-actions")`, {label: "back on list"});
	page.check("the copy is deleted", (await page.evaluate(`${STORED}.length`)) === 1);
	await page.waitFor(`!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "confirm closed",
	});
	await page.sleep(400); // its fade

	// Off again: the library hides, and the editor's URL leads to the tab.
	await page.click('input[name="enableScripting"]');
	await page.waitFor(`!document.querySelector(".scripts-actions")`, {label: "library hidden"});
	await page.evaluate(`location.hash = "#/settings/scripts/${id}"`);
	await page.sleep(300);
	page.check(
		"the editor is not reachable while off",
		(await page.evaluate("location.hash")) === "#/settings/scripts" &&
			(await page.count(".script-code")) === 0
	);
	await page.screenshot("scripts-off-again");

	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector("#settings")`, {label: "settings closed"});

	// The step-limit test's own load failure is logged on purpose; nothing else may be.
	const unexpected = page.consoleErrors.filter(
		(e) => !String(e.text ?? e).includes("pattern too complex (step limit)")
	);
	page.check("no console errors", unexpected.length === 0);
}
