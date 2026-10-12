/**
 * METADATA lines and replies (draft/metadata-2). The account's push mute list
 * (`draft/webpush/mute`) is read into the client (irc/pushMute.ts: shared do
 * not disturb); every other key, and every acknowledgement, stays silent
 * (echoes of our own writes, e.g. the webpush payload tier from webpush.ts).
 *
 * Only our own entry counts. We write the key private, which the server
 * shows only to the account's own sessions; a public value is someone's
 * own only under their nick, and a subscriber also hears the public keys
 * of users it shares a channel with. So a value is taken when it says
 * `private` or names our nick (our own legacy public value).
 */
import type {Handler} from "../types";
import {MUTE_KEY, onMuteValue} from "../pushMute";

const quiet: Handler = () => undefined;

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
	if (msg.params[2] === MUTE_KEY && ours(client, msg.params[1] ?? "", msg.params[3] ?? "")) {
		onMuteValue(client, msg.params[4] ?? "");
	}
};

// 766 <me> <target> <key> :key not set
const keyNotSet: Handler = (client, msg) => {
	if (msg.params[2] === MUTE_KEY && client.isSelf(msg.params[1] ?? "")) {
		onMuteValue(client, "");
	}
};

export default {
	METADATA: metadata,
	"761": keyValue,
	"762": quiet,
	"766": keyNotSet,
	"770": quiet,
};
