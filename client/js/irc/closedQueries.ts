/**
 * A closed private conversation stays closed (docs/projects/closed-queries.md).
 *
 * Closing a query leaves a tombstone: the casefolded nick, the boundary — the
 * time of the newest line the server sent in that window (a line with a
 * msgid; never one this device made, whose time is the device clock's) — and
 * the moment of the close. A line at or before the boundary never opens a
 * window again — the server's catch-up after a reconnect, an unwrapped
 * replay, another device's query log — while a later line does, as it would
 * have anyway: closing hides a conversation, it does not block a person. The
 * user's `/query` is a reopen: an event of its own that outranks an older
 * close, here and on the account's other devices. Each nick keeps only its
 * newest event. Nothing dated after now (plus a minute of skew) is taken:
 * neither a close made on a clock that runs ahead nor a value written to
 * silence a nick.
 *
 * Kept per network in `thelounge.state.closedQueries` (never in the settings
 * backup) and shared with the account's other devices as the private
 * metadata key {@link CLOSED_KEY}, whose value is {@link encodeClosed}'s wire
 * form: `nick:<boundary>[+<seconds after it the close was made>]` for a close
 * and `nick:!<reopen time>` for a reopen (times in base-36 ms), newest first,
 * cut to the server's `max-value-bytes` (nefarious2 offers 300) and to
 * {@link CLOSED_TTL_MS}. With private conversations not kept on this device
 * (`keepPrivateConversations` off) the tombstones live in memory only and are
 * never shared, and turning it off deletes both copies
 * ({@link setClosedQueriesKept}). Private metadata is still readable by the
 * network's IRC operators. Vue-free and DOM-free; tests:
 * test/irc/closedQueries.ts.
 */

import storage from "../localStorage";
import {recordReader} from "../helpers/jsonRecord";
import type {IrcClient} from "./client";
import {ChanType} from "../../../shared/types/chan";

export const CLOSED_KEY = "seance/closed";
/** An event older than this is dropped: no replay reaches that far back. */
export const CLOSED_TTL_MS = 30 * 24 * 3600 * 1000;
/** How far ahead of this device's clock an entry may be dated and still be taken. */
const CLOSED_SKEW_MS = 60_000;
/** How far after this device's clock its own close's boundary may be: the
 * boundary is the server's time (a line's), which a device clock running
 * behind can trail by minutes. Only the account's values, which anyone who
 * can set its metadata could write, keep to the minute. */
const CLOSED_LOCAL_SKEW_MS = 15 * 60_000;
/** Where the tombstones live on this device (the `storage` event names it). */
export const CLOSED_STORAGE_KEY = "thelounge.state.closedQueries";

export interface ClosedEntry {
	/** Casefolded nick. */
	nick: string;
	/** Unix ms: a close's boundary, the server time of the newest line the window held (0 for a reopen). */
	at: number;
	/** Unix ms: when the close or reopen was made; the newer event per nick wins. */
	when: number;
	/** A reopen: suppresses nothing, outranks an older close. */
	open?: true;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;
let kept = true;
/** The tombstones of a page that keeps no private conversations: memory only. */
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
	get: (k) => memory.get(k) ?? null,
	set: (k, v) => void memory.set(k, v),
	remove: (k) => void memory.delete(k),
};
const store = () => (kept ? backend : memoryBackend);
const readRecord = recordReader<ClosedEntry[]>();
/** What stops the sharing on the connected networks (manager.ts registers it). */
let onStop: (() => void) | null = null;
/** Networks whose shared list this device has deleted since sharing stopped. */
const UNSHARED_KEY = "thelounge.state.closedUnshared";

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/**
 * The user's `keepPrivateConversations`. Off: tombstones are held in memory
 * for this page only and never shared; the stored copy is deleted, and every
 * connected client deletes the account's shared list.
 */
export function setClosedQueriesKept(on: boolean): void {
	if (on === kept) {
		return;
	}

	kept = on;
	memory.clear();

	if (on) {
		backend.remove(UNSHARED_KEY);
		return;
	}

	backend.remove(CLOSED_STORAGE_KEY);
	onStop?.();
}

/** Register what deletes the account's list on the connected networks when sharing stops. */
export function onClosedSharingStopped(fn: (() => void) | null): void {
	onStop = fn;
}

