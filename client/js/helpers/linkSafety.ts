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
 *    included; an e-mail address counts by its domain), compared after one
 *    leading `www.` is dropped. A schemeless word ending in a source-file
 *    extension that is also a TLD (`setup.py`, `readme.md`, `main.rs`) is not
 *    an address;
 *  - a label address on another site → `mismatch` (warn, confirm); one
 *    naming only a parent of the real host (`github.io` for
 *    attacker.github.io — a shared host is everyone's parent) → `masked`
 *    (show the host); the same host or a subdomain of it → `honest`; no
 *    address → `honest` when the label is the href, else `masked`.
 *
 * Vue-free and DOM-free: layout.ts puts the verdict on the href node,
 * parse.ts renders it. Tests: test/helpers/linkSafety.ts.
 */

import {findLinks} from "../../../shared/linkify";
import {urlHost} from "./urlHost";

export type LinkVerdict =
	| {kind: "honest"} // the label is the destination, or a URL on the same host
	| {kind: "masked"; host: string} // prose label: show the host
	| {kind: "mismatch"; host: string; shown: string}; // the label names another address

/** The host a URL opens: lowercased, no trailing dot; undefined when it does not parse. */
export function linkHost(href: string): string | undefined {
	return urlHost(href) ?? undefined;
}

const bare = (host: string) => host.replace(/^www\./, "");

/**
 * How a host the label names relates to the one the link opens: the same
 * site, a subdomain of it (a label naming `login.paypal.com` for paypal.com),
 * a parent of it (a label naming `github.io` for attacker.github.io: a
 * shared host is everyone's parent, so the real host is shown), or another.
 */
function relation(shown: string, real: string): "same" | "narrower" | "parent" | "other" {
	const x = bare(shown);
	const y = bare(real);

	if (x === y) {
		return "same";
	}

	if (x.endsWith("." + y)) {
		return "narrower";
	}

	return y.endsWith("." + x) ? "parent" : "other";
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
 * Source-file extensions that are also top-level domains, and rarely anyone's
 * site: a schemeless `setup.py`, `readme.md` or `main.rs` in a label is a file
 * name, not a claim about where the link goes. Kept short on purpose: every
 * entry is a TLD a phishing label could hide behind (`notion.so`,
 * `claude.ai`, `allegro.pl`, `.zip` still warn).
 */
const FILE_TLDS = new Set(["md", "py", "rs"]);

/** `shown` is a schemeless word ending in a source-file extension. */
function isFileName(shown: string, shownHost: string): boolean {
	if (/^[a-z][a-z0-9+.-]*:/i.test(shown) || /^www\./i.test(shown) || shown.includes("@")) {
		return false;
	}

	return FILE_TLDS.has(shownHost.slice(shownHost.lastIndexOf(".") + 1));
}

export function judgeLink(label: string, href: string): LinkVerdict {
	const host = linkHost(href);

	if (host === undefined) {
		return {kind: "masked", host: href};
	}

	let named = false;
	let parent = false;

	for (const part of findLinks(label)) {
		const shown = label.slice(part.start, part.end);
		const shownHost = addressHost(part.link);

		if (shownHost === undefined || isFileName(shown, shownHost)) {
			continue;
		}

		named = true;
		const how = relation(shownHost, host);

		if (how === "other") {
			return {kind: "mismatch", host, shown};
		}

		parent ||= how === "parent";
	}

	if (parent || (!named && label.trim() !== href.trim())) {
		return {kind: "masked", host};
	}

	return {kind: "honest"};
}
