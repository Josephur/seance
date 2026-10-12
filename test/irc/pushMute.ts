import {expect} from "chai";
import sinon from "ts-sinon";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {
	INDEFINITE_MUTE_S,
	MUTE_ECHO_TIMEOUT_MS,
	MUTE_READ_DELAY_MS,
	clearRemoteDnd,
	formatMute,
	globalUntil,
	parseMute,
	withGlobal,
	withoutGlobal,
} from "../../client/js/irc/pushMute";
import {syncPresence} from "../../client/js/irc/presence";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";

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

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.state = "connecting";
	}

	send(line: string): void {
		if (this.state !== "open") {
			throw new Error("WsTransport: not open");
		}

		this.sent.push(line);
	}

	close(): void {
		const wasOpen = this.state === "open";
		this.state = "closed";

		if (wasOpen) {
			this.emit({
				type: "close",
				code: 1000,
				reason: "",
				wasClean: true,
				willReconnect: false,
			});
		}
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.line(line));
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const CAPS = "server-time message-tags batch labeled-response draft/metadata-2";

function connect(opts: {account?: boolean; metadata?: boolean} = {}) {
	const transport = new FakeTransport();
	const dispatch = sinon.spy();
	const client = new IrcClient({
		bus: {dispatch},
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		uuid: "mute-net",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});
	client.connect();
	transport.open();
	const caps = opts.metadata === false ? "server-time message-tags" : CAPS;
	transport.line(`:irc.test CAP * LS :${caps}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
	transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
	transport.line(":irc.test 001 alice :Welcome");

	if (opts.account !== false) {
		transport.line(":irc.test 900 alice alice!a@h alice :You are now logged in as alice");
	}

	transport.line(":irc.test 422 alice :MOTD File is missing");
	let mark = 0;

	const sent = () => {
		const out = transport.sent.slice(mark);
		mark = transport.sent.length;
		// The SUB/GET read is pinned by its own test; the rest watch writes and AWAY.
		return out.filter(
			(l) => (l.includes("METADATA") && !/ (SUB|GET) /.test(l)) || l.startsWith("AWAY")
		);
	};

	return {client, transport, dispatch, sent};
}

describe("push mute on the wire (irc/pushMute.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	const NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0);
	const NOW_S = NOW_MS / 1000;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: NOW_MS, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	it("reads the key after the connect burst, not in it", function () {
		const h = connect();
		const metadata = () => h.transport.sent.filter((l) => l.includes("METADATA"));
		clock.tick(MUTE_READ_DELAY_MS - 1);
		expect(metadata()).to.deep.equal([]);
		clock.tick(1);
		expect(metadata()).to.deep.equal([
			"METADATA * SUB draft/webpush/mute",
			"METADATA * GET draft/webpush/mute",
		]);
	});

	it("does not read the key on a connection closed before the delay", function () {
		const h = connect();
		h.sent();
		h.transport.close();
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.transport.sent.filter((l) => l.includes("METADATA"))).to.deep.equal([]);
	});

	it("never touches METADATA without an account or the cap, and DND still goes away", function () {
		for (const opts of [{account: false}, {metadata: false}]) {
			const h = connect(opts);
			h.client.setGlobalDnd(true, null);
			clock.tick(MUTE_READ_DELAY_MS);
			const lines = h.sent();
			expect(lines.filter((l) => l.includes("METADATA"))).to.deep.equal([]);
			expect(lines).to.include("AWAY *");
		}
	});

	it("waits for the GET answer before writing, then writes the global entry", function () {
		const h = connect();
		h.sent();
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		h.transport.line(":irc.test 761 alice alice draft/webpush/mute * :#seance:9999999999");
		expect(h.sent()).to.deep.equal([
			`METADATA * SET draft/webpush/mute * :#seance:9999999999;*:${NOW_S + 3600}`,
		]);
	});

	it("indefinite DND writes 30 days and renews under 7", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.client.setPresenceMode("dnd");
		expect(h.sent()).to.deep.equal([
			"AWAY *",
			`METADATA * SET draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`,
		]);

		// Any change makes a sync; the global switch on and off is one.
		const poke = () => {
			h.client.setGlobalDnd(true, null);
			h.client.setGlobalDnd(false, null);
		};

		clock.tick(22 * 86400 * 1000); // 8 days left: nothing
		poke();
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		clock.tick(2 * 86400 * 1000); // 6 days left: renew once
		poke();
		expect(h.sent().filter((l) => l.includes("SET")).length).to.equal(1);
	});

	it("off clears the entry and remoteDnd together", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		// The server's echo of our own write:
		h.transport.line(
			`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		expect(h.client.remoteDnd).to.equal(true);
		h.sent();
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
		// The echo of the clear changes nothing.
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.sent()).to.deep.equal([]);
	});

	it("another device's entry is DND here and is left alone until cleared", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.presenceSnapshot().dnd).to.equal(true);
		expect(h.sent()).to.deep.equal(["AWAY *"]);
		h.client.setGlobalDnd(false, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		clearRemoteDnd(h.client);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
	});

	it("another user's entry in a shared channel is not ours", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.transport.line(`:irc.test METADATA bob draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.sent()).to.deep.equal([]);
	});

	it("an indefinite entry set elsewhere is never rewritten", function () {
		for (const until of ["0", "-1"]) {
			const h = connect();
			h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${until}`);
			expect(h.client.remoteDnd).to.equal(true);
			expect(h.sent()).to.deep.equal(["AWAY *"]);
			h.client.setGlobalDnd(true, NOW_MS + 3600_000);
			h.client.setGlobalDnd(true, null);
			h.client.setPresenceMode("dnd");
			clock.tick(29 * 86400 * 1000);
			h.client.setGlobalDnd(false, null);
			h.client.setPresenceMode("auto");
			syncPresence(h.client);
			expect(h.sent()).to.deep.equal([]);
			expect(h.client.muteOwned).to.equal(false);
			expect(h.client.remoteDnd).to.equal(true);
		}
	});

	it("another device clearing our entry: no rewrite, dnd:cleared reported", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		// The server echoes our write before it relays the other device's.
		h.transport.line(
			`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		h.sent();
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute * :#seance:9999999999");
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().filter((c) => c.args[0] === "dnd:cleared")).to.have.length(1);
		expect(
			h.dispatch.getCalls().find((c) => c.args[0] === "dnd:cleared")?.args[1]
		).to.deep.equal({network: "mute-net"});
		// Local DND ends (the controller's turnOff) and later starts again: writes again.
		h.client.setGlobalDnd(false, null);
		h.client.setGlobalDnd(true, null);
		expect(h.sent().filter((l) => l.includes("SET")).length).to.equal(1);
	});

	it("echoes of our own writes still in flight are not another device's", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		h.sent();
		h.dispatch.resetHistory();
		// Off, then on again before either write is echoed.
		h.client.setGlobalDnd(false, null);
		h.client.setGlobalDnd(true, null);
		expect(h.sent()).to.deep.equal([
			"METADATA * SET draft/webpush/mute",
			"AWAY",
			"AWAY *",
			`METADATA * SET draft/webpush/mute * :${on}`,
		]);
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *",
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(false);
		expect(h.sent()).to.deep.equal([]);
		expect(h.client.muteSuppressed).to.equal(false);
		expect(h.client.muteOwned).to.equal(true);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("a late echo of our write does not flap AWAY", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		h.client.setGlobalDnd(false, null);
		h.sent();
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		expect(h.client.remoteDnd).to.equal(false);
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.sent()).to.deep.equal([]);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("another device's change after our echo still counts", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`,
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.client.muteSuppressed).to.equal(true);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("a write never echoed stops hiding other devices' values", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		h.client.setGlobalDnd(false, null);
		// Both writes refused (no echo); much later another device sets a value.
		clock.tick(MUTE_ECHO_TIMEOUT_MS + 1);
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 3600}`);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("a timed DND ending clears itself", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 3600}`);
		h.sent();
		clock.tick(3600_000 + 60_000);
		// What the minute tick runs: the controller's apply(), then syncPresenceAll().
		h.client.setGlobalDnd(false, null);
		syncPresence(h.client);
		expect(h.sent()).to.deep.equal(["AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
	});

	it("another device's timed entry expiring", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.sent()).to.deep.equal(["AWAY *"]);
		clock.tick(601_000);
		syncPresence(h.client);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("clearing an entry we adopted: no rewrite, dnd:cleared reported", function () {
		const h = connect();
		// Our indefinite DND finds another device's matching entry and writes nothing.
		h.transport.line(
			`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		h.client.setGlobalDnd(true, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute * :");
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(true);
	});

	it("an expired entry is not DND", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S - 1}`);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("forgets the value on close", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(true);
		h.transport.close();
		expect(h.client.muteKnown).to.equal(false);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("keeps the metadata replies out of the lobby", function () {
		const h = connect();
		h.dispatch.resetHistory();
		h.transport.lines(
			":irc.test 770 alice draft/webpush/mute",
			":irc.test 761 alice alice draft/webpush/mute * :",
			":irc.test 762 alice :end of metadata",
			":irc.test 766 alice alice draft/webpush/mute :key not set"
		);
		expect(h.dispatch.getCalls().filter((c) => c.args[0] === "msg")).to.deep.equal([]);
	});
});
