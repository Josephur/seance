/**
 * The away state declared during registration (`draft/pre-away`,
 * client/js/irc/presence.ts `registrationAwayLine`) and the user's `/away`
 * remembered across reloads (client/js/irc/userAwayStore.ts).
 *
 * nefarious2's bouncer attaches a reconnect or a reload to the held
 * session; a connection that registers without saying it is away counts as
 * present, and the server announces the user back to everyone. So the
 * away goes out in the flush that carries `CAP END`, right before it.
 */

import {expect} from "chai";
import {dispatchInput} from "../../client/js/irc/commands";
import * as saved from "../../client/js/irc/saved-networks";
import {
	USER_AWAY_KEY,
	getUserAway,
	useStorageBackend,
	type StorageBackend,
} from "../../client/js/irc/userAwayStore";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, Harness, setup} from "./support";

class MemoryBackend implements StorageBackend {
	data = new Map<string, string>();

	get(key: string): string | null {
		return this.data.get(key) ?? null;
	}

	set(key: string, value: string): void {
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}
}

const UUID = "preaway-net";
const PRE_AWAY_CAPS = `${ALL_CAPS} draft/pre-away`;
const SASL_CAPS = `${PRE_AWAY_CAPS} sasl=PLAIN draft/persistence=attach,detach,list,attach-cursor`;

