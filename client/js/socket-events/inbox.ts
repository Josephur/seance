import socket from "../socket";
import {store} from "../store";
import {entryFor, type InboxEntry} from "../helpers/inbox";
import {addMentions, markMentionsRead} from "../mentions";

// Unread mentions, live or caught up (docs/projects/inbox.md).
socket.on("inbox:add", function (data) {
	const found = store.getters.findChannel(data.chan);

	if (!found) {
		return;
	}

	const entries = data.msgs
		.map((msg) => entryFor(found.network.uuid, found.channel.name, msg))
		.filter((entry): entry is InboxEntry => entry !== null);

	addMentions(entries);
});

// A conversation was read up to a point, here or on another session.
socket.on("inbox:read", function (data) {
	markMentionsRead(data.network, data.target, new Date(data.time));
});
