import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {CATCHUP_INTERVAL_MS, pendingCatchup} from "../../client/js/irc/catchup";
import {ChanState} from "../../shared/types/chan";
import {ALL_CAPS, Harness, register, setup} from "./support";

// The spy from test/irc/client.ts's root-level beforeEach may be installed;
// only restore one we own (see CLAUDE.md).
describe("Connect burst: batched JOIN, paced catch-up, lazy MODE (irc/catchup.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	let ownSpy = false;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-27T12:00:00.000Z")});

		if (!(socket.dispatch as any).isSinonProxy) {
			sinon.spy(socket, "dispatch");
			ownSpy = true;
		}
	});

	afterEach(function () {
		clock.restore();

		if (ownSpy) {
			(socket.dispatch as sinon.SinonSpy).restore();
			ownSpy = false;
		}
	});

	const CHANS = ["#seance", "#two", "#three", "#four"];

	const CAPS = ALL_CAPS + " draft/read-marker";

	/** Register (read markers on) with four autojoin channels. */
	function connected(): Harness {
		const h = setup({join: CHANS.join(",")});
		register(h, CAPS);
		return h;
	}

	function joinAll(h: Harness): void {
		for (const name of CHANS) {
			h.transport.line(`:alice!alice@host JOIN ${name}`);
		}
	}

	function commandsOf(lines: string[]): string[] {
		return lines.map((l) =>
			l
				.replace(/^@\S+ /, "")
				.split(" ")
				.slice(0, 2)
				.join(" ")
		);
	}

	it("JOINs the autojoin list with one command", function () {
		const h = connected();
		const joins = h.transport.sent.filter((l) => l.startsWith("JOIN"));
		// The model keeps channels sorted; one JOIN carries them all.
		expect(joins).to.deep.equal(["JOIN #four,#seance,#three,#two"]);
	});

	it("puts keyed channels first and splits on TARGMAX / line length", function () {
		const h = connected();
		h.sent();
		h.client.joinChannels([
			{name: "#open"},
			{name: "#locked", key: "hunter2"},
			{name: "#open2"},
		]);
		expect(h.sent()).to.deep.equal(["JOIN #locked,#open,#open2 hunter2"]);

		h.transport.line(":irc.test 005 alice TARGMAX=JOIN:2 :are supported by this server");
		h.client.joinChannels([{name: "#a"}, {name: "#b"}, {name: "#c"}]);
		expect(h.sent()).to.deep.equal(["JOIN #a,#b", "JOIN #c"]);

		h.transport.line(":irc.test 005 alice TARGMAX=JOIN: :are supported by this server");
		const many = Array.from({length: 40}, (_, i) => ({name: `#channel-number-${i}`}));
		h.client.joinChannels(many);
		const lines = h.sent();
		expect(lines.length).to.be.greaterThan(1);

		for (const line of lines) {
			expect(Buffer.byteLength(line)).to.be.at.most(500);
		}

		expect(lines.flatMap((l) => l.split(" ")[1].split(","))).to.deep.equal(
			many.map((c) => c.name)
		);
	});

	it("serves only the active channel at once; the rest one per interval", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		h.sent();
		joinAll(h);

		// Active channel: history + marker (+ its modes) now. Nothing for the others yet.
		const first = h.sent();
		expect(commandsOf(first)).to.deep.equal([
			"MARKREAD #seance",
			"CHATHISTORY LATEST",
			"MODE #seance",
		]);
		expect(first[0]).to.include("#seance");
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal([
			"#two",
			"#three",
			"#four",
		]);

		clock.tick(CATCHUP_INTERVAL_MS - 1);
		expect(h.sent()).to.deep.equal([]);
		clock.tick(1);
		expect(commandsOf(h.sent())).to.deep.equal(["MARKREAD #two", "CHATHISTORY LATEST"]);
		clock.tick(CATCHUP_INTERVAL_MS);
		expect(commandsOf(h.sent())).to.deep.equal(["MARKREAD #three", "CHATHISTORY LATEST"]);
		clock.tick(CATCHUP_INTERVAL_MS);
		expect(commandsOf(h.sent())).to.deep.equal(["MARKREAD #four", "CHATHISTORY LATEST"]);
		expect(pendingCatchup(h.client)).to.deep.equal([]);
		clock.tick(CATCHUP_INTERVAL_MS * 3);
		expect(h.sent()).to.deep.equal([]);
	});

	it("never sends MODE on JOIN; asks once when the channel is first opened", function () {
		const h = connected();
		h.sent();
		joinAll(h);
		clock.tick(CATCHUP_INTERVAL_MS * 5);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);

		const two = h.client.findChannel("#two")!;
		h.client.open(two.id);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal(["MODE #two"]);
		h.client.open(0);
		h.client.open(two.id);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);

		// A re-JOIN (after a reconnect: everything is PARTED, not removed)
		// asks again — #two is the active channel now, so with its catch-up.
		h.transport.closed();
		register(h, CAPS);
		h.transport.line(":alice!alice@host JOIN #two");
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal(["MODE #two"]);
		h.client.open(h.client.findChannel("#two")!.id);
		expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);
	});

	it("opening a waiting channel serves it immediately and keeps pacing the rest", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		h.sent();

		const four = h.client.findChannel("#four")!;
		clock.tick(1000);
		h.client.open(four.id);
		const now = h.sent();
		// Opening marks the channel read up to its newest line (the JOIN), so
		// the stored marker is not asked for; history and modes are.
		expect(commandsOf(now)).to.deep.equal(["CHATHISTORY LATEST", "MODE #four"]);
		expect(now[0]).to.include("#four");
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#two", "#three"]);

		// The interval restarts from the step just taken (the debounced
		// "read up to here" marker for #four is not a catch-up command).
		const notMarkerSend = (l: string) => !/^MARKREAD \S+ timestamp=/.test(l);
		clock.tick(CATCHUP_INTERVAL_MS - 1);
		expect(h.sent().filter(notMarkerSend)).to.deep.equal([]);
		clock.tick(1);
		expect(commandsOf(h.sent().filter(notMarkerSend))).to.deep.equal([
			"MARKREAD #two",
			"CHATHISTORY LATEST",
		]);
	});

	it("skips the marker fetch when the server already volunteered one", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		// The active channel's step starts the pacing clock; #two then waits.
		h.transport.line(":alice!alice@host JOIN #seance");
		h.transport.line(":alice!alice@host JOIN #two");
		h.transport.line(":irc.test MARKREAD #two timestamp=2026-08-27T11:00:00.000Z");
		h.sent();
		clock.tick(CATCHUP_INTERVAL_MS);
		const lines = h.sent();
		expect(commandsOf(lines), lines.join(" | ")).to.deep.equal(["CHATHISTORY LATEST"]);
	});

	it("drops channels that were left or removed while waiting, and everything on close", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		joinAll(h);
		h.sent();

		// Our own PART removes the channel from the model (and the queue).
		h.transport.line(":alice!alice@host PART #two");
		expect(h.client.findChannel("#two")).to.equal(undefined);
		expect(pendingCatchup(h.client).map((c) => c.name)).to.deep.equal(["#three", "#four"]);
		// A channel that is merely no longer JOINED is skipped without spending a slot.
		h.client.findChannel("#three")!.state = ChanState.PARTED;
		clock.tick(CATCHUP_INTERVAL_MS);
		expect(commandsOf(h.sent())).to.deep.equal(["MARKREAD #four", "CHATHISTORY LATEST"]);

		h.transport.closed();
		expect(pendingCatchup(h.client)).to.deep.equal([]);
		clock.tick(CATCHUP_INTERVAL_MS * 3);
		expect(h.sent()).to.deep.equal([]);
	});

	it("uses the reconnect path (LATEST, walking back) for channels that already had history", function () {
		const h = connected();
		const seance = h.client.findChannel("#seance")!;
		h.client.open(seance.id);
		h.transport.line(":alice!alice@host JOIN #seance");
		h.sent();
		// History was requested on that JOIN; a live message is the newest reference.
		h.transport.line(
			"@time=2026-08-27T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi"
		);
		h.transport.closed();
		h.sent();
		const mark = h.transport.sent.length;
		register(h, CAPS);
		// The active channel's catch-up is pipelined right behind the JOIN,
		// before the echo; the echo then only adds the modes.
		const atRegistration = h.transport.sent.slice(mark);
		const join = atRegistration.findIndex((l) => l.startsWith("JOIN "));
		expect(join).to.be.greaterThan(-1);
		expect(atRegistration[join + 1]).to.match(/CHATHISTORY LATEST #seance \* \d+$/);
		// The marker is already known from before the drop: not asked again.
		expect(atRegistration).to.not.include("MARKREAD #seance");
		h.transport.line(":alice!alice@host JOIN #seance");
		expect(h.sent()).to.deep.equal(["MODE #seance"]);
	});
});
