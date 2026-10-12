/**
 * The account's push mute list, `draft/webpush/mute` metadata: `;`-separated
 * `target:until` entries (unix seconds) that nefarious2 enforces before it
 * pushes (ircd/webpush_mute.c); `*` mutes every target. Do not disturb owns
 * the `*` entry and leaves every other entry (per-channel mutes written by
 * any device) as it found it. See docs/projects/do-not-disturb.md.
 */

export const MUTE_KEY = "draft/webpush/mute";

export interface MuteEntry {
	target: string;
	/** Unix seconds. */
	until: number;
}

export function parseMute(value: string): MuteEntry[] {
	const out: MuteEntry[] = [];

	for (const raw of value.split(";")) {
		const colon = raw.lastIndexOf(":");

		if (colon <= 0) {
			continue;
		}

		const target = raw.slice(0, colon);
		const untilText = raw.slice(colon + 1);

		if (!/^\d+$/.test(untilText)) {
			continue;
		}

		out.push({target, until: Number(untilText)});
	}

	return out;
}

export function formatMute(entries: MuteEntry[]): string {
	return entries.map((e) => `${e.target}:${e.until}`).join(";");
}

export function globalUntil(value: string, nowSec: number): number | null {
	const entry = parseMute(value).find((e) => e.target === "*");
	return entry && entry.until > nowSec ? entry.until : null;
}

function liveOthers(value: string, nowSec: number): MuteEntry[] {
	return parseMute(value).filter((e) => e.target !== "*" && e.until > nowSec);
}

export function withGlobal(value: string, untilSec: number, nowSec: number): string {
	return formatMute([...liveOthers(value, nowSec), {target: "*", until: untilSec}]);
}

export function withoutGlobal(value: string, nowSec: number): string {
	return formatMute(liveOthers(value, nowSec));
}
