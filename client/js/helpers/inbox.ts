// The inbox: the messages that mentioned you and are not read yet, kept per
// device but built from what the server gives every device (live lines, the
// catch-up, read markers), so every device arrives at the same list. See
// docs/projects/inbox.md.
//
// Vue-free and store-free: the store glue is client/js/mentions.ts.

import type {InboxEntry} from "../../../shared/types/mention";
import {MessageType, type SharedMsg} from "../../../shared/types/msg";

export type {InboxEntry};

/** How many entries a device keeps; the oldest go first. */
export const MAX_ENTRIES = 100;

/**
 * The entry's identity: its msgid, or what identifies the message on a
 * server without `message-tags`. Never a session-local id (irc/ids.ts).
 */
export function entryKey(entry: InboxEntry): string {
	if (entry.msgid) {
		return `${entry.network}/${entry.msgid}`;
	}

	return [entry.network, entry.target.toLowerCase(), entry.time, entry.from.nick ?? ""].join("/");
}

/** The entry for `msg`, said in `target` on `network`; null for our own or a sourceless line. */
export function entryFor(network: string, target: string, msg: SharedMsg): InboxEntry | null {
	if (msg.self || !msg.from?.nick) {
		return null;
	}

	return {
		network,
		target,
		...(msg.msgid ? {msgid: msg.msgid} : {}),
		time: new Date(msg.time).toISOString(),
		type: msg.type ?? MessageType.MESSAGE,
		text: msg.text ?? "",
		from: msg.from,
	};
}

function sameTarget(entry: InboxEntry, network: string, target: string): boolean {
	return entry.network === network && entry.target.toLowerCase() === target.toLowerCase();
}

/** Add `added`, deduplicated by key, ordered by time, the newest {@link MAX_ENTRIES} kept. */
export function addEntries(
	list: InboxEntry[],
	added: InboxEntry[],
	max = MAX_ENTRIES
): InboxEntry[] {
	const byKey = new Map<string, InboxEntry>();

	for (const entry of [...list, ...added]) {
		byKey.set(entryKey(entry), entry);
	}

	const merged = [...byKey.values()].sort(
		(a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
	);

	return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** `target` on `network` was read up to `time`: drop its entries at or before it. */
export function pruneRead(
	list: InboxEntry[],
	network: string,
	target: string,
	time: Date
): InboxEntry[] {
	const until = time.getTime();
	return list.filter(
		(entry) => !sameTarget(entry, network, target) || new Date(entry.time).getTime() > until
	);
}

/** Drop every entry of `target` on `network` (parted, closed). */
export function dropTarget(list: InboxEntry[], network: string, target: string): InboxEntry[] {
	return list.filter((entry) => !sameTarget(entry, network, target));
}

/** Drop every entry of `network` (removed). */
export function dropNetwork(list: InboxEntry[], network: string): InboxEntry[] {
	return list.filter((entry) => entry.network !== network);
}

/** Drop one entry by its key (a dismissal: this device only). */
export function dismiss(list: InboxEntry[], key: string): InboxEntry[] {
	return list.filter((entry) => entryKey(entry) !== key);
}

function isEntry(value: unknown): value is InboxEntry {
	if (!value || typeof value !== "object") {
		return false;
	}

	const entry = value as Record<string, unknown>;
	return (
		typeof entry.network === "string" &&
		typeof entry.target === "string" &&
		typeof entry.time === "string" &&
		!Number.isNaN(new Date(entry.time).getTime()) &&
		typeof entry.text === "string" &&
		!!entry.from &&
		typeof entry.from === "object"
	);
}

/**
 * The stored list. Entries in the old shape (session-local `chanId`/`msgId`,
 * which point nowhere after a reload) are dropped, not migrated.
 */
export function parseStored(raw: string | null | undefined): InboxEntry[] {
	if (!raw) {
		return [];
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
}
