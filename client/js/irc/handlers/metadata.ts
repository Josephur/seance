/**
 * METADATA lines and replies (draft/metadata-2). The account's push mute list
 * (`draft/webpush/mute`) is read into the client (irc/pushMute.ts: shared do
 * not disturb). The replies for the keys this client writes itself — the
 * mute list and the webpush payload tier (webpush.ts) — stay silent; a reply
 * for any other key (a user's own `/metadata`) is shown as it always was,
 * through `unhandled`. METADATA lines for other keys stay silent.
 *
 * Only our own entry counts. We write the key private, which the server
 * shows only to the account's own sessions; a public value is someone's
 * own only under their nick, and a subscriber also hears the public keys
 * of users it shares a channel with. So a value is taken when it says
 * `private` or names our nick (our own legacy public value).
 */
import type {Handler} from "../types";
import {MUTE_KEY, onMuteValue} from "../pushMute";
// index.ts imports this module too; `unhandled` is only called at run time.
import {unhandled} from "./index";

/** The webpush payload tier (webpush.ts writes it through `webpush:metadata`). */
export const PAYLOAD_KEY = "draft/webpush/payload";

const OWN_KEYS = new Set([MUTE_KEY, PAYLOAD_KEY]);

const ownKey = (key: string | undefined) => key !== undefined && OWN_KEYS.has(key);

const ours = (client: Parameters<Handler>[0], target: string, visibility: string) =>
	visibility === "private" || client.isSelf(target);

// METADATA <target> <key> <visibility> [:<value>]
const metadata: Handler = (client, msg) => {
	if (msg.params[1] === MUTE_KEY && ours(client, msg.params[0] ?? "", msg.params[2] ?? "")) {
		onMuteValue(client, msg.params[3] ?? "");
	}
};

// 761 <me> <target> <key> <visibility> :<value>
const keyValue: Handler = (client, msg) => {
	if (!ownKey(msg.params[2])) {
		unhandled(client, msg);
		return;
	}

	if (msg.params[2] === MUTE_KEY && ours(client, msg.params[1] ?? "", msg.params[3] ?? "")) {
		onMuteValue(client, msg.params[4] ?? "");
	}
};

// 766 <me> <target> <key> :key not set
const keyNotSet: Handler = (client, msg) => {
	if (!ownKey(msg.params[2])) {
		unhandled(client, msg);
		return;
	}

	if (msg.params[2] === MUTE_KEY && client.isSelf(msg.params[1] ?? "")) {
		onMuteValue(client, "");
	}
};

// 770 <me> <key> [<key> ...]: silent when every key it names is ours.
const subOk: Handler = (client, msg) => {
	const keys = msg.params
		.slice(1)
		.flatMap((p) => p.split(" "))
		.filter(Boolean);

	if (keys.length === 0 || !keys.every(ownKey)) {
		unhandled(client, msg);
	}
};

// 762 <me> :end of metadata. It names no key, so it cannot tell whose GET
// it ends; it adds nothing to the 761/766 lines shown before it.
const endOfMetadata: Handler = () => undefined;

export default {
	METADATA: metadata,
	"761": keyValue,
	"762": endOfMetadata,
	"766": keyNotSet,
	"770": subOk,
};
