/**
 * A closed query stays closed (irc/closedQueries.ts): a line from before the
 * close never reopens it — the server's catch-up, an unwrapped replay, another
 * device's query log — while a line from after the close does.
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import {ChanType} from "../../shared/types/chan";
import {
	CLOSED_TTL_MS,
	ClosedQueries,
	decodeClosed,
	encodeClosed,
	mergeClosed,
	useStorageBackend,
} from "../../client/js/irc/closedQueries";
import type {SharedNetworkChan} from "../../shared/types/network";
import * as saved from "../../client/js/irc/saved-networks";
import {flushQueryLogs} from "../../client/js/irc/querylog";
import {ALL_CAPS, Harness, joined, setup, stubStorage} from "./support";

const T0 = "2026-08-28T11:00:00.000Z";
const T1 = "2026-08-28T11:00:01.000Z";

/** The server's cursor replay: an outer `bouncer-replay` batch around one `chathistory` batch. */
function bouncerReplay(h: Harness, target: string, lines: string[]): void {
	h.transport.lines(
		":irc.test BATCH +outer evilnet.github.io/bouncer-replay",
		`@batch=outer; :irc.test BATCH +inner chathistory ${target}`,
		...lines.map((line) => `@batch=inner;${line.slice(1)}`),
		"@batch=outer :irc.test BATCH -inner",
		":irc.test BATCH -outer"
	);
}

/** The `join` payloads for query windows named `nick` (case-insensitive). */
function queryJoins(h: Harness, nick: string): SharedNetworkChan[] {
	return h
		.payloads<{chan: SharedNetworkChan}>("join")
		.map((p) => p.chan)
		.filter((c) => c.type === ChanType.QUERY && c.name.toLowerCase() === nick.toLowerCase());
}

/** A registered client that had a query with `from` (newest line at T0) and closed it. */
function closedQuery(from = "bob"): Harness {
	const h = setup();
	joined(h, ALL_CAPS);
	h.transport.line(`@time=${T0};msgid=p0 :${from}!bob@host PRIVMSG alice :hi`);
	const query = h.client.findChannel(from)!;
	expect(query.type).to.equal(ChanType.QUERY);
	h.client.input(query.id, "/close");
	expect(h.client.findChannel(from)).to.equal(undefined);
	h.dispatch.resetHistory();
	return h;
}

