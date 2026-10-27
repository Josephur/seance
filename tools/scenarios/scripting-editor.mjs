// Enable Scripting gate + full-screen script editor, no IRC needed:
// while the General switch is off there is no scripting icon in the
// sidebar footer and the Fengari chunk is never fetched; turning it on
// shows the icon (still no parser — no enabled script exists yet),
// the editor opens full-screen, and creating an enabled template is
// what finally loads Fengari. Scripts are filed by folder.
//
//   corepack yarn build && python3 -m http.server -d public 8022 &
//   node tools/browser-drive.mjs tools/scenarios/scripting-editor.mjs

const BASE = "http://localhost:8022/";
export const url = BASE;

const FENGARI_RESOURCES = `performance.getEntriesByType("resource").filter((e) => e.name.includes("fengari")).length`;

export default async function run(page) {
	await page.goto(BASE, {waitForSelector: "#footer button.settings"});

	page.check(
		"no scripting icon while disabled",
		(await page.count("#footer button.scripts")) === 0
	);
	page.check("fengari not loaded while disabled", (await page.evaluate(FENGARI_RESOURCES)) === 0);
	await page.screenshot("footer-no-scripting-icon");

	// Settings → General: turn Enable Scripting on.
	await page.click("#footer button.settings");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "General settings up",
	});
	page.check(
		"Enable Scripting starts off",
		(await page.evaluate(`document.querySelector('input[name="enableScripting"]').checked`)) ===
			false
	);
	await page.screenshot("general-scripting-off");
	await page.click('input[name="enableScripting"]');
	await page.waitFor(`!!document.querySelector("#footer button.scripts")`, {
		label: "scripting icon appeared",
	});
	page.check("scripting icon appears when enabled", true);
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

	// Full-screen editor via the sidebar icon (close the settings modal
	// first — it covers the sidebar).
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector("#settings")`, {label: "settings closed"});
	await page.click("#footer button.scripts");
	await page.waitFor(`!!document.querySelector("#script-editor")`, {label: "editor open"});
	const editorBox = await page.rect("#script-editor");
	const codeBoxEmpty = await page.rect(".script-main-empty");
	page.check("editor is full height", editorBox.height > 500);
	page.check("empty library state shows", !!codeBoxEmpty);
	await page.screenshot("script-editor-empty");

	// A template files itself under Automation and loads the parser.
	await page.click(".script-library-actions + .script-library-actions .btn", 0);
	await page.waitFor(
		`[...document.querySelectorAll(".script-row-name")].some((e) => e.textContent === "auto_ping")`,
		{label: "template created"}
	);
	page.check(
		"template grouped under Automation",
		(await page.evaluate(`document.querySelector(".script-group-title")?.textContent`)) ===
			"Automation"
	);
	await page.waitFor(`${FENGARI_RESOURCES} > 0`, {label: "fengari loaded for enabled script"});
	page.check("fengari loaded once an enabled script exists", true);

	const codeBox = await page.rect(".script-code-area");
	page.check("code editor is tall", codeBox.height > 300);
	await page.screenshot("script-editor-auto-ping");

	// Search hides it, clearing brings it back.
	await page.fill(".script-search", "no-such-script");
	await page.waitFor(`document.querySelectorAll(".script-row").length === 0`, {
		label: "search filtered",
	});
	page.check("search filters the library", true);
	await page.fill(".script-search", "auto");
	await page.waitFor(`document.querySelectorAll(".script-row").length === 1`, {
		label: "search matched",
	});

	// Check syntax reports OK for the template.
	await page.click(".script-main-tools .btn", 0);
	await page.waitFor(
		`document.querySelector(".script-editor-status")?.textContent.includes("Syntax OK")`,
		{label: "syntax ok", timeout: 10000}
	);
	page.check("syntax check passes", true);
	await page.screenshot("script-editor-checked");

	// Turning the switch off removes the icon again.
	await page.click("#footer button.settings");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "General settings again",
	});
	await page.click('input[name="enableScripting"]');
	await page.waitFor(`!document.querySelector("#footer button.scripts")`, {
		label: "scripting icon gone",
	});
	page.check("scripting icon removed when disabled", true);
	await page.screenshot("general-scripting-off-again");

	page.check("no console errors", page.consoleErrors.length === 0);
}
