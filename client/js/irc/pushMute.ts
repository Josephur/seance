/**
 * The account's push mute list, `draft/webpush/mute` metadata: `;`-separated
 * `target:until` entries (unix seconds) that nefarious2 enforces before it
 * pushes (ircd/webpush_mute.c); `*` mutes every target. Do not disturb owns
 * the `*` entry and leaves every other entry (per-channel mutes written by
 * any device) as it found it. See docs/projects/do-not-disturb.md.
 */

import type {IrcClient} from "./client";
// presence.ts imports this module too; the cycle is only between functions
// called after both modules have loaded, which ES modules allow.
import {syncPresence} from "./presence";

export const MUTE_KEY = "draft/webpush/mute";
/** An indefinite do not disturb writes this far ahead (the server's mute is timed)... */
export const INDEFINITE_MUTE_S = 30 * 86400;
/** ...and writes again once less than this remains. */
export const RENEW_BELOW_S = 7 * 86400;
/** SUB/GET wait this long after registration: the connect burst is over by then. */
export const MUTE_READ_DELAY_MS = 10_000;

export interface MuteEntry {
	target: string;
	/** Unix seconds. */
	until: number;
}

export function parseMute(value: string): MuteEntry[] {
	const out: MuteEntry[] = [];

	for (const raw of value.split(";")) {
		// The first colon, as the server splits it (memchr): a target never has one.
		const colon = raw.indexOf(":");

		if (colon <= 0) {
			continue;
		}

		const target = raw.slice(0, colon);
		const untilText = raw.slice(colon + 1);

		// A signed integer: 0 or a leading '-' is indefinite on the server.
		if (!/^-?\d+$/.test(untilText)) {
			continue;
		}

		out.push({target, until: Number(untilText)});
	}

	return out;
}

export function formatMute(entries: MuteEntry[]): string {
	return entries.map((e) => `${e.target}:${e.until}`).join(";");
}

/**
 * The `*` entry's end while it is live: a unix-seconds number, `Infinity`
 * for an indefinite one (until 0 or negative), `null` when absent or expired.
 */
export function globalUntil(value: string, nowSec: number): number | null {
	const entry = parseMute(value).find((e) => e.target === "*");

	if (!entry) {
		return null;
	}

	if (entry.until <= 0) {
		return Number.POSITIVE_INFINITY;
	}

	return entry.until > nowSec ? entry.until : null;
}

/** Entries other than `*` that are still live; indefinite ones always are. */
function liveOthers(value: string, nowSec: number): MuteEntry[] {
	return parseMute(value).filter((e) => e.target !== "*" && (e.until <= 0 || e.until > nowSec));
}

export function withGlobal(value: string, untilSec: number, nowSec: number): string {
	return formatMute([...liveOthers(value, nowSec), {target: "*", until: untilSec}]);
}

export function withoutGlobal(value: string, nowSec: number): string {
	return formatMute(liveOthers(value, nowSec));
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** The account's mute list can be written on this connection. */
export function canWriteMute(client: IrcClient): boolean {
	return (
		client.isWelcomed && client.caps.hasCapability("draft/metadata-2") && client.account !== ""
	);
}

/** What this client's own `*` entry should say (unix seconds), or null for none. */
export function desiredUntil(client: IrcClient, now: number): number | null {
	const g = client.globalDnd;

	if (g.active && g.until !== null) {
		return Math.floor(g.until / 1000);
	}

	if (g.active || client.presenceMode === "dnd") {
		return now + INDEFINITE_MUTE_S;
	}

	return null;
}

/** Send the whole value (empty deletes the key); `muteValue` holds it at once. */
function writeMute(client: IrcClient, value: string): void {
	client.muteValue = value;
	client.send(value ? `METADATA * SET ${MUTE_KEY} * :${value}` : `METADATA * SET ${MUTE_KEY}`);
}

/**
 * Keep the account's `*` entry in step with this client's do not disturb:
 * write it while DND is wanted, remove it when DND ends, but only an entry
 * this client wrote. Nothing is written before the value has been read.
 */
export function syncPushMute(client: IrcClient): void {
	if (!client.muteKnown || !canWriteMute(client)) {
		return;
	}

	const now = nowSec();
	const want = desiredUntil(client, now);
	const have = globalUntil(client.muteValue, now);

	if (want !== null) {
		// Another device took our entry away: leave it until DND starts afresh.
		if (client.muteSuppressed) {
			return;
		}

		// An indefinite entry (someone's `*:0`) already silences everything.
		if (have === Number.POSITIVE_INFINITY) {
			return;
		}

		const timed = client.globalDnd.active && client.globalDnd.until !== null;
		const stale = have === null || (timed ? have !== want : have - now < RENEW_BELOW_S);

		if (stale) {
			writeMute(client, withGlobal(client.muteValue, want, now));
			client.muteOwned = true;
		}

		return;
	}

	client.muteSuppressed = false;

	if (!client.muteOwned) {
		// Another device's entry: removed only by clearRemoteDnd.
		return;
	}

	client.muteOwned = false;

	if (have !== null) {
		writeMute(client, withoutGlobal(client.muteValue, now));
		// remoteDnd followed muteValue down: say so (AWAY, the snapshot).
		syncPresence(client);
	}
}

/** The pill's Off with DND set elsewhere: remove the `*` entry here. */
export function clearRemoteDnd(client: IrcClient): void {
	const now = nowSec();

	if (!canWriteMute(client) || globalUntil(client.muteValue, now) === null) {
		return;
	}

	writeMute(client, withoutGlobal(client.muteValue, now));
	client.muteOwned = false;
	syncPresence(client);
}

/** A value read back from the server (761, 766 as "", or a METADATA line). */
export function onMuteValue(client: IrcClient, value: string): void {
	const now = nowSec();
	const hadLive = client.muteKnown && globalUntil(client.muteValue, now) !== null;
	client.muteValue = value;
	client.muteKnown = true;
	const live = globalUntil(value, now) !== null;

	if (hadLive && !live && desiredUntil(client, now) !== null) {
		// The entry is gone while we still want one, and we did not remove
		// it (our own clears happen only when we want none, and update
		// muteValue before their echo): another device turned DND off. Do
		// not put it back; tell the page (client/js/dnd.ts).
		client.muteOwned = false;
		client.muteSuppressed = true;
		client.dispatchBus("dnd:cleared", {network: client.uuid});
	} else if (!live) {
		client.muteOwned = false;
	}

	syncPresence(client);
}
