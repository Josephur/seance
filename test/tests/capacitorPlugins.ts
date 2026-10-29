import {expect} from "chai";
import fs from "fs";
import path from "path";

// The Android build takes only the plugins `android.includePlugins` names
// (shells/capacitor/capacitor.config.ts), so a plugin added to the shell's
// package.json later would be left out of Android without a word. Every
// dependency is either listed there or left out here, on purpose.
describe("the Android shell's plugin list", function () {
	const shell = path.join(process.cwd(), "shells", "capacitor");

	/** Capacitor itself, not plugins. */
	const runtime = ["@capacitor/core", "@capacitor/android", "@capacitor/ios"];

	/** Kept out of Android, with the reason in capacitor.config.ts. */
	const androidExcluded = ["@capacitor/local-notifications"];

	function includePlugins(): string[] {
		const source = fs.readFileSync(path.join(shell, "capacitor.config.ts"), "utf8");
		const list = /includePlugins:\s*\[([^\]]*)\]/.exec(source);
		expect(list, "android.includePlugins in capacitor.config.ts").to.not.equal(null);
		return [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	}

	function dependencies(): string[] {
		const pkg = JSON.parse(fs.readFileSync(path.join(shell, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		return Object.keys(pkg.dependencies ?? {});
	}

	it("names every plugin dependency but the excluded ones", function () {
		const plugins = dependencies().filter(
			(name) => !runtime.includes(name) && !androidExcluded.includes(name)
		);
		expect(includePlugins()).to.have.members(plugins);
	});

	it("excludes only plugins the shell depends on", function () {
		expect(dependencies()).to.include.members(androidExcluded);
	});
});