function unshared(): string[] {
	try {
		const list: unknown = JSON.parse(backend.get(UNSHARED_KEY) ?? "[]");
		return Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Sharing is off and this network's list has not been deleted from here yet:
 * its next login read deletes it (a network that was down when the setting
 * changed, or a setting off before this device ever ran this code).
 */
export function closedUnshareDue(uuid: string): boolean {
	return !kept && !unshared().includes(uuid);
}

/** This network's shared list was deleted from here. */
export function markClosedUnshared(uuid: string): void {
	const list = unshared();

	if (!list.includes(uuid)) {
		backend.set(UNSHARED_KEY, JSON.stringify([...list, uuid]));
	}
}

/** Closes are kept on this device and shared with the account's others. */
export function closedQueriesKept(): boolean {
	return kept;
}

const newestFirst = (a: ClosedEntry, b: ClosedEntry) => b.when - a.when || b.at - a.at;
const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Not expired, and dated no later than `skew` after now. */
const live = (e: ClosedEntry, now: number, skew = CLOSED_LOCAL_SKEW_MS) =>
	e.when >= now - CLOSED_TTL_MS && e.when <= now + skew && e.at <= now + skew;

function item(e: ClosedEntry): string {
	if (e.open) {
		return `${e.nick}:!${e.when.toString(36)}`;
	}

	const after = Math.max(0, e.when - e.at);
	return `${e.nick}:${e.at.toString(36)}${after > 0 ? `+${after.toString(36)}` : ""}`;
}

/** The wire form: newest first, none expired, at most `maxBytes` of UTF-8. */
export function encodeClosed(entries: ClosedEntry[], maxBytes: number, now: number): string {
	const items = entries
		.filter((e) => live(e, now))
		.sort(newestFirst)
		.map(item);

	while (items.length > 0 && bytes(items.join(" ")) > maxBytes) {
		items.pop();
	}

	return items.join(" ");
}

/**
 * Read the wire form (a close made at its boundary carries no offset),
 * skipping anything malformed, expired or dated after now.
 */
export function decodeClosed(value: string, now: number): ClosedEntry[] {
	const out: ClosedEntry[] = [];

	for (const raw of value.split(" ")) {
		const colon = raw.lastIndexOf(":");
		const nick = raw.slice(0, colon);
		const rest = raw.slice(colon + 1);

		if (colon <= 0 || !/^(!?[0-9a-z]+|[0-9a-z]+(\+[0-9a-z]+)?)$/.test(rest)) {
			continue;
		}

		let entry: ClosedEntry;

		if (rest.startsWith("!")) {
			entry = {nick, at: 0, when: parseInt(rest.slice(1), 36), open: true};
		} else {
			const [boundary, after] = rest.split("+");
			const at = parseInt(boundary, 36);
			entry = {nick, at, when: at + (after ? parseInt(after, 36) : 0)};
		}

		if (
			Number.isFinite(entry.at) &&
			Number.isFinite(entry.when) &&
			live(entry, now, CLOSED_SKEW_MS)
		) {
			out.push(entry);
		}
	}

	return out;
}

/** One entry per nick, its newer event winning (a close on a tie); newest first. */
export function mergeClosed(a: ClosedEntry[], b: ClosedEntry[]): ClosedEntry[] {
	const byNick = new Map<string, ClosedEntry>();

	for (const e of [...a, ...b]) {
		const held = byNick.get(e.nick);

		if (!held || e.when > held.when || (e.when === held.when && held.open && !e.open)) {
			byNick.set(e.nick, e);
		}
	}

	return [...byNick.values()].sort(newestFirst);
}

function readAll(): Record<string, ClosedEntry[]> {
	return readRecord(store().get(CLOSED_STORAGE_KEY));
}

/** Drop a network's tombstones (the network was removed). */
export function forgetClosedQueries(uuid: string): void {
	const all = {...readAll()};

	if (uuid in all) {
		delete all[uuid];
		store().set(CLOSED_STORAGE_KEY, JSON.stringify(all));
	}
}

/** One network's tombstones. */
export class ClosedQueries {
	readonly uuid: string;
	private readonly fold: (nick: string) => string;

	/** `unshare`: delete the account's shared list (called when sharing stops). */
	constructor(uuid: string, fold: (nick: string) => string) {
		this.uuid = uuid;
		this.fold = fold;
	}

	/** The events held, newest first (read fresh: another tab may have written). */
	entries(): ClosedEntry[] {
		const list = readAll()[this.uuid];

		if (!Array.isArray(list)) {
			return [];
		}

		return list.filter(
			(e) =>
				typeof e?.nick === "string" &&
				typeof e?.at === "number" &&
				typeof e?.when === "number"
		);
	}

	/** The query with `nick` was closed; the newest line the server sent in it was at `at`. */
	close(nick: string, at: number): void {
		const key = this.fold(nick);
		// The server's clock may run ahead of this device's: a boundary up to
		// the local allowance past now is the server's, not a lie.
		const boundary = Math.min(at, Date.now() + CLOSED_LOCAL_SKEW_MS);
		const when = Math.max(this.after(key), boundary);
		this.write(mergeClosed(this.entries(), [{nick: key, at: boundary, when}]));
	}

	/**
	 * The user opened the query again (`/query`): a reopen outranking the
	 * close. Recorded when a close is held, or when `unknown` — this
	 * connection will read the account's list but has not yet, so a close may
	 * still arrive. Returns whether anything was recorded (and so is worth writing).
	 */
	reopen(nick: string, unknown = false): boolean {
		const key = this.fold(nick);
		const held = this.entries().find((e) => e.nick === key);

		if (held?.open || (!held && !unknown)) {
			return false;
		}

		this.write(
			mergeClosed(this.entries(), [{nick: key, at: 0, when: this.after(key), open: true}])
		);
		return true;
	}

	/** A local event's time: now, and always after the nick's last event here. */
	private after(key: string): number {
		const last = this.entries().find((e) => e.nick === key)?.when ?? 0;
		return Math.max(Date.now(), last + 1);
	}

	/** A line from `nick` at `time` belongs to a conversation closed since. */
	suppresses(nick: string, time: Date): boolean {
		const key = this.fold(nick);
		const entry = this.entries().find((e) => e.nick === key);
		return entry !== undefined && !entry.open && time.getTime() <= entry.at;
	}

	/** Take another device's events; returns those that now stand for their nick. */
	adopt(incoming: ClosedEntry[]): ClosedEntry[] {
		const held = this.entries();
		const merged = mergeClosed(
			held,
			incoming.map((e) => ({...e, nick: this.fold(e.nick)}))
		);
		const fresh = merged.filter((e) => !held.includes(e));

		if (fresh.length > 0) {
			this.write(merged);
		}

		return fresh;
	}

	private write(list: ClosedEntry[]): void {
		const all = {...readAll()};
		const now = Date.now();
		const alive = list.filter((e) => live(e, now));

		if (alive.length > 0) {
			all[this.uuid] = alive;
		} else {
			delete all[this.uuid];
		}

		store().set(CLOSED_STORAGE_KEY, JSON.stringify(all));
	}
}

/**
 * Closes that arrived after the windows did (another device's, read after
 * registration; another tab's): a query this client opened by itself whose
 * newest line from the server is at or before the boundary goes. One the
 * user opened, read or wrote in stays — this never closes what the user is
 * looking at. A reopen closes nothing.
 */
function applyClosed(client: IrcClient, entries: ClosedEntry[]): void {
	for (const entry of entries) {
		const chan = client.findChannel(entry.nick);

		if (
			!entry.open &&
			chan?.type === ChanType.QUERY &&
			chan.autoOpened &&
			(chan.newestServerAt ?? 0) <= entry.at
		) {
			client.removeChannel(chan);
		}
	}
}

/**
 * The account's {@link CLOSED_KEY} value (handlers/metadata.ts): adopted, and
 * applied to the windows. `read` is true for the answer to this connection's
 * GET (761/766) — only that lets a close be written, since a notification,
 * the before-connect burst among them, can come from a stale copy and a write
 * after it could drop another device's newer event.
 */
export function onClosedValue(client: IrcClient, value: string, read: boolean): void {
	applyClosed(client, client.closed.adopt(decodeClosed(value, Date.now())));

	// Sharing is off and this network still has a list from before: delete
	// it once (closedUnshareDue).
	if (read && closedUnshareDue(client.uuid)) {
		if (value) {
			client.unshareClosed();
		} else {
			markClosedUnshared(client.uuid);
		}
	}

	if (read) {
		client.closedKnown = true;

		if (client.closedPending) {
			client.writeClosed();
		}
	}
}

/** Another tab wrote {@link CLOSED_STORAGE_KEY} (manager.ts's `storage` listener). */
export function closedStorageChanged(clients: IrcClient[]): void {
	for (const client of clients) {
		applyClosed(client, client.closed.entries());
	}
}
