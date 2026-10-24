import {expect} from "chai";
import {
	MAX_ENTRIES,
	addEntries,
	badgeCount,
	dismiss,
	dropNetwork,
	dropTarget,
	entryFor,
	entryKey,
	groupByConversation,
	parseStored,
	pruneRead,
	type InboxEntry,
} from "../../client/js/helpers/inbox";
import {MessageType, type SharedMsg} from "../../shared/types/msg";

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
	return {
		network: "net-1",
		target: "#seance",
		msgid: "m1",
		time: "2026-10-23T12:00:00.000Z",
		type: MessageType.MESSAGE,
		text: "alice: hi",
		from: {nick: "bob", mode: ""},
		...over,
	};
}

describe("helpers/inbox.ts", function () {
	describe("entryKey", function () {
		it("is the network and msgid when there is one", function () {
			expect(entryKey(entry())).to.equal("net-1/m1");
		});

		it("is network, target, time and nick without a msgid", function () {
			expect(entryKey(entry({msgid: undefined, target: "#Seance"}))).to.equal(
				"net-1/#seance/2026-10-23T12:00:00.000Z/bob"
			);
		});
	});

	describe("entryFor", function () {
		const msg = {
			id: 7,
			time: new Date("2026-10-23T12:00:00.000Z"),
			text: "alice: hi",
			msgid: "m1",
			from: {nick: "bob", mode: ""},
			type: MessageType.MESSAGE,
			users: [],
		} as unknown as SharedMsg;

		it("keeps what survives a reload, never the session-local id", function () {
			const made = entryFor("net-1", "#seance", msg)!;
			expect(made).to.deep.equal(entry());
			expect(made).to.not.have.property("id");
		});

		it("makes nothing of our own line or a line without a sender", function () {
			expect(entryFor("net-1", "#seance", {...msg, self: true})).to.equal(null);
			expect(entryFor("net-1", "#seance", {...msg, from: undefined})).to.equal(null);
		});
	});

	describe("addEntries", function () {
		it("deduplicates by key and orders by time", function () {
			const a = entry({msgid: "a", time: "2026-10-23T12:02:00.000Z"});
			const b = entry({msgid: "b", time: "2026-10-23T12:01:00.000Z"});
			const list = addEntries([a], [b, {...a, text: "again"}]);
			expect(list.map((e) => e.msgid)).to.deep.equal(["b", "a"]);
			expect(list[1].text).to.equal("again");
		});

		it("keeps the newest entries", function () {
			const many = Array.from({length: MAX_ENTRIES + 5}, (_, i) =>
				entry({msgid: `m${i}`, time: new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString()})
			);
			const list = addEntries([], many);
			expect(list).to.have.length(MAX_ENTRIES);
			expect(list[0].msgid).to.equal("m5");
		});
	});

	describe("pruneRead", function () {
		it("drops the target's entries at or before the time, case-insensitively", function () {
			const list = [
				entry({msgid: "old", time: "2026-10-23T12:00:00.000Z"}),
				entry({msgid: "at", time: "2026-10-23T12:01:00.000Z"}),
				entry({msgid: "new", time: "2026-10-23T12:02:00.000Z"}),
				entry({msgid: "other", target: "#other", time: "2026-10-23T11:00:00.000Z"}),
				entry({msgid: "elsewhere", network: "net-2", time: "2026-10-23T11:00:00.000Z"}),
			];
			const left = pruneRead(list, "net-1", "#SEANCE", new Date("2026-10-23T12:01:00.000Z"));
			expect(left.map((e) => e.msgid)).to.deep.equal(["new", "other", "elsewhere"]);
		});
	});

	describe("dropping", function () {
		const list = [
			entry({msgid: "a"}),
			entry({msgid: "b", target: "#other"}),
			entry({msgid: "c", network: "net-2"}),
		];

		it("drops a target, a network or one entry", function () {
			expect(dropTarget(list, "net-1", "#seance").map((e) => e.msgid)).to.deep.equal([
				"b",
				"c",
			]);
			expect(dropNetwork(list, "net-1").map((e) => e.msgid)).to.deep.equal(["c"]);
			expect(dismiss(list, "net-1/b").map((e) => e.msgid)).to.deep.equal(["a", "c"]);
		});
	});

	describe("parseStored", function () {
		it("reads what it wrote", function () {
			expect(parseStored(JSON.stringify([entry()]))).to.deep.equal([entry()]);
		});

		it("drops entries in the old shape and anything unreadable", function () {
			const old = {
				chanId: 3,
				msgId: 9,
				type: "message",
				time: "2026-10-23T12:00:00.000Z",
				text: "hi",
				from: {nick: "bob"},
			};
			expect(parseStored(JSON.stringify([old, entry()]))).to.deep.equal([entry()]);
			expect(parseStored("{not json")).to.deep.equal([]);
			expect(parseStored(JSON.stringify({}))).to.deep.equal([]);
			expect(parseStored(null)).to.deep.equal([]);
		});
	});

	describe("groupByConversation", function () {
		it("groups by conversation, newest conversation first, each oldest first", function () {
			const list = [
				entry({msgid: "a1", target: "#a", time: "2026-10-23T12:00:00.000Z"}),
				entry({msgid: "b1", target: "#b", time: "2026-10-23T12:01:00.000Z"}),
				entry({msgid: "a2", target: "#A", time: "2026-10-23T12:03:00.000Z"}),
				entry({msgid: "a0", target: "#a", time: "2026-10-23T11:00:00.000Z"}),
				entry({
					msgid: "c1",
					network: "net-2",
					target: "#a",
					time: "2026-10-23T12:02:00.000Z",
				}),
			];
			const groups = groupByConversation(list);
			expect(groups.map((g) => g.key)).to.deep.equal(["net-1/#a", "net-2/#a", "net-1/#b"]);
			expect(groups[0].entries.map((e) => e.msgid)).to.deep.equal(["a0", "a1", "a2"]);
		});
	});

	it("badgeCount caps at 99+", function () {
		expect(badgeCount(7)).to.equal("7");
		expect(badgeCount(99)).to.equal("99");
		expect(badgeCount(100)).to.equal("99+");
	});
});