describe("closed queries (irc/closedQueries.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		stubStorage();
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-28T12:00:00.000Z")});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
	});

	describe("the reopen paths", function () {
		it("a catch-up line from before the close does not reopen it", function () {
			const h = closedQuery();
			bouncerReplay(h, "bob", [`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`]);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("an unwrapped replayed line from before the close does not reopen it", function () {
			const h = closedQuery();
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("a line after the close reopens it", function () {
			const h = closedQuery();
			h.transport.line(`@time=${T1};msgid=p1 :bob!bob@host PRIVMSG alice :again`);
			expect(queryJoins(h, "bob")).to.have.length(1);
		});

		it("a catch-up line from after the close reopens it, without the older ones", function () {
			const h = closedQuery();
			bouncerReplay(h, "bob", [
				`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`,
				`@time=${T1};msgid=p1 :bob!bob@host PRIVMSG alice :while you were away`,
			]);
			expect(queryJoins(h, "bob")).to.have.length(1);
			const id = h.client.findChannel("bob")!.id;
			expect(h.messages(id).map((m) => m.text)).to.deep.equal(["while you were away"]);
		});

		it("a query log from before another tab closed it is not restored", function () {
			const uuid = "closed-restore-net";
			saved.save({
				uuid,
				name: "",
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#seance",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
			const first = setup({uuid});
			joined(first, ALL_CAPS);
			first.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			flushQueryLogs();
			// Another tab closed it.
			new ClosedQueries(uuid, (n) => n.toLowerCase()).close("bob", Date.parse(T0));

			const second = setup({uuid});
			expect(second.client.findChannel("bob")).to.equal(undefined);
			expect(second.client.queryLog.names()).to.deep.equal([]);
		});

		it("the user's /query forgets the close", function () {
			const h = closedQuery();
			h.client.input(h.client.lobby.id, "/query bob");
			expect(h.client.closed.suppresses("bob", new Date(T0))).to.equal(false);
		});

		it("matches the nick by the network's casemapping", function () {
			const h = closedQuery("Bob");
			bouncerReplay(h, "bob", [`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`]);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});
	});

	describe("the tombstone model", function () {
		const NOW = Date.parse("2026-08-28T12:00:00.000Z");

		afterEach(function () {
			useStorageBackend(null);
		});

		it("round-trips through the wire form", function () {
			const entries = [
				{nick: "bob", at: NOW - 1000},
				{nick: "[c]arol", at: NOW - 5000},
			];
			expect(decodeClosed(encodeClosed(entries, 300, NOW))).to.deep.equal(entries);
		});

		it("keeps the newest entries within the byte limit", function () {
			const entries = Array.from({length: 40}, (_, i) => ({
				nick: `nick${i}`,
				at: NOW - i * 1000,
			}));
			const value = encodeClosed(entries, 300, NOW);
			expect(new TextEncoder().encode(value).length).to.be.at.most(300);
			const kept = decodeClosed(value);
			expect(kept[0]).to.deep.equal(entries[0]);
			expect(kept).to.deep.equal(entries.slice(0, kept.length));
			expect(kept.length).to.be.greaterThan(5);
		});

		it("drops entries older than the TTL", function () {
			const value = encodeClosed(
				[
					{nick: "old", at: NOW - CLOSED_TTL_MS - 1},
					{nick: "new", at: NOW - 1},
				],
				300,
				NOW
			);
			expect(decodeClosed(value).map((e) => e.nick)).to.deep.equal(["new"]);
		});

		it("skips malformed items", function () {
			expect(decodeClosed("x:zz bad ::")).to.deep.equal([
				{nick: "x", at: parseInt("zz", 36)},
			]);
		});

		it("merges by keeping the newer close per nick", function () {
			expect(
				mergeClosed(
					[
						{nick: "bob", at: 5},
						{nick: "carol", at: 9},
					],
					[
						{nick: "bob", at: 7},
						{nick: "dave", at: 1},
					]
				)
			).to.deep.equal([
				{nick: "carol", at: 9},
				{nick: "bob", at: 7},
				{nick: "dave", at: 1},
			]);
		});

		it("suppresses a line at the tombstone's time but not one after it", function () {
			const closed = new ClosedQueries("net-a", (s) => s.toLowerCase());
			closed.close("Bob", NOW);
			expect(closed.suppresses("bob", new Date(NOW))).to.equal(true);
			expect(closed.suppresses("BOB", new Date(NOW + 1))).to.equal(false);
			expect(closed.suppresses("carol", new Date(0))).to.equal(false);
		});

		it("forgets a tombstone the user reopened", function () {
			const closed = new ClosedQueries("net-b", (s) => s.toLowerCase());
			closed.close("bob", NOW);
			closed.reopen("Bob");
			expect(closed.suppresses("bob", new Date(0))).to.equal(false);
		});

		it("keeps tombstones per network across instances", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			new ClosedQueries("net-c", (s) => s).close("bob", NOW);
			expect(new ClosedQueries("net-c", (s) => s).suppresses("bob", new Date(NOW))).to.equal(
				true
			);
			expect(new ClosedQueries("net-d", (s) => s).suppresses("bob", new Date(NOW))).to.equal(
				false
			);
		});

		it("removing the network forgets its tombstones", function () {
			const closed = new ClosedQueries("net-f", (s) => s);
			closed.close("bob", NOW);
			saved.remove("net-f");
			expect(closed.entries()).to.deep.equal([]);
		});

		it("adopts only entries newer than the ones held, and reports them", function () {
			const closed = new ClosedQueries("net-e", (s) => s.toLowerCase());
			closed.close("bob", NOW - 10);
			expect(
				closed.adopt([
					{nick: "BOB", at: NOW - 50},
					{nick: "carol", at: NOW - 70},
				])
			).to.deep.equal([{nick: "carol", at: NOW - 70}]);
			expect(closed.entries()).to.deep.equal([
				{nick: "bob", at: NOW - 10},
				{nick: "carol", at: NOW - 70},
			]);
		});
	});
});
