/**
 * The host a URL names, in the form hosts are compared in: lowercased, no
 * trailing dot; `null` when the URL does not parse or names no host. Shared
 * by the media trust lists (mediaTrust.ts) and the masked-link verdict
 * (linkSafety.ts). Vue-free and DOM-free.
 */
export function urlHost(url: string): string | null {
	try {
		const host = new URL(url).hostname.trim().toLowerCase().replace(/\.+$/, "");
		return host === "" ? null : host;
	} catch {
		return null;
	}
}
