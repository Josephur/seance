import {expect} from "chai";
import sinon from "ts-sinon";
// First: support loads client.ts, which pushMute.ts needs initialised (the
// pushMute ↔ presence ↔ client import cycle).
import {register, setup, type Harness} from "./support";
import {
	AWAY_KEY,
	PRESENCE_KEY,
	formatStamped,
	newer,
	parseStamped,
} from "../../client/js/irc/presenceShare";
import {MUTE_READ_DELAY_MS} from "../../client/js/irc/pushMute";

const CAPS = "server-time message-tags batch labeled-response draft/metadata-2";
const LOGIN = ":irc.test 900 alice alice!a@h alice :You are now logged in as alice";
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MODES = ["online", "auto", "away", "dnd"];

describe("shared presence values (irc/presenceShare.ts)", function () {
	it("parses <word> <ms> against its word list, and nothing else", function () {
		expect(parseStamped("away 1792000000000", MODES)).to.deep.equal({
			value: "away",
			at: 1792000000000,
		});
		expect(parseStamped("on 5", ["on", "off"])).to.deep.equal({value: "on", at: 5});

		for (const bad of [
			"",
			"away",
			"away x",
			"busy 1792000000000",
			"away 1792000000000 x",
			" away 1",
			"away -1",
			"away 0",
			"away 05",
		]) {
			expect(parseStamped(bad, MODES), bad).to.equal(null);
		}

		expect(parseStamped("maybe 5", ["on", "off"])).to.equal(null);
	});

	it("formats it back", function () {
		expect(formatStamped({value: "dnd", at: 5})).to.equal("dnd 5");
	});

	it("orders by time, then by the word", function () {
		expect(newer({value: "auto", at: 2}, {value: "away", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "auto", at: 2})).to.equal(false);
		expect(newer({value: "online", at: 1}, {value: "away", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "online", at: 1})).to.equal(false);
		expect(newer({value: "on", at: 1}, {value: "off", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "away", at: 1})).to.equal(false);
	});
});

