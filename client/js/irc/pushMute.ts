/**
 * The account's push mute list, `draft/webpush/mute` metadata: `;`-separated
 * `target:until` entries (unix seconds) that nefarious2 enforces before it
 * pushes (ircd/webpush_mute.c); `*` mutes every target. Do not disturb owns
 * the `*` entry and leaves every other entry (per-channel mutes written by
 * any device) as it found it. See docs/projects/do-not-disturb.md.
 */

import type {IrcClient} from "./client";

export const MUTE_KEY = "draft/webpush/mute";

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

/** Keep the account's push mute list in step with do not disturb (Task 4 fills this in). */
export function syncPushMute(_client: IrcClient): void {}
