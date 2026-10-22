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
 *    included); two hosts match when they are equal or one is a subdomain of
 *    the other, after one leading `www.` is dropped;
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

export function judgeLink(label: string, href: string): LinkVerdict {
	const host = linkHost(href);

	if (host === undefined) {
		return {kind: "masked", host: href};
	}

	let named = false;

	for (const part of findLinks(label)) {
		const shownHost = linkHost(part.link);

		if (shownHost === undefined) {
			continue;
		}

		named = true;

		if (!sameSite(shownHost, host)) {
			return {kind: "mismatch", host, shown: label.slice(part.start, part.end)};
		}
	}

	if (named || label.trim() === href.trim()) {
		return {kind: "honest"};
	}

	return {kind: "masked", host};
}
