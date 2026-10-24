// The inbox: the messages that mentioned you and are not read yet, kept per
// device but built from what the server gives every device (live lines, the
// catch-up, read markers), so every device arrives at the same list. See
// docs/projects/inbox.md.
//
// Vue-free and store-free: the store glue is client/js/mentions.ts.

import type {InboxEntry} from "../../../shared/types/mention";
import {MessageType, type SharedMsg} from "../../../shared/types/msg";
import {casefold} from "../irc/casemap";

/** How many entries a device keeps; the oldest go first. */
export const MAX_ENTRIES = 100;
/** How many of those one conversation may hold, so a busy query cannot push the rest out. */
export const MAX_PER_CONVERSATION = 20;
/** How many dismissals a device remembers. */
export const MAX_DISMISSED = 200;

/**
 * A dismissed entry, remembered so the catch-up does not bring it back,
 * until its conversation is read past it.
 */
export type Dismissal = {key: string; network: string; target: string; time: string};

/** One conversation's identity: its network and its name under rfc1459 casemapping. */
export function conversationKey(network: string, target: string): string {
	return `${network}/${casefold(target)}`;
}

/**
 * The entry's identity: its msgid, or what identifies the message on a
 * server without `message-tags`. Never a session-local id (irc/ids.ts).
 */
export function entryKey(entry: InboxEntry): string {
	if (entry.msgid) {
		return `${entry.network}/${entry.msgid}`;
	}

	return `${conversationKey(entry.network, entry.target)}/${entry.time}/${entry.from.nick ?? ""}`;
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

const timeOf = (e: {time: string}) => new Date(e.time).getTime();

/**
 * Add `added`, deduplicated by key and without the dismissed ones, ordered
 * by time; the newest {@link MAX_PER_CONVERSATION} of each conversation and
 * the newest {@link MAX_ENTRIES} overall are kept.
 */
export function addEntries(
	list: InboxEntry[],
	added: InboxEntry[],
	dismissed: Dismissal[] = []
): InboxEntry[] {
	const gone = new Set(dismissed.map((d) => d.key));
	const byKey = new Map<string, InboxEntry>();

	for (const entry of [...list, ...added]) {
		const key = entryKey(entry);

		if (!gone.has(key)) {
			byKey.set(key, entry);
		}
	}

	const newestFirst = [...byKey.values()].sort((a, b) => timeOf(b) - timeOf(a));
	const perConversation = new Map<string, number>();
	const kept = newestFirst.filter((entry) => {
		const key = conversationKey(entry.network, entry.target);
		const count = (perConversation.get(key) ?? 0) + 1;
		perConversation.set(key, count);
		return count <= MAX_PER_CONVERSATION;
	});

	return kept.slice(0, MAX_ENTRIES).reverse();
}

/**
 * `target` on `network` was read up to `time`: drop what it covers. Works
 * for entries and dismissals alike (a dismissal past the read point has
 * nothing left to hold back).
 */
export function pruneRead<T extends {network: string; target: string; time: string}>(
	list: T[],
	network: string,
	target: string,
	time: Date
): T[] {
	const key = conversationKey(network, target);
	return list.filter(
		(e) => conversationKey(e.network, e.target) !== key || timeOf(e) > time.getTime()
	);
}

export type InboxGroup = {
	/** {@link conversationKey}: one per conversation. */
	key: string;
	network: string;
	target: string;
	/** Oldest first, as the conversation reads. */
	entries: InboxEntry[];
};

/** The entries by conversation, the conversation with the newest mention first. */
export function groupByConversation(list: InboxEntry[]): InboxGroup[] {
	const groups = new Map<string, InboxGroup>();

	for (const entry of [...list].sort((a, b) => timeOf(a) - timeOf(b))) {
		const key = conversationKey(entry.network, entry.target);
		let group = groups.get(key);

		if (!group) {
			group = {key, network: entry.network, target: entry.target, entries: []};
			groups.set(key, group);
		}

		group.entries.push(entry);
	}

	const newest = (g: InboxGroup) => timeOf(g.entries[g.entries.length - 1]);
	return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

function isEntry(value: unknown): value is InboxEntry {
	const e = value as Record<string, unknown> | null;
	return (
		!!e &&
		typeof e.network === "string" &&
		typeof e.target === "string" &&
		typeof e.time === "string" &&
		!Number.isNaN(new Date(e.time).getTime()) &&
		typeof e.text === "string" &&
		!!e.from &&
		typeof e.from === "object"
	);
}

function isDismissal(value: unknown): value is Dismissal {
	const d = value as Record<string, unknown> | null;
	return (
		!!d &&
		typeof d.key === "string" &&
		typeof d.network === "string" &&
		typeof d.target === "string" &&
		typeof d.time === "string"
	);
}

function parseList<T>(raw: string | null | undefined, valid: (v: unknown) => v is T): T[] {
	try {
		const parsed: unknown = JSON.parse(raw || "[]");
		return Array.isArray(parsed) ? parsed.filter(valid) : [];
	} catch {
		return [];
	}
}

/**
 * The stored list. Entries in the old shape (session-local `chanId`/`msgId`,
 * which point nowhere after a reload) are dropped, not migrated.
 */
export const parseStored = (raw: string | null | undefined) => parseList(raw, isEntry);

export const parseDismissed = (raw: string | null | undefined) => parseList(raw, isDismissal);
