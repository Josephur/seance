/**
 * Do not disturb: is it on now, and until when? The global state is a
 * manual switch (off, until a time, indefinite) and one daily window
 * (wall-clock start and end, a set of weekdays; a window that ends at or
 * before its start crosses midnight and belongs to the day it starts on).
 * Turning DND off inside a scheduled window skips the rest of that window.
 *
 * Vue-free, DOM-free, store-free: client/js/dnd.ts holds it, mocha tests it.
 * See docs/projects/do-not-disturb.md.
 */

import type {SharedPresenceMode} from "../../../shared/types/network";

export type PresenceMode = SharedPresenceMode;
export const PRESENCE_MODES: readonly PresenceMode[] = ["online", "auto", "away", "dnd"];

export interface DndSchedule {
	enabled: boolean;
	/** "HH:MM", local time. */
	start: string;
	/** "HH:MM"; at or before `start` means the window crosses midnight. */
	end: string;
	/** 0 = Sunday … 6 = Saturday: the day a window starts on. */
	days: number[];
}

export type DndManual =
	| {kind: "off"}
	/** `span`: the length picked (ms, "For 1 hour"), so the menu can tick it. */
	| {kind: "until"; until: number; span?: number}
	| {kind: "indefinite"};

/**
 * Global away (docs/projects/shared-presence-modes.md § 2): every network
 * away while on, each keeping its own mode. `at` is the Unix ms of the
 * user's last choice (null if never chosen); shared between devices, the
 * most recent choice winning.
 */
export interface GlobalAway {
	on: boolean;
	at: number | null;
}

export interface DndState {
	manual: DndManual;
	schedule: DndSchedule;
	/** Off pressed inside a window: that window's end (ms); ignored before it. */
	scheduleSkippedUntil: number | null;
	away: GlobalAway;
}

export interface DndVerdict {
	active: boolean;
	/** Epoch ms DND ends; null while off or when indefinite. */
	until: number | null;
	source: "manual" | "schedule" | null;
}

const OFF: DndVerdict = {active: false, until: null, source: null};
/** A schedule time as stored: "HH:MM", 24-hour. */
export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultDndState(): DndState {
	return {
		manual: {kind: "off"},
		schedule: {enabled: false, start: "23:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6]},
		scheduleSkippedUntil: null,
		away: {on: false, at: null},
	};
}

function minutesOf(hhmm: string): number {
	const m = HHMM.exec(hhmm);
	return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** The window that starts on the local day of `day` (any time that day). */
function windowStartingOn(schedule: DndSchedule, day: Date): {start: number; end: number} {
	const s = minutesOf(schedule.start);
	const e = minutesOf(schedule.end);
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, s);
	const endDay = e <= s ? day.getDate() + 1 : day.getDate();
	const end = new Date(day.getFullYear(), day.getMonth(), endDay, 0, e);
	return {start: start.getTime(), end: end.getTime()};
}

function scheduleOn(schedule: DndSchedule): boolean {
	return schedule.enabled && schedule.days.length > 0;
}

export function windowAt(schedule: DndSchedule, now: Date): {start: number; end: number} | null {
	if (!scheduleOn(schedule)) {
		return null;
	}

	const t = now.getTime();

	// Today's window, or yesterday's that crosses midnight.
	for (const offset of [0, -1]) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

		if (!schedule.days.includes(day.getDay())) {
			continue;
		}

		const w = windowStartingOn(schedule, day);

		if (t >= w.start && t < w.end) {
			return w;
		}
	}

	return null;
}

export function nextWindow(schedule: DndSchedule, now: Date): {start: number; end: number} | null {
	if (!scheduleOn(schedule)) {
		return null;
	}

	for (let offset = 0; offset <= 7; offset++) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

		if (!schedule.days.includes(day.getDay())) {
			continue;
		}

		const w = windowStartingOn(schedule, day);

		if (w.start > now.getTime()) {
			return w;
		}
	}

	return null;
}

export function dndAt(state: DndState, now: Date): DndVerdict {
	const t = now.getTime();
	const m = state.manual;

	if (m.kind === "indefinite") {
		return {active: true, until: null, source: "manual"};
	}

	if (m.kind === "until" && m.until > t) {
		return {active: true, until: m.until, source: "manual"};
	}

	const w = windowAt(state.schedule, now);

	if (w && !(state.scheduleSkippedUntil !== null && state.scheduleSkippedUntil >= w.end)) {
		return {active: true, until: w.end, source: "schedule"};
	}

	return OFF;
}

export function turnOff(state: DndState, now: Date): DndState {
	const w = windowAt(state.schedule, now);
	return {
		...state,
		manual: {kind: "off"},
		scheduleSkippedUntil: w ? w.end : state.scheduleSkippedUntil,
	};
}

function asManual(raw: unknown): DndManual | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const r = raw as Record<string, unknown>;

	if (r.kind === "off" || r.kind === "indefinite") {
		return {kind: r.kind};
	}

	if (r.kind === "until" && typeof r.until === "number" && Number.isFinite(r.until)) {
		return typeof r.span === "number" && Number.isFinite(r.span) && r.span > 0
			? {kind: "until", until: r.until, span: r.span}
			: {kind: "until", until: r.until};
	}

	return undefined;
}

