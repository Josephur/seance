// The inbox's store glue (docs/projects/inbox.md): unread mentions kept in
// the Vuex store and persisted in localStorage. The IRC layer says what goes
// in (`inbox:add`) and what has been read (`inbox:read`); the rules are in
// helpers/inbox.ts.

import storage from "./localStorage";
import {store} from "./store";
import type {NetChan} from "./types";
import {addEntries, dismiss, parseStored, pruneRead, type InboxEntry} from "./helpers/inbox";

const KEY = "thelounge.mentions";

let watching = false;

function persist(): void {
	storage.set(KEY, JSON.stringify(store.state.mentions));
}

function update(fn: (list: InboxEntry[]) => InboxEntry[]): void {
	const next = fn(store.state.mentions);

	if (
		next.length !== store.state.mentions.length ||
		next.some((e, i) => e !== store.state.mentions[i])
	) {
		store.commit("mentions", next);
	}
}

/** Load stored mentions into the store and start mirroring changes back. */
export function loadMentions(): void {
	const stored = parseStored(storage.get(KEY));
	store.commit("mentions", stored);

	if (!watching) {
		watching = true;
		store.watch((state) => state.mentions, persist, {deep: true});
	}
}

export function addMentions(entries: InboxEntry[]): void {
	if (entries.length > 0) {
		update((list) => addEntries(list, entries));
	}
}

export function markMentionsRead(network: string, target: string, time: Date): void {
	update((list) => pruneRead(list, network, target, time));
}

/** This device only: a dismissal does not reach the other devices. */
export function dismissMention(key: string): void {
	update((list) => dismiss(list, key));
}

export function dismissAllMentions(): void {
	store.commit("mentions", []);
}

/** The conversation an entry belongs to, when this page has it. */
export function conversationOf(entry: InboxEntry): NetChan | null {
	const network = store.getters.findNetwork(entry.network);
	const name = entry.target.toLowerCase();
	const channel = network?.channels.find((c) => c.name.toLowerCase() === name);
	return network && channel ? {network, channel} : null;
}

/** What the inbox shows: every entry but those of muted conversations. */
export function visibleMentions(): InboxEntry[] {
	return store.state.mentions.filter((entry) => !conversationOf(entry)?.channel.muted);
}