describe("shared presence on the wire (irc/presenceShare.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: T0, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	function registered(opts: {account?: boolean; metadata?: boolean} = {}): Harness {
		const h = setup({join: ""});
		register(
			h,
			opts.metadata === false ? "server-time message-tags" : CAPS,
			opts.account === false ? [] : [LOGIN]
		);
		return h;
	}

	/** Registered with an account and the cap, the login read sent. */
	function connected(opts: {account?: boolean; metadata?: boolean} = {}): Harness {
		const h = registered(opts);
		clock.tick(MUTE_READ_DELAY_MS);
		h.sent();
		return h;
	}

	const sets = (h: Harness, key: string) =>
		h.sent().filter((l) => l.startsWith(`METADATA * SET ${key} `));
	const answer = (h: Harness, key: string, value: string | null) =>
		h.transport.line(
			value === null
				? `:irc.test 766 alice alice ${key} :key not set`
				: `:irc.test 761 alice alice ${key} private :${value}`
		);
	const live = (h: Harness, key: string, value: string) =>
		h.transport.line(`:irc.test METADATA alice ${key} private :${value}`);

	it("the login read subscribes to and gets the mute and both shared keys", function () {
		const h = registered();
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => / (SUB|GET) /.test(l))).to.deep.equal([
			`METADATA * SUB draft/webpush/mute ${PRESENCE_KEY} ${AWAY_KEY}`,
			`METADATA * GET draft/webpush/mute ${PRESENCE_KEY} ${AWAY_KEY}`,
		]);
	});

	describe("the mode (seance/presence)", function () {
		it("adopts a server choice newer than the device's", function () {
			const h = connected();
			h.client.setPresenceMode("online", T0 - 5000);
			h.sent();
			answer(h, PRESENCE_KEY, `away ${T0 - 1000}`);
			expect(h.client.presenceMode).to.equal("away");
			expect(h.client.presenceAt).to.equal(T0 - 1000);
			expect(h.sent()).to.include("AWAY *");
			expect(h.payloads("network:presence-shared")).to.deep.equal([
				{network: h.client.uuid, mode: "away", at: T0 - 1000},
			]);
		});

		it("adopts a server choice when the device never chose", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `dnd ${T0 - 1000}`);
			expect(h.client.presenceMode).to.equal("dnd");
		});

		it("writes a device choice newer than the server's, then its echoes write nothing", function () {
			const h = connected();
			h.client.setPresenceMode("away", T0 - 100);
			h.sent();
			answer(h, PRESENCE_KEY, `online ${T0 - 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 100}`,
			]);
			expect(h.client.presenceMode).to.equal("away");
			answer(h, PRESENCE_KEY, `away ${T0 - 100}`);
			live(h, PRESENCE_KEY, `away ${T0 - 100}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.payloads("network:presence-shared")).to.deep.equal([]);
		});

		it("an empty server: writes a device choice, nothing when there is none", function () {
			const chosen = connected();
			chosen.client.setPresenceMode("auto", T0 - 100);
			answer(chosen, PRESENCE_KEY, null);
			expect(sets(chosen, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :auto ${T0 - 100}`,
			]);

			const never = connected();
			answer(never, PRESENCE_KEY, null);
			expect(sets(never, PRESENCE_KEY)).to.deep.equal([]);
		});

		it("an older value arriving after ours is written back once, and its echo ends it", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `away ${T0 - 100}`);
			h.sent();
			live(h, PRESENCE_KEY, `online ${T0 - 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 100}`,
			]);
			expect(h.client.presenceMode).to.equal("away");
			live(h, PRESENCE_KEY, `away ${T0 - 100}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
		});

		it("a choice on another device reaches this one live", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `auto ${T0 - 5000}`);
			h.sent();
			live(h, PRESENCE_KEY, `away ${T0 - 10}`);
			expect(h.client.presenceMode).to.equal("away");
			expect(h.sent()).to.include("AWAY *");
		});

		it("a choice made here after the read is written at once", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `auto ${T0 - 5000}`);
			h.client.setPresenceMode("dnd", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :dnd ${T0}`,
			]);
		});

		it("ignores a value it cannot read", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `busy ${T0 - 10}`);
			expect(h.client.presenceMode).to.equal("auto");
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			h.client.setPresenceMode("away", T0 - 5);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 5}`,
			]);
		});

		it("an unknown value is not answered with a write; a choice made after it is written", function () {
			// spec § 3: a later client can extend the format without us fighting it.
			const h = connected();
			h.client.setPresenceMode("online", T0 - 100);
			answer(h, PRESENCE_KEY, `busy ${T0 + 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			live(h, PRESENCE_KEY, `busy ${T0 + 6000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.client.presenceMode).to.equal("online");
			h.client.setPresenceMode("away", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0}`,
			]);
		});

		it("a choice before the read waits for it", function () {
			const h = registered();
			h.client.setPresenceMode("away", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			clock.tick(MUTE_READ_DELAY_MS);
			answer(h, PRESENCE_KEY, `online ${T0 - 1000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0}`,
			]);
		});

		it("a reconnect reads again before writing", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, null);
			h.transport.closed(); // support's close() is silent; closed() reports it

			h.client.setPresenceMode("dnd", T0 + 1);
			expect(h.client.presenceKnown).to.equal(false);
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${CAPS}`);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.lines(
				`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`,
				":irc.test 001 alice :Welcome",
				LOGIN,
				":irc.test 422 alice :MOTD File is missing"
			);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			clock.tick(MUTE_READ_DELAY_MS);
			answer(h, PRESENCE_KEY, null);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :dnd ${T0 + 1}`,
			]);
		});

		it("a FAIL METADATA writes nothing more until the next read", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, null);
			h.client.setPresenceMode("away", T0);
			h.sent();
			h.transport.line(`:irc.test FAIL METADATA RATE_LIMITED ${PRESENCE_KEY} 5 :Rate limit`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.client.presenceMode).to.equal("away");
		});

		it("never reads or writes without an account or the cap", function () {
			for (const opts of [{account: false}, {metadata: false}]) {
				const h = connected(opts);
				h.client.setPresenceMode("away", T0);
				expect(h.transport.sent.filter((l) => l.includes(PRESENCE_KEY))).to.deep.equal([]);
				expect(h.client.presenceMode).to.equal("away");
			}
		});

		it("a mode set with no time leaves the time alone", function () {
			const h = connected();
			h.client.setPresenceMode("away");
			expect(h.client.presenceAt).to.equal(undefined);
		});
	});

	describe("global away (seance/away)", function () {
		it("adopts a newer server switch: applied here and reported to the page", function () {
			const h = connected();
			answer(h, AWAY_KEY, `on ${T0 - 1000}`);
			expect(h.client.globalAway).to.deep.equal({on: true, at: T0 - 1000});
			expect(h.sent()).to.include("AWAY *");
			expect(h.payloads("away:shared")).to.deep.equal([
				{network: h.client.uuid, on: true, at: T0 - 1000},
			]);
		});

		it("writes the device's newer switch, then its echoes write nothing", function () {
			const h = connected();
			h.client.setGlobalAway({on: true, at: T0 - 100});
			h.sent();
			answer(h, AWAY_KEY, `off ${T0 - 5000}`);
			expect(sets(h, AWAY_KEY)).to.deep.equal([
				`METADATA * SET ${AWAY_KEY} private :on ${T0 - 100}`,
			]);
			answer(h, AWAY_KEY, `on ${T0 - 100}`);
			live(h, AWAY_KEY, `on ${T0 - 100}`);
			expect(sets(h, AWAY_KEY)).to.deep.equal([]);
			expect(h.payloads("away:shared")).to.deep.equal([]);
		});

		it("a switch never touched writes nothing to an empty server", function () {
			const h = connected();
			answer(h, AWAY_KEY, null);
			expect(sets(h, AWAY_KEY)).to.deep.equal([]);
		});

		it("the page's switch after the read is written at once, and turning it off sends AWAY", function () {
			const h = connected();
			answer(h, AWAY_KEY, null);
			h.client.setGlobalAway({on: true, at: T0});
			expect(h.sent()).to.deep.equal([
				"AWAY *",
				`METADATA * SET ${AWAY_KEY} private :on ${T0}`,
			]);
			h.client.setGlobalAway({on: false, at: T0 + 1});
			expect(h.sent()).to.deep.equal([
				"AWAY",
				`METADATA * SET ${AWAY_KEY} private :off ${T0 + 1}`,
			]);
		});

		it("an unknown value is not answered with a write, even with a switch of our own", function () {
			const h = connected();
			h.client.setGlobalAway({on: true, at: T0 - 100});
			answer(h, AWAY_KEY, `maybe ${T0}`);
			expect(sets(h, AWAY_KEY)).to.deep.equal([]);
			expect(h.client.globalAway).to.deep.equal({on: true, at: T0 - 100});
		});

		it("ignores a value it cannot read", function () {
			const h = connected();
			answer(h, AWAY_KEY, `maybe ${T0}`);
			expect(h.client.globalAway).to.deep.equal({on: false, at: null});
			expect(sets(h, AWAY_KEY)).to.deep.equal([]);
		});
	});
});

