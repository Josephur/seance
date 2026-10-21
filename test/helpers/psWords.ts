import {expect} from "chai";
import {
	defaultPsWords,
	normalizePsWords,
	psWords,
	psWordsHints,
	psWordsLabels,
	SHADOW_WORDS,
	SURFACE_WORDS,
} from "../../client/js/helpers/psWords";

describe("helpers/psWords (the ps theme's Words over the plains setting)", function () {
	it("lists the six treatments in the setting's order, Bubbles first and the default", function () {
		expect(psWords).to.deep.equal(["bubbles", "glass", "scrim", "outline", "rim", "glow"]);
		expect(defaultPsWords).to.equal("bubbles");
		expect([...SURFACE_WORDS, ...SHADOW_WORDS]).to.have.members([...psWords]);
		expect(SURFACE_WORDS).to.deep.equal(["bubbles", "glass", "scrim"]);
		expect(SHADOW_WORDS).to.deep.equal(["outline", "rim", "glow"]);
	});

	it("reads a stored value: a known one as itself, anything else as bubbles", function () {
		for (const w of psWords) {
			expect(normalizePsWords(w)).to.equal(w);
		}

		for (const bad of [undefined, null, "", "halo", 3, {}, "Bubbles"]) {
			expect(normalizePsWords(bad), String(bad)).to.equal("bubbles");
		}
	});

	it("has a label and a one-line hint for each", function () {
		for (const w of psWords) {
			expect(psWordsLabels[w], w).to.be.a("string").and.not.empty;
			expect(psWordsHints[w], w).to.be.a("string").and.not.empty;
			expect(psWordsHints[w], w).to.not.include("\n");
		}
	});
});