/** CAP LS / REQ / ACK; returns what was sent from the LS on. */
function negotiate(h: Harness, caps: string): string[] {
	h.sent();
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${caps}`);
	const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop();
	expect(req, "CAP REQ sent").to.be.a("string");
	h.transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	return h.sent();
}

function welcome(h: Harness): string[] {
	h.transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing"
	);
	return h.sent();
}

/** Connect and register; returns [lines up to and including CAP END, lines after 001]. */
function connect(h: Harness, caps = PRE_AWAY_CAPS): [string[], string[]] {
	h.client.connect();
	const before = negotiate(h, caps);
	return [before, welcome(h)];
}

/** The socket drops and the client dials again. */
function reconnect(h: Harness, caps = PRE_AWAY_CAPS): [string[], string[]] {
	h.transport.closed();
	return connect(h, caps);
}

const aways = (lines: string[]) => lines.filter((l) => l.startsWith("AWAY"));

/** The lines from the first AWAY to CAP END, which must close the list. */
function tail(lines: string[]): string[] {
	expect(lines[lines.length - 1]).to.equal("CAP END");
	const i = lines.findIndex((l) => l.startsWith("AWAY"));
	return i < 0 ? ["CAP END"] : lines.slice(i);
}

function client(overrides = {}): Harness {
	return setup({uuid: UUID, ...overrides});
}

describe("the away state across reloads and reconnects (draft/pre-away)", function () {
	let backend: MemoryBackend;
	let savedBackend: MemoryBackend;

	beforeEach(function () {
		backend = new MemoryBackend();
		savedBackend = new MemoryBackend();
		useStorageBackend(backend);
		saved.useStorageBackend(savedBackend);
	});

	afterEach(function () {
		useStorageBackend(null);
		saved.useStorageBackend(null);
	});

	it("requests draft/pre-away", function () {
		const h = client();
		const [before] = connect(h);
		const req = before.find((l) => l.startsWith("CAP REQ :")) as string;
		expect(req.slice("CAP REQ :".length).split(" ")).to.include("draft/pre-away");
	});

	it("declares a /away right before CAP END on a reconnect, and nothing after 001", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away gone fishing");
		expect(aways(h.sent())).to.deep.equal(["AWAY :gone fishing"]);

		const [before, after] = reconnect(h);
		expect(tail(before)).to.deep.equal(["AWAY :gone fishing", "CAP END"]);
		expect(aways(after)).to.deep.equal([]);
		expect(h.client.presence.userAway).to.equal(true);
	});

	it("with SASL: PERSISTENCE ATTACH, then the AWAY, then CAP END", function () {
		saved.save({
			uuid: UUID,
			name: "",
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "#seance",
			sasl: "plain",
			saslAccount: "alice",
			saslPassword: "",
			cursor: {msgid: "m-42", time: Date.parse("2026-08-28T11:00:00.000Z")},
		});
		backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "gone fishing"}));
		const s = client({sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});

		s.client.connect();
		const opened = negotiate(s, SASL_CAPS);
		expect(aways(opened), "no AWAY before SASL is done").to.deep.equal([]);
		expect(opened).to.not.include("CAP END");
		s.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		const flush = s.sent();
		const from = flush.findIndex((l) => l.startsWith("PERSISTENCE ATTACH"));
		expect(flush.slice(from)).to.deep.equal([
			"PERSISTENCE ATTACH default m-42",
			"AWAY :gone fishing",
			"CAP END",
		]);
		expect(aways(welcome(s))).to.deep.equal([]);
	});

	it("a reload declares the /away the storage holds", function () {
		backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
		const h = client();
		expect(h.client.presence.userAway).to.equal(true);
		const [before, after] = connect(h);
		expect(tail(before)).to.deep.equal(["AWAY :x", "CAP END"]);
		expect(aways(after)).to.deep.equal([]);
	});

	it("a bare /away is kept and declared as the single space it sent", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away");
		expect(getUserAway(UUID)).to.equal(" ");
		const [before] = reconnect(h);
		expect(tail(before)).to.deep.equal(["AWAY : ", "CAP END"]);
	});

	it("/back forgets it: the next registration declares nothing", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away x");
		dispatchInput(h.client, h.client.lobby, "/back");
		expect(getUserAway(UUID)).to.equal(null);
		expect(backend.get(USER_AWAY_KEY)).to.equal(null);

		const [before, after] = reconnect(h);
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
		// A reload too.
		expect(client().client.presence.userAway).to.equal(false);
	});

	it("removing the network forgets it", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away x");
		saved.remove(UUID);
		expect(getUserAway(UUID)).to.equal(null);
	});

	for (const [label, arrange] of [
		["do not disturb", (h: Harness) => h.client.setGlobalDnd(true, null)],
		["away mode", (h: Harness) => h.client.setPresenceMode("away")],
		["a hidden page", (h: Harness) => h.client.setAttended(false)],
	] as const) {
		it(`${label} at connect declares AWAY * during registration, and no second one after`, function () {
			const h = client();
			arrange(h);
			const [before, after] = connect(h);
			expect(tail(before)).to.deep.equal(["AWAY *", "CAP END"]);
			expect(aways(after)).to.deep.equal([]);
			expect(h.client.presence.starSent).to.equal(true);

			// The page comes back (or the mode goes): AWAY, once.
			h.client.setGlobalDnd(false, null);
			h.client.setPresenceMode("auto");
			h.client.setAttended(true);
			expect(aways(h.sent())).to.deep.equal(["AWAY"]);
		});

		it(`${label} on a reconnect declares AWAY * again`, function () {
			const h = client();
			connect(h);
			arrange(h);
			expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
			const [before, after] = reconnect(h);
			expect(tail(before)).to.deep.equal(["AWAY *", "CAP END"]);
			expect(aways(after)).to.deep.equal([]);
		});
	}

	it("an attended page in online mode declares nothing", function () {
		const h = client();
		h.client.setPresenceMode("online");
		h.client.setAttended(false);
		const [before, after] = connect(h);
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
	});

	it("an attended page on auto, no DND, declares nothing", function () {
		const [before, after] = connect(client());
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
	});

	describe("without draft/pre-away", function () {
		it("sends nothing during registration, then the /away once, its 306 unshown", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client();
			const [before, after] = connect(h, ALL_CAPS);
			expect(aways(before)).to.deep.equal([]);
			expect(aways(after)).to.deep.equal(["AWAY :x"]);

			h.dispatch.resetHistory();
			h.transport.line(":irc.test 306 alice :You have been marked as being away");
			expect(
				h.messages(h.client.lobby.id).filter((m) => m.type === MessageType.AWAY)
			).to.deep.equal([]);
			expect(aways(h.sent())).to.deep.equal([]);
		});

		it("a hidden page says AWAY * after registration, once", function () {
			const h = client();
			h.client.setAttended(false);
			const [before, after] = connect(h, ALL_CAPS);
			expect(aways(before)).to.deep.equal([]);
			expect(aways(after)).to.deep.equal(["AWAY *"]);
		});

		it("a NAKed draft/pre-away falls back to after registration", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client();
			h.client.connect();
			h.sent();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${PRE_AWAY_CAPS}`);
			// Pipelined: the declaration rode on the requested cap.
			expect(tail(h.sent())).to.deep.equal(["AWAY :x", "CAP END"]);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.line(`:irc.test CAP alice NAK :${req.slice("CAP REQ :".length)}`);

			// The per-cap retries: everything but pre-away is ACKed.
			for (const line of h.sent().filter((l) => l.startsWith("CAP REQ :"))) {
				const name = line.slice("CAP REQ :".length);
				h.transport.line(
					`:irc.test CAP alice ${name === "draft/pre-away" ? "NAK" : "ACK"} :${name}`
				);
			}

			expect(aways(welcome(h))).to.deep.equal(["AWAY :x"]);
		});
	});
});
