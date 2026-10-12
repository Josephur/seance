import {expect} from "chai";
import {
	defaultDndState,
	describeDnd,
	dndAt,
	nextWindow,
	parseDndState,
	reconcileRemote,
	scheduleTimeText,
	serializeDndState,
	turnOff,
	windowAt,
	type DndState,
} from "../../client/js/helpers/dnd";

// Local-time dates: the schedule is wall-clock time.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
// 2026-10-09 is a Friday (day 5), 2026-10-10 Saturday (6).
const FRI = 5;

function scheduled(days: number[], start = "23:00", end = "07:00"): DndState {
	const s = defaultDndState();
	s.schedule = {enabled: true, start, end, days};
	return s;
}

describe("do not disturb model (helpers/dnd.ts)", function () {
	it("is off by default", function () {
		expect(dndAt(defaultDndState(), at(2026, 10, 9, 23, 30))).to.deep.equal({
			active: false,
			until: null,
			source: null,
		});
	});

	it("manual until a time is on before it and off after it", function () {
		const s = defaultDndState();
		const until = at(2026, 10, 9, 13).getTime();
		s.manual = {kind: "until", until};
		expect(dndAt(s, at(2026, 10, 9, 12))).to.deep.equal({
			active: true,
			until,
			source: "manual",
		});
		expect(dndAt(s, at(2026, 10, 9, 13, 1)).active).to.equal(false);
	});

	it("manual indefinite has no end", function () {
		const s = defaultDndState();
		s.manual = {kind: "indefinite"};
		expect(dndAt(s, at(2026, 10, 9, 12))).to.deep.equal({
			active: true,
			until: null,
			source: "manual",
		});
	});

	it("a window crossing midnight belongs to the day it starts on", function () {
		const s = scheduled([FRI]);
		const end = at(2026, 10, 10, 7).getTime();
		expect(dndAt(s, at(2026, 10, 9, 23, 30))).to.deep.equal({
			active: true,
			until: end,
			source: "schedule",
		});
		// Saturday 01:00: still Friday's window, though Saturday is not ticked.
		expect(dndAt(s, at(2026, 10, 10, 1)).active).to.equal(true);
		expect(dndAt(s, at(2026, 10, 10, 7)).active).to.equal(false);
		// Thursday night is not ticked.
		expect(dndAt(s, at(2026, 10, 8, 23, 30)).active).to.equal(false);
	});

	it("a same-day window", function () {
		const s = scheduled([FRI], "12:00", "13:00");
		expect(dndAt(s, at(2026, 10, 9, 12, 30)).active).to.equal(true);
		expect(dndAt(s, at(2026, 10, 9, 13)).active).to.equal(false);
		expect(dndAt(s, at(2026, 10, 9, 11, 59)).active).to.equal(false);
	});

	it("a disabled schedule or no days is no schedule", function () {
		const s = scheduled([]);
		expect(dndAt(s, at(2026, 10, 9, 23, 30)).active).to.equal(false);
		const t = scheduled([FRI]);
		t.schedule.enabled = false;
		expect(dndAt(t, at(2026, 10, 9, 23, 30)).active).to.equal(false);
	});

	it("manual wins over the schedule while it is on", function () {
		const s = scheduled([FRI]);
		s.manual = {kind: "indefinite"};
		expect(dndAt(s, at(2026, 10, 9, 23, 30)).source).to.equal("manual");
	});

	it("turning off inside a window skips to its end, then the next window counts", function () {
		const s = turnOff(scheduled([0, 1, 2, 3, 4, 5, 6]), at(2026, 10, 9, 23, 30));
		expect(s.manual).to.deep.equal({kind: "off"});
		expect(s.scheduleSkippedUntil).to.equal(at(2026, 10, 10, 7).getTime());
		expect(dndAt(s, at(2026, 10, 10, 2)).active).to.equal(false);
		expect(dndAt(s, at(2026, 10, 10, 23, 30)).active).to.equal(true);
	});

	it("turning off outside a window skips nothing", function () {
		const s = scheduled([FRI]);
		s.manual = {kind: "indefinite"};
		const next = turnOff(s, at(2026, 10, 9, 12));
		expect(next.scheduleSkippedUntil).to.equal(null);
	});

	it("windowAt and nextWindow", function () {
		const s = scheduled([FRI]).schedule;
		expect(windowAt(s, at(2026, 10, 9, 12))).to.equal(null);
		expect(nextWindow(s, at(2026, 10, 9, 12))).to.deep.equal({
			start: at(2026, 10, 9, 23).getTime(),
			end: at(2026, 10, 10, 7).getTime(),
		});
		expect(nextWindow({...s, days: []}, at(2026, 10, 9, 12))).to.equal(null);
	});

	it("round-trips and survives garbage", function () {
		const s = scheduled([1, 2]);
		s.manual = {kind: "until", until: 123};
		expect(parseDndState(serializeDndState(s))).to.deep.equal(s);
		expect(parseDndState(null)).to.deep.equal(defaultDndState());
		expect(parseDndState("{nope")).to.deep.equal(defaultDndState());
		expect(
			parseDndState(JSON.stringify({manual: {kind: "until"}, schedule: {start: "25:99"}}))
		).to.deep.equal(defaultDndState());
	});

	it("a shared DND cleared elsewhere turns the local manual DND off", function () {
		const s = defaultDndState();
		s.manual = {kind: "indefinite"};
		const now = at(2026, 10, 9, 12);
		expect(reconcileRemote(s, now).manual).to.deep.equal({kind: "off"});
		const off = defaultDndState();
		expect(reconcileRemote(off, now)).to.equal(off);
		// A scheduled DND cleared elsewhere skips the rest of its window.
		const night = scheduled([FRI]);
		expect(reconcileRemote(night, at(2026, 10, 9, 23, 30)).scheduleSkippedUntil).to.equal(
			at(2026, 10, 10, 7).getTime()
		);
	});

	it("describes the state for the pill", function () {
		const now = at(2026, 10, 9, 22);
		expect(
			describeDnd(
				{active: true, until: at(2026, 10, 9, 23).getTime(), source: "manual"},
				now,
				false
			)
		).to.equal("Do not disturb · until 23:00");
		expect(
			describeDnd(
				{active: true, until: at(2026, 10, 10, 7).getTime(), source: "schedule"},
				now,
				false
			)
		).to.equal("Do not disturb · until Sat 07:00");
		expect(describeDnd({active: true, until: null, source: "manual"}, now, false)).to.equal(
			"Do not disturb"
		);
		expect(
			describeDnd(
				{active: true, until: at(2026, 10, 9, 23).getTime(), source: "manual"},
				now,
				true
			)
		).to.equal("Do not disturb · until 11:00 PM");
	});

	it("writes a schedule's times by the clock setting", function () {
		expect(scheduleTimeText("22:00", false)).to.equal("22:00");
		expect(scheduleTimeText("22:00", true)).to.equal("10:00 PM");
		expect(scheduleTimeText("07:05", true)).to.equal("7:05 AM");
		expect(scheduleTimeText("00:30", true)).to.equal("12:30 AM");
		expect(scheduleTimeText("12:00", true)).to.equal("12:00 PM");
		expect(scheduleTimeText("bad", true)).to.equal("bad");
	});
});
