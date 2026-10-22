/**
 * Masked markdown links (`[label](url)`): the label is free text, so it can
 * show one address and open another. `judgeLink` compares the label with
 * where the link really goes, by host and never by string:
 *
 *  - the destination host is `new URL(href).hostname`, which sees through
 *    userinfo (`https://bank.com@evil.example` opens evil.example) and gives
 *    an internationalised http(s) host in punycode (`xn--…`), so a lookalike
 *    letter shows itself; a `web+irc:` host is opaque to URL and compared as
 *    written, lowercased;
 *  - the label's addresses are what the linkifier finds in it (bare domains
 *    included; an e-mail address counts by its domain); two hosts match when
 *    they are equal or one is a subdomain of the other, after one leading
 *    `www.` is dropped. A schemeless word that is a file name — a segment of
 *    the link's own path, or ending in an extension that is also a TLD
 *    (`setup.py`, `readme.md`, `backup.zip`) — is not an address: the link is
 *    then judged `masked` and still shows its host;
 *  - any label address that does not match → `mismatch` (warn, confirm);
 *    addresses that all match → `honest`; none → `honest` when the label is
 *    the href, else `masked` (show the host).
 *
 * Vue-free and DOM-free: layout.ts puts the verdict on the href node,
 * parse.ts renders it. Tests: test/helpers/linkSafety.ts.
 */

import {findLinks} from "../../../shared/linkify";

export type LinkVerdict =
	| {kind: "honest"} // the label is the destination, or a URL on the same host
	| {kind: "masked"; host: string} // prose label: show the host
	| {kind: "mismatch"; host: string; shown: string}; // the label names another address

/** The host a URL opens: lowercased, a trailing dot dropped; undefined when it does not parse. */
export function linkHost(href: string): string | undefined {
	let url: URL;

	try {
		url = new URL(href);
	} catch {
		return undefined;
	}

	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	return host === "" ? undefined : host;
}

const bare = (host: string) => host.replace(/^www\./, "");

function sameSite(a: string, b: string): boolean {
	const x = bare(a);
	const y = bare(b);
	return x === y || x.endsWith("." + y) || y.endsWith("." + x);
}

/** The host an address the linkifier found names; an e-mail address names its domain. */
function addressHost(link: string): string | undefined {
	if (/^mailto:/i.test(link)) {
		const domain = link.slice(link.lastIndexOf("@") + 1).toLowerCase();
		return domain === "" ? undefined : domain.replace(/\.$/, "");
	}

	return linkHost(link);
}

/**
 * File extensions that are also top-level domains: a schemeless `setup.py` or
 * `readme.md` in a label is a file name, not a claim about where the link goes.
 */
const FILE_TLDS = new Set([
	"ai",
	"cc",
	"md",
	"mov",
	"pl",
	"pm",
	"ps",
	"py",
	"rb",
	"rs",
	"sh",
	"so",
	"zip",
]);

/**
 * `shown` (what the label wrote) is a file name rather than an address: it
 * has no scheme and no `www.`, and it is a segment of the link's own path or
 * ends in an extension-like TLD. An address written with a scheme or `www.`
 * always counts.
 */
function isFileName(shown: string, shownHost: string, href: string): boolean {
	if (/^[a-z][a-z0-9+.-]*:/i.test(shown) || /^www\./i.test(shown) || shown.includes("@")) {
		return false;
	}

	let segments: string[] = [];

	try {
		segments = new URL(href).pathname
			.split("/")
			.map((p) => decodeURIComponent(p).toLowerCase());
	} catch {
		segments = [];
	}

	const tld = shownHost.slice(shownHost.lastIndexOf(".") + 1);
	return segments.includes(shown.toLowerCase()) || FILE_TLDS.has(tld);
}

export function judgeLink(label: string, href: string): LinkVerdict {
	const host = linkHost(href);

	if (host === undefined) {
		return {kind: "masked", host: href};
	}

	let named = false;

	for (const part of findLinks(label)) {
		const shown = label.slice(part.start, part.end);
		const shownHost = addressHost(part.link);

		if (shownHost === undefined || isFileName(shown, shownHost, href)) {
			continue;
		}

		named = true;

		if (!sameSite(shownHost, host)) {
			return {kind: "mismatch", host, shown};
		}
	}

	if (named || label.trim() === href.trim()) {
		return {kind: "honest"};
	}

	return {kind: "masked", host};
}
