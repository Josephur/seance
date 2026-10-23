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
 *  - the label is first read as a reader sees it (NFKC; invisible
 *    characters, spaces too thin to notice, bidi marks and ideographic dots
 *    folded away), and its addresses are the host-shaped words in it that
 *    end in a real TLD, carry a letter outside ASCII, or are an IPv4 address
 *    (an e-mail address counts by its domain, `a@b` by `b` as URL reads it),
 *    compared after one leading `www.` is dropped. A schemeless word with no
 *    path after it is a name, not an address, when it ends in a source-file
 *    extension that is also a TLD (`setup.py`, `readme.md`, `install.sh`) or
 *    in a TLD written all in capitals (`ASP.NET`, `Socket.IO`);
 *  - a label address on another site → `mismatch` (warn, confirm); one on
 *    a parent or a subdomain of the real host (`github.io` for
 *    attacker.github.io, `paypal.s3.amazonaws.com` for s3.amazonaws.com — a
 *    shared host is anyone's) → `masked` (show the host); only the same host
 *    → `honest`; no address → `honest` when the label is the href, else
 *    `masked`.
 *
 * Vue-free and DOM-free: layout.ts puts the verdict on the href node,
 * parse.ts renders it. Tests: test/helpers/linkSafety.ts.
 */

import tlds from "tlds";
import {urlHost} from "./urlHost";

export type LinkVerdict =
	| {kind: "honest"} // the label is the destination, or a URL on the same host
	| {kind: "masked"; host: string} // prose label: show the host
	| {kind: "mismatch"; host: string; shown: string}; // the label names another address

const bare = (host: string) => host.replace(/^www\./, "");

/**
 * How a host the label names relates to the one the link opens: the same
 * site, a subdomain of it (`login.paypal.com` for paypal.com — but a shared
 * host such as s3.amazonaws.com/attacker is anyone's), a parent of it
 * (`github.io` for attacker.github.io), or another site. Only the same site
 * is honest; a narrower or a parent host shows the real one.
 */
function relation(shown: string, real: string): "same" | "near" | "other" {
	const x = bare(shown);
	const y = bare(real);

	if (x === y) {
		return "same";
	}

	return x.endsWith("." + y) || y.endsWith("." + x) ? "near" : "other";
}

/**
 * Source-file extensions that are also top-level domains, and rarely anyone's
 * site: a schemeless `setup.py`, `readme.md`, `main.rs` or `install.sh` in a label is a file
 * name, not a claim about where the link goes. Kept short on purpose: every
 * entry is a TLD a phishing label could hide behind (`notion.so`,
 * `claude.ai`, `allegro.pl`, `.zip` still warn), and a word with a path after
 * it (`docs.rs/serde`) is always an address.
 */
const FILE_TLDS = new Set(["md", "py", "rs", "sh"]);
const TLDS = new Set<string>(tlds);

/**
 * Characters that change what the judging sees but not what the reader
 * does: the invisible ones (zero-width spaces and joiners, soft hyphens,
 * variation selectors, bidi marks and overrides — all Default_Ignorable) and
 * the ideographic full stops that read as a dot. NFKC folds the fullwidth
 * and leader dots — and the thin spaces into a plain one, so those go first:
 * a six-per-em, thin, hair, narrow no-break or medium mathematical space
 * inside `paypal.c om` is not a gap a reader sees.
 */
const THIN_SPACES = /[\u2006\u2008-\u200A\u202F\u205F]/g;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const IDEOGRAPHIC_DOTS = /[\u3002\uFF61]/g;

/** The label as a reader sees it, for judging: folded, the invisible gone. */
function readable(label: string): string {
	return label
		.replace(THIN_SPACES, "")
		.normalize("NFKC")
		.replace(IGNORABLE, "")
		.replace(IDEOGRAPHIC_DOTS, ".");
}

/**
 * A host-shaped word in the label: an optional scheme, an optional userinfo
 * (`support@`, or `paypal.com@` in front of the real host, as URL reads it),
 * then labels of letters (with their combining marks: `उदाहरण`), digits and
 * hyphens joined by dots. It starts only where a word does — not inside
 * one, nor after a dot, plus or hyphen that follows a letter (`a.b`'s `b`),
 * though after one that does not (`Verify…paypal.com`) — and the scheme and
 * userinfo are bounded, so a long label is read in one pass: a message can be
 * 16 KB.
 */
const HOST_WORD =
	/(?<![\p{L}\p{N}\p{M}])(?<![\p{L}\p{N}\p{M}][+.-])(?:([a-z][a-z0-9+.-]{0,31}):\/\/)?(?:([^\s@/]{1,64})@)?((?:[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*\.)+[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*)/giu;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function judgeLink(label: string, href: string): LinkVerdict {
	const host = urlHost(href);

	if (host === null) {
		return {kind: "masked", host: href};
	}

	const text = readable(label);
	let named = false;
	let near = false;

	for (const match of text.matchAll(HOST_WORD)) {
		const [shown, scheme, userinfo, written] = match;
		// A hyphen may not end a label; a word read up to one ends before it.
		const word = written.replace(/-+$/, "");
		const ending = word.slice(word.lastIndexOf(".") + 1);
		const tld = ending.toLowerCase();
		// A word names a site when it ends in a real TLD, carries a letter
		// outside ASCII (a lookalike: `paypal.cоm` with a Cyrillic о), or is
		// an IP address.
		const foreign = /[^\x00-\x7f]/.test(word);

		if (!TLDS.has(tld) && !foreign && !IPV4.test(word)) {
			continue;
		}

		const followedByPath = text[(match.index ?? 0) + shown.length] === "/";

		if (
			!scheme &&
			!userinfo &&
			!followedByPath &&
			!/^www\./i.test(word) &&
			(FILE_TLDS.has(tld) || /^[A-Z]+$/.test(ending))
		) {
			continue;
		}

		named = true;
		const how = relation(urlHost(`http://${word}`) ?? word.toLowerCase(), host);

		if (how === "other") {
			return {kind: "mismatch", host, shown};
		}

		near ||= how === "near";
	}

	if (near || (!named && label.trim() !== href.trim())) {
		return {kind: "masked", host};
	}

	return {kind: "honest"};
}
