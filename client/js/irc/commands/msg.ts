/**
 * `/msg <target> <text>`, `/query <nick> [text]`, `/say <text>` (and plain text).
 * Ported from attic/server/plugins/inputs/msg.ts.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {REPLY_TAG} from "../wire";
import type {Command, CommandContext} from "../types";
import {splitTarget} from "./target";

function openQuery({client, chan}: CommandContext, targetName: string): boolean {
	// `splitTarget` never produces one, but a query window is a lasting piece
	// of state: never open one for a name that cannot be a nick.
	if (/[\s\0]/.test(targetName)) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: "You can not open query windows for names containing spaces.",
		});
		return false;
	}

	if (client.findChannel(targetName)) {
		return true;
	}

	if (client.isChannelName(targetName)) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: "You can not open query windows for channels, use /join instead.",
		});
		return false;
	}

	if (client.isupport.prefix.symbols.includes(targetName[0])) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: "You can not open query windows for names starting with a user prefix.",
		});
		return false;
	}

	// The user asked for it back: a reopen, here and on the other devices.
	client.closed.reopen(targetName);
	client.writeClosed();
	client.announceChannel(targetName, ChanType.QUERY, {shouldOpen: true});
	return true;
}

const msg: Command = {
	commands: ["query", "msg", "say"],
	input(ctx) {
		const {client, chan, cmd, rest} = ctx;
		// `/say` (and plain text) is all body; `/msg` and `/query` take the
		// target off the front — at a space or, under `draft/multiline`, at
		// the line feed that starts the message's second line.
		const {target: targetName, body} =
			cmd === "say" ? {target: chan.name, body: rest} : splitTarget(rest);

		if (cmd === "query") {
			if (!targetName) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "You cannot open a query window without an argument.",
				});
				return;
			}

			if (!openQuery(ctx, targetName)) {
				return;
			}
		}

		if (!targetName || body.length === 0) {
			return;
		}

		// Only plain text into the current window carries the UI's reply /
		// edit references (bus-contract §1.4); `/msg` and `/query` do not.
		const opts = cmd === "say" ? ctx.opts ?? {} : {};

		if (opts.edit) {
			client.editMessage(chan, opts.edit, body, opts.reply);
			return;
		}

		client.sendMessage(targetName, body, opts.reply ? {tags: {[REPLY_TAG]: opts.reply}} : {});
	},
};

export default msg;
