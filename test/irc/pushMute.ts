import {expect} from "chai";
import {
	formatMute,
	globalUntil,
	parseMute,
	withGlobal,
	withoutGlobal,
} from "../../client/js/irc/pushMute";

describe("push mute value (irc/pushMute.ts)", function () {
	const NOW = 1_800_000_000;

	it("parses target:until entries and drops malformed ones", function () {
		expect(parseMute("*:1800000100;#seance:1800000200;bad;:5;bob:x")).to.deep.equal([
			{target: "*", until: 1800000100},
			{target: "#seance", until: 1800000200},
		]);
		expect(parseMute("")).to.deep.equal([]);
	});

	it("splits each entry at the first colon, as the server does", function () {
		expect(parseMute("#a:b:5")).to.deep.equal([]);
		expect(parseMute("#a:5:b")).to.deep.equal([]);
	});

	it("keeps indefinite entries (until 0 or a leading '-')", function () {
		expect(parseMute("x:0;y:-1")).to.deep.equal([
			{target: "x", until: 0},
			{target: "y", until: -1},
		]);
	});

	it("formats entries back", function () {
		expect(
			formatMute([
				{target: "*", until: 5},
				{target: "bob", until: 6},
			])
		).to.equal("*:5;bob:6");
	});

	it("reads the global entry only while it is live", function () {
		expect(globalUntil("*:1800000100", NOW)).to.equal(1800000100);
		expect(globalUntil("*:1799999999", NOW)).to.equal(null);
		expect(globalUntil("#seance:1800000100", NOW)).to.equal(null);
	});

	it("reads an indefinite global entry as Infinity", function () {
		expect(globalUntil("*:0", NOW)).to.equal(Number.POSITIVE_INFINITY);
		expect(globalUntil("*:-1", NOW)).to.equal(Number.POSITIVE_INFINITY);
	});

	it("keeps indefinite entries of other targets through both writes", function () {
		expect(withGlobal("x:0;y:-1", 1800000900, NOW)).to.equal("x:0;y:-1;*:1800000900");
		expect(withoutGlobal("x:0;y:-1;*:1800000900", NOW)).to.equal("x:0;y:-1");
	});

	it("sets the global entry and keeps the others", function () {
		expect(withGlobal("#seance:1800000200;*:1800000050", 1800000900, NOW)).to.equal(
			"#seance:1800000200;*:1800000900"
		);
	});

	it("drops expired entries when it writes", function () {
		expect(withGlobal("#old:1700000000;bob:1800000200", 1800000900, NOW)).to.equal(
			"bob:1800000200;*:1800000900"
		);
		expect(withoutGlobal("#old:1700000000;*:1800000900;bob:1800000200", NOW)).to.equal(
			"bob:1800000200"
		);
		expect(withoutGlobal("*:1800000900", NOW)).to.equal("");
	});
});
