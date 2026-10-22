/**
 * A closed private conversation stays closed (docs/projects/closed-queries.md).
 *
 * Closing a query leaves a tombstone: the casefolded nick and the server time
 * of the newest line the window held (never the device clock, so a skewed
 * clock cannot swallow a later message). A line at or before the tombstone
 * never opens a window again — the server's catch-up after a reconnect, an
 * unwrapped replay, another device's query log — while a later line does, as
 * it would have anyway: closing hides a conversation, it does not block a
 * person. The user's own `/query` forgets the tombstone here.
 *
 * Kept per network in `thelounge.state.closedQueries` (never in the settings
 * backup) and shared with the account's other devices as the private
 * metadata key {@link CLOSED_KEY}, whose value is {@link encodeClosed}'s wire
 * form: `nick:<close time in base-36 ms>` items, newest first, cut to the
 * server's `max-value-bytes` (nefarious2 offers 300) and to
 * {@link CLOSED_TTL_MS}. Vue-free and DOM-free; tests:
 * test/irc/closedQueries.ts.
 */

import storage from "../localStorage";

export const CLOSED_KEY = "seance/closed";
/** A close older than this is dropped: no replay reaches that far back. */
export const CLOSED_TTL_MS = 30 * 24 * 3600 * 1000;
const STORAGE_KEY = "thelounge.state.closedQueries";

export interface ClosedEntry {
	/** Casefolded nick. */
	nick: string;
	/** Unix ms: the server time of the newest line the window held. */
	at: number;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

const newestFirst = (a: ClosedEntry, b: ClosedEntry) => b.at - a.at;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The wire form: newest first, none older than the TTL, at most `maxBytes` of UTF-8. */
export function encodeClosed(entries: ClosedEntry[], maxBytes: number, now: number): string {
	const items = entries
		.filter((e) => e.at >= now - CLOSED_TTL_MS)
		.sort(newestFirst)
		.map((e) => `${e.nick}:${e.at.toString(36)}`);

	while (items.length > 0 && bytes(items.join(" ")) > maxBytes) {
		items.pop();
	}

	return items.join(" ");
}

/** Read the wire form, skipping anything malformed. */
export function decodeClosed(value: string): ClosedEntry[] {
	const out: ClosedEntry[] = [];

	for (const item of value.split(" ")) {
		const colon = item.lastIndexOf(":");

		if (colon <= 0) {
			continue;
		}

		const at = parseInt(item.slice(colon + 1), 36);

		if (Number.isFinite(at) && at > 0) {
			out.push({nick: item.slice(0, colon), at});
		}
	}

	return out;
}

/** One entry per nick, the newer close winning; newest first. */
export function mergeClosed(a: ClosedEntry[], b: ClosedEntry[]): ClosedEntry[] {
	const byNick = new Map<string, number>();

	for (const e of [...a, ...b]) {
		byNick.set(e.nick, Math.max(byNick.get(e.nick) ?? 0, e.at));
	}

	return [...byNick].map(([nick, at]) => ({nick, at})).sort(newestFirst);
}

function readAll(): Record<string, ClosedEntry[]> {
	try {
		const parsed: unknown = JSON.parse(backend.get(STORAGE_KEY) ?? "{}");
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, ClosedEntry[]>)
			: {};
	} catch {
		return {};
	}
}

/** Drop a network's tombstones (the network was removed). */
export function forgetClosedQueries(uuid: string): void {
	const all = readAll();

	if (uuid in all) {
		delete all[uuid];
		backend.set(STORAGE_KEY, JSON.stringify(all));
	}
}

/** One network's tombstones. */
export class ClosedQueries {
	readonly uuid: string;
	private readonly fold: (nick: string) => string;

	constructor(uuid: string, fold: (nick: string) => string) {
		this.uuid = uuid;
		this.fold = fold;
	}

	/** The tombstones held, newest first (read fresh: another tab may have written). */
	entries(): ClosedEntry[] {
		const list = readAll()[this.uuid];
		return Array.isArray(list)
			? list.filter((e) => typeof e?.nick === "string" && typeof e?.at === "number")
			: [];
	}

	/** The query with `nick` was closed; its newest line was at `at`. */
	close(nick: string, at: number): void {
		this.write(mergeClosed(this.entries(), [{nick: this.fold(nick), at}]));
	}

	/** The user opened the query again (`/query`): forget its tombstone here. */
	reopen(nick: string): void {
		const key = this.fold(nick);
		const list = this.entries();

		if (list.some((e) => e.nick === key)) {
			this.write(list.filter((e) => e.nick !== key));
		}
	}

	/** A line from `nick` at `time` belongs to a conversation closed since. */
	suppresses(nick: string, time: Date): boolean {
		const key = this.fold(nick);
		const entry = this.entries().find((e) => e.nick === key);
		return entry !== undefined && time.getTime() <= entry.at;
	}

	/** Take another device's tombstones; returns those newer than the ones held. */
	adopt(incoming: ClosedEntry[]): ClosedEntry[] {
		const held = this.entries();
		const fresh = incoming
			.map((e) => ({nick: this.fold(e.nick), at: e.at}))
			.filter((e) => !held.some((h) => h.nick === e.nick && h.at >= e.at));

		if (fresh.length > 0) {
			this.write(mergeClosed(held, fresh));
		}

		return fresh;
	}

	private write(list: ClosedEntry[]): void {
		const all = readAll();
		const now = Date.now();
		const kept = list.filter((e) => e.at >= now - CLOSED_TTL_MS);

		if (kept.length > 0) {
			all[this.uuid] = kept;
		} else {
			delete all[this.uuid];
		}

		backend.set(STORAGE_KEY, JSON.stringify(all));
	}
}
