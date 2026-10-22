/**
 * The dial ledger (irc/dialLedger.ts): nefarious2's connection throttle
 * (IPcheck: the fourth connection in a chain of gaps of 40 s or less is
 * refused, and a refusal renews the window), replayed over this device's own
 * dials so the transport waits instead of dialing into a refusal.
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import {
	DEFAULT_BRANDING,
	connectThrottleRule,
	normalizeBranding,
	resetBranding,
	setBranding,
} from "../../client/js/branding";
import type {TransportOptions} from "../../client/js/irc/transport";
import {FakeTransport, register, setup} from "./support";
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

	describe("connectThrottleRule (config.json features.connectThrottle)", function () {
		it("is nefarious2's rule by default", function () {
			expect(connectThrottleRule(DEFAULT_BRANDING)).to.deep.equal(NEFARIOUS_RULE);
			expect(connectThrottleRule(normalizeBranding({}))).to.deep.equal(NEFARIOUS_RULE);
		});

		it("is off when the deploy says false", function () {
			expect(
				connectThrottleRule(normalizeBranding({features: {connectThrottle: false}}))
			).to.equal(null);
		});

		it("takes a deploy's own limit and period", function () {
			expect(
				connectThrottleRule(
					normalizeBranding({features: {connectThrottle: {limit: 5, periodSeconds: 60}}})
				)
			).to.deep.equal({limit: 5, periodMs: 60_000, marginMs: 2_000});
		});

		it("ignores a malformed value", function () {
			for (const bad of [{limit: 0, periodSeconds: 40}, {limit: 4}, "yes", 3]) {
				expect(
					connectThrottleRule(normalizeBranding({features: {connectThrottle: bad}}))
				).to.deep.equal(NEFARIOUS_RULE);
			}
		});
	});

	describe("wired into the client", function () {
		let clock: sinon.SinonFakeTimers;

		beforeEach(function () {
			clock = sinon.useFakeTimers({now: Date.parse("2026-10-22T12:00:00.000Z")});
		});

		afterEach(function () {
			clock.restore();
			resetBranding();
		});

		/** The options the client builds its transport with. */
		function transportOptions(): TransportOptions {
			let captured: TransportOptions | undefined;
			const h = setup({
				transportFactory(opts) {
					captured = opts;
					return new FakeTransport();
				},
			});
			h.client.connect();
			return captured as TransportOptions;
		}

		it("gives the transport a gate for the network's host", function () {
			expect(transportOptions().gate).to.not.equal(undefined);
		});

		it("gives it none when the deploy switched the ledger off", function () {
			setBranding(normalizeBranding({features: {connectThrottle: false}}));
			expect(transportOptions().gate).to.equal(undefined);
		});

		it("says a wait is the server's throttle, and drops that once the dial starts", function () {
			const h = setup();
			register(h);
			h.transport.event({
				type: "close",
				code: 1006,
				reason: "",
				wasClean: false,
				willReconnect: true,
				delayMs: 30_000,
			});
			h.transport.event({type: "reconnecting", attempt: 1, delayMs: 30_000, throttled: true});
			const status =
				h.payloads<{retryAt?: number; retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1]).to.include({
				retryAt: Date.now() + 30_000,
				retryThrottled: true,
			});
			expect(h.lastMessage(h.client.lobby.id).text).to.match(/limits how often/);

			h.transport.event({type: "retry", attempt: 1});
			const after = h.payloads<{retryThrottled?: boolean}>("network:status");
			expect(after[after.length - 1].retryThrottled).to.equal(undefined);
		});

		it("shows the due time of a throttled connect() that no close came before", function () {
			const h = setup();
			h.transport.event({type: "reconnecting", attempt: 0, delayMs: 20_000, throttled: true});
			const status =
				h.payloads<{retryAt?: number; retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1]).to.include({
				retryAt: Date.now() + 20_000,
				retryThrottled: true,
			});
		});

		it("keeps a plain backoff wait unmarked", function () {
			const h = setup();
			register(h);
			h.transport.event({
				type: "close",
				code: 1006,
				reason: "",
				wasClean: false,
				willReconnect: true,
				delayMs: 4_000,
			});
			h.transport.event({type: "reconnecting", attempt: 3, delayMs: 4_000});
			const status = h.payloads<{retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1].retryThrottled).to.equal(undefined);
		});
	});
});
