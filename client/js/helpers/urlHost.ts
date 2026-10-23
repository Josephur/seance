/**
 * Hosts in the form they are compared and stored in: lowercased, no trailing
 * dot. Shared by the media trust lists (mediaTrust.ts) and the masked-link
 * verdict (linkSafety.ts). Vue-free and DOM-free.
 */

/** Lowercase, no trailing dot. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** The host a URL names, normalized; `null` when it does not parse or names none. */
export function urlHost(url: string): string | null {
	try {
		const host = normalizeHost(new URL(url).hostname);
		return host === "" ? null : host;
	} catch {
		return null;
	}
}
