/**
 * METADATA lines and replies (draft/metadata-2). The account's push mute list
 * (`draft/webpush/mute`) is read into the client (irc/pushMute.ts: shared do
 * not disturb); every other key, and every acknowledgement, stays silent
 * (echoes of our own writes, e.g. the webpush payload tier from webpush.ts).
 *
 * Only our own entry counts: the key is public, so a subscriber also hears
 * the keys of users it shares a channel with.
 */
import type {Handler} from "../types";
import {MUTE_KEY, onMuteValue} from "../pushMute";

const quiet: Handler = () => undefined;

// METADATA <target> <key> <visibility> [:<value>]
const metadata: Handler = (client, msg) => {
	if (msg.params[1] === MUTE_KEY && client.isSelf(msg.params[0] ?? "")) {
		onMuteValue(client, msg.params[3] ?? "");
	}
};

// 761 <me> <target> <key> <visibility> :<value>
const keyValue: Handler = (client, msg) => {
	if (msg.params[2] === MUTE_KEY && client.isSelf(msg.params[1] ?? "")) {
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