function asSchedule(raw: unknown): DndSchedule | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const r = raw as Record<string, unknown>;

	if (
		typeof r.enabled !== "boolean" ||
		typeof r.start !== "string" ||
		!HHMM.test(r.start) ||
		typeof r.end !== "string" ||
		!HHMM.test(r.end) ||
		!Array.isArray(r.days)
	) {
		return undefined;
	}

	const days = [...new Set(r.days)]
		.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
		.sort((a, b) => a - b);
	return {enabled: r.enabled, start: r.start, end: r.end, days};
}

function asAway(raw: unknown): GlobalAway | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const r = raw as Record<string, unknown>;

	if (typeof r.on !== "boolean") {
		return undefined;
	}

	if (r.at === null) {
		return {on: r.on, at: null};
	}

	return typeof r.at === "number" && Number.isSafeInteger(r.at) && r.at > 0
		? {on: r.on, at: r.at}
		: undefined;
}

export function parseDndState(raw: string | null): DndState {
	if (!raw) {
		return defaultDndState();
	}

	try {
		const v = JSON.parse(raw) as Record<string, unknown> | null;

		if (!v || typeof v !== "object") {
			return defaultDndState();
		}

		const def = defaultDndState();
		// One bad half resets only itself.
		const manual = asManual(v.manual) ?? def.manual;
		const schedule = asSchedule(v.schedule) ?? def.schedule;
		const skipped =
			typeof v.scheduleSkippedUntil === "number" && Number.isFinite(v.scheduleSkippedUntil)
				? v.scheduleSkippedUntil
				: null;
		const away = asAway(v.away) ?? def.away;
		return {manual, schedule, scheduleSkippedUntil: skipped, away};
	} catch {
		return defaultDndState();
	}
}

export function serializeDndState(state: DndState): string {
	return JSON.stringify(state);
}

/**
 * A schedule edit. Off pressed inside a window skips the rest of it; the skip
 * survives an edit that leaves the window current now as it was (another
 * weekday, a time outside it) and is dropped by one that changes it: the
 * user moved tonight's window, so it holds afresh.
 */
export function editSchedule(state: DndState, schedule: DndSchedule, now: Date): DndState {
	const before = windowAt(state.schedule, now);
	const after = windowAt(schedule, now);
	const same =
		before === after ||
		(before !== null &&
			after !== null &&
			before.start === after.start &&
			before.end === after.end);
	return {...state, schedule, scheduleSkippedUntil: same ? state.scheduleSkippedUntil : null};
}

/** Another device turned the shared DND off: do the same here, if it is on. */
export function reconcileRemote(state: DndState, now: Date): DndState {
	return dndAt(state, now).active ? turnOff(state, now) : state;
}

/** Short weekday names, Sunday = 0 (DndSchedule.days). */
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Full weekday names, Sunday = 0, for accessible names. */
export const DAY_FULL_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/** A wall-clock time as the clock setting writes it: "07:05" or "7:05 AM". */
export function clockText(h: number, m: number, hour12: boolean): string {
	const mm = String(m).padStart(2, "0");
	return hour12
		? `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`
		: `${String(h).padStart(2, "0")}:${mm}`;
}

/** A schedule's "HH:MM" by the clock setting; anything else as it is. */
export function scheduleTimeText(hhmm: string, hour12: boolean): string {
	const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
	return match ? clockText(Number(match[1]), Number(match[2]), hour12) : hhmm;
}

/** The pill's words while DND is on, from the verdict. */
export function describeDnd(verdict: DndVerdict, now: Date, hour12: boolean): string {
	if (verdict.until === null) {
		return "Do not disturb";
	}

	const end = new Date(verdict.until);
	const time = clockText(end.getHours(), end.getMinutes(), hour12);
	const sameDay = end.toDateString() === now.toDateString();
	return `Do not disturb · until ${sameDay ? "" : `${DAYS[end.getDay()]} `}${time}`;
}

/**
 * When the verdict can next change on its own: the end of the DND in force,
 * the next window's start, or at the latest the next minute boundary (a
 * window's edges are whole minutes, the pill's clock too). Epoch ms.
 */
export function nextChangeAt(state: DndState, now: Date): number {
	const t = now.getTime();
	const minute = Math.floor(t / 60_000) * 60_000 + 60_000;
	const candidates = [minute];
	const verdict = dndAt(state, now);

	if (verdict.until !== null && verdict.until > t) {
		candidates.push(verdict.until);
	}

	if (state.manual.kind === "until" && state.manual.until > t) {
		candidates.push(state.manual.until);
	}

	const next = nextWindow(state.schedule, now);

	if (next) {
		candidates.push(next.start);
	}

	return Math.min(...candidates);
}

/** What every network's presence mode says together; `mixed` when they differ. */
export type PresenceSummary = PresenceMode | "mixed";

export function presenceSummary(modes: PresenceMode[]): PresenceSummary {
	const set = new Set(modes);

	if (set.size === 0) {
		return "auto";
	}

	return set.size === 1 ? modes[0] : "mixed";
}

/** The pill's words for a summary, while no do not disturb of the page's own is on. */
export const SUMMARY_LABELS: Record<PresenceSummary, string> = {
	auto: "Online · auto",
	online: "Online",
	away: "Away",
	dnd: "Do not disturb",
	mixed: "Mixed",
};

/** What the pill says and ticks: do not disturb outranks global away. */
export type PillStatus = "available" | "away" | "dnd";

export function pillStatus(state: DndState, now: Date): PillStatus {
	if (dndAt(state, now).active) {
		return "dnd";
	}

	return state.away.on ? "away" : "available";
}
