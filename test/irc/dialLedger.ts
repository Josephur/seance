/**
 * The dial ledger (irc/dialLedger.ts): nefarious2's connection throttle
 * (IPcheck: the fourth connection in a chain of gaps of 40 s or less is
 * refused, and a refusal renews the window), replayed over this device's own
 * dials so the transport waits instead of dialing into a refusal.
 */

import {expect} from "chai";
import {
	NEFARIOUS_RULE,
	dialGateFor,
	throttleWaitMs,
	useStorageBackend,
} from "../../client/js/irc/dialLedger";

const S = 1000;

describe("dial ledger (irc/dialLedger.ts)", function () {
	describe("throttleWaitMs", function () {
		it("lets the first dial through", function () {
			expect(throttleWaitMs([], 0, NEFARIOUS_RULE)).to.equal(0);
		});

		it("holds the fourth dial of a quick chain until the gap passes 40 s", function () {
			expect(throttleWaitMs([0, 10 * S, 20 * S], 30 * S, NEFARIOUS_RULE)).to.equal(32 * S);
		});

		it("lets the third dial of a chain through", function () {
			expect(throttleWaitMs([0, 10 * S], 20 * S, NEFARIOUS_RULE)).to.equal(0);
		});

		it("starts over after a gap of more than 40 s", function () {
			expect(throttleWaitMs([0, 10 * S, 20 * S], 61 * S, NEFARIOUS_RULE)).to.equal(0);
		});

		it("counts refused dials, which renew the window", function () {
			expect(
				throttleWaitMs([0, 10 * S, 20 * S, 30 * S, 35 * S], 40 * S, NEFARIOUS_RULE)
			).to.equal(37 * S);
		});

		it("follows the rule's limit", function () {
			const rule = {...NEFARIOUS_RULE, limit: 2};
			expect(throttleWaitMs([0], 10 * S, rule)).to.equal(32 * S);
		});

		it("does not care about the order dials were recorded in", function () {
			expect(throttleWaitMs([20 * S, 0, 10 * S], 30 * S, NEFARIOUS_RULE)).to.equal(32 * S);
		});
	});

	describe("dialGateFor", function () {
		let data: Map<string, string>;

		beforeEach(function () {
			data = new Map();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
		});

		afterEach(function () {
			useStorageBackend(null);
		});

		it("records dials per host, whatever the case", function () {
			const a = dialGateFor("IRC.Example");
			const b = dialGateFor("irc.example");
			a.record(0);
			b.record(10 * S);
			a.record(20 * S);
			expect(b.waitMs(30 * S)).to.equal(32 * S);
			expect(dialGateFor("other.example").waitMs(30 * S)).to.equal(0);
		});

		it("keeps the record across instances (a reopened app)", function () {
			dialGateFor("irc.example").record(0);
			dialGateFor("irc.example").record(10 * S);
			dialGateFor("irc.example").record(20 * S);
			expect(dialGateFor("irc.example").waitMs(30 * S)).to.equal(32 * S);
		});

		it("prunes dials too old to matter", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.record(1000 * S);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"]).to.deep.equal([1000 * S]);
		});

		it("survives a broken record", function () {
			data.set("thelounge.state.dials", "{not json");
			expect(dialGateFor("irc.example").waitMs(0)).to.equal(0);
		});
	});
});
