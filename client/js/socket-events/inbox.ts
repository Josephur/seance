import socket from "../socket";
import {store} from "../store";
import {addMentions, dropMentionOf, markMentionsRead} from "../mentions";

// Unread mentions, live or caught up (docs/projects/inbox.md). A muted
// conversation's are not kept: they would only take up room.
socket.on("inbox:add", function (data) {
	addMentions(
		data.entries.filter(
			(e) => !store.getters.findConversation(e.network, e.target)?.channel.muted
		)
	);
});

// A conversation was read up to a point, here or on another session.
socket.on("inbox:read", function (data) {
	markMentionsRead(data.network, data.target, new Date(data.time));
});

// A deleted message leaves the inbox, and so does the original of an edit
// (registered before ./msg_updates in index.ts, so the message is still there)
// (the edit brings its own entry if it still mentions us).
function dropMessage(chanId: number, id: number): void {
	const found = store.getters.findChannel(chanId);
	const msgid = found?.channel.messages.find((m) => m.id === id)?.msgid;

	if (found && msgid) {
		dropMentionOf(found.network.uuid, msgid);
	}
}

socket.on("msg:redact", (data) => dropMessage(data.chan, data.id));
socket.on("msg:edit", (data) => dropMessage(data.chan, data.replaces));
