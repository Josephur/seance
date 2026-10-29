import socket from "../socket";
import {store} from "../store";
import {switchToChannel} from "../router";
import {forgetIfLastChannel} from "../helpers/lastChannel";
import {dismissConversation} from "../mentions";

socket.on("part", function (data) {
	// When parting from the active channel/query, jump to the network's lobby
	if (store.state.activeChannel && store.state.activeChannel.channel.id === data.chan) {
		switchToChannel(store.state.activeChannel.network.channels[0]);
	}

	const channel = store.getters.findChannel(data.chan);

	if (!channel) {
		return;
	}

	forgetIfLastChannel(channel.network.uuid, channel.channel.name);

	channel.network.channels.splice(
		channel.network.channels.findIndex((c) => c.id === data.chan),
		1
	);

	// Dismissed, not just dropped: a rejoin's catch-up would bring them back.
	dismissConversation(channel.network.uuid, channel.channel.name);
});
