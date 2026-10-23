/**
 * Reader preferences the service worker needs (it cannot read
 * localStorage), mirrored into the IndexedDB store it already uses
 * (seance-push/kv, key "prefs"): whether Markdown renders, so a push
 * notification strips markers exactly when the page does (settings.ts
 * `markdown.apply`, at boot and on every change), and the conversations
 * muted on this device (mute.ts, at load and on every change).
 */
import {idbGet, idbSet} from "./idb";

/** `muted`: the conversations muted on this device (`<network uuid>/<name
 * lowercased>`, client/js/mute.ts), which a push under WebKit shows quietly. */
export type PushPrefs = {markdown: boolean; muted: string[]};

export const PREFS_KEY = "prefs";

export async function mirrorPushPrefs(patch: Partial<PushPrefs>): Promise<void> {
	try {
		const prev = (await idbGet<Partial<PushPrefs>>(PREFS_KEY)) ?? {};
		await idbSet(PREFS_KEY, {...prev, ...patch});
	} catch (error) {
		// No IndexedDB (private mode, quota): the worker uses the default.
	}
}