describe("subscribing to the shared keys (client.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: T0, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	const SUB = `METADATA * SUB draft/webpush/mute ${PRESENCE_KEY} ${AWAY_KEY}`;
	const GET = `METADATA * GET draft/webpush/mute ${PRESENCE_KEY} ${AWAY_KEY}`;

	/** A SASL login on a server offering `metadata`; returns the CAP END flush. */
	function saslLogin(h: Harness, metadata: string): string[] {
		h.client.connect();
		h.transport.open();
		h.transport.line(
			`:irc.test CAP * LS :server-time message-tags batch sasl=PLAIN ${metadata}`
		);
		const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
		h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
		h.sent();
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		return h.sent();
	}

	const welcome = (h: Harness) =>
		h.transport.lines(
			":irc.test 001 alice :Welcome",
			":irc.test 422 alice :MOTD File is missing"
		);

	it("subscribes before CAP END when the server offers before-connect, then only GETs", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = saslLogin(h, "draft/metadata-2=before-connect,max-subs=50");
		expect(flush.slice(-2)).to.deep.equal([SUB, "CAP END"]);
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([GET]);
	});

	it("without before-connect, subscribes with the login read as before", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = saslLogin(h, "draft/metadata-2=max-subs=50");
		expect(flush.filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([SUB, GET]);
	});

	it("a reconnect subscribes again", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		saslLogin(h, "draft/metadata-2=before-connect");
		welcome(h);
		h.transport.closed();
		expect(h.client.metadataSubscribed).to.equal(false);
	});
});
