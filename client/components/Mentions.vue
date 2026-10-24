<template>
	<div
		v-if="isOpen"
		id="mentions-popup-container"
		data-escape-close="mentions"
		@click="containerClick"
		@contextmenu="containerClick"
	>
		<div class="mentions-popup">
			<div class="mentions-popup-title">
				Unread mentions
				<button
					v-if="resolvedMessages.length"
					class="btn dismiss-all-mentions"
					@click="dismissAllMentions()"
				>
					Dismiss all
				</button>
			</div>
			<template v-if="resolvedMessages.length === 0">
				<p v-if="isLoading">Loading…</p>
				<p v-else>You have no unread mentions.</p>
			</template>
			<template v-for="message in resolvedMessages" v-else :key="message.key">
				<div :class="['msg', message.type]">
					<div class="mentions-info">
						<div>
							<span class="from">
								<Username :user="(message.from as any)" />
								<template v-if="message.channel">
									in
									<a
										href="#"
										class="mention-target"
										@click.prevent="openMention(message)"
										>{{ message.channel.channel.name }}</a
									>
									on {{ message.channel.network.name }}
								</template>
								<template v-else> in {{ message.target }} </template> </span
							>{{ ` ` }}
							<span :title="message.localetime" class="time">
								{{ messageTime(message.time) }}
							</span>
						</div>
						<div>
							<span
								class="close-tooltip tooltipped tooltipped-w"
								aria-label="Dismiss on this device"
							>
								<button
									class="msg-dismiss"
									aria-label="Dismiss on this device"
									@click="dismissMention(message)"
								></button>
							</span>
						</div>
					</div>
					<div class="content" dir="auto">
						<ParsedMessage :message="(message as any)" />
					</div>
				</div>
			</template>
		</div>
	</div>
</template>

<style>
#mentions-popup-container {
	z-index: 8;
}

.mentions-popup {
	background-color: var(--window-bg-color);
	position: absolute;
	width: 400px;
	right: 80px;
	top: 55px;
	max-height: 400px;
	overflow-y: auto;
	z-index: 2;
	padding: 10px;
}

.mentions-popup > .mentions-popup-title {
	display: flex;
	justify-content: space-between;
	margin-bottom: 10px;
	font-size: 1.25rem;
}

.mentions-popup .mentions-info {
	display: flex;
	justify-content: space-between;
}

.mentions-popup .msg {
	margin-bottom: 15px;
	user-select: text;
}

.mentions-popup .msg:last-child {
	margin-bottom: 0;
}

.mentions-popup .msg .content {
	background-color: var(--highlight-bg-color);
	border-radius: 5px;
	padding: 6px;
	margin-top: 2px;
	word-wrap: break-word;
	word-break: break-word; /* Webkit-specific */
}

.mentions-popup .msg-dismiss::before {
	font-size: 1.25rem;
	font-weight: normal;
	display: inline-block;
	line-height: 16px;
	text-align: center;
	content: "×";
}

.mentions-popup .msg-dismiss:hover {
	color: var(--link-color);
}

.mentions-popup .dismiss-all-mentions {
	margin: 0;
	padding: 4px 6px;
}

@media (min-height: 500px) {
	.mentions-popup {
		max-height: 60vh;
	}
}

@media (max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse) {
	.mentions-popup {
		border-radius: 0;
		border: 0;
		box-shadow: none;
		width: 100%;
		max-height: none;
		right: 0;
		left: 0;
		bottom: 0;
		top: 3rem; /* header height */
	}
}
</style>

<script lang="ts">
import Username from "./Username.vue";
import ParsedMessage from "./ParsedMessage.vue";
import {
	dismissMention as dismissStoredMention,
	dismissAllMentions as dismissAllStoredMentions,
} from "../js/mentions";
import eventbus from "../js/eventbus";
import {switchToChannel} from "../js/router";
import {entryKey} from "../js/helpers/inbox";
import localetime from "../js/helpers/localetime";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {computed, watch, defineComponent, ref, onMounted, onUnmounted} from "vue";
import {useStore} from "../js/store";
import type {InboxEntry} from "../../shared/types/mention";
import type {NetChan} from "../js/types";

type MentionWithContext = InboxEntry & {
	key: string;
	localetime: string;
	channel: NetChan | null;
};

dayjs.extend(relativeTime);

export default defineComponent({
	name: "Mentions",
	components: {
		Username,
		ParsedMessage,
	},
	setup() {
		const store = useStore();
		const isOpen = ref(false);
		const isLoading = ref(false);
		const findTarget = (entry: InboxEntry): NetChan | null => {
			const network = store.getters.findNetwork(entry.network);
			const name = entry.target.toLowerCase();
			const channel = network?.channels.find((c) => c.name.toLowerCase() === name);
			return network && channel ? {network, channel} : null;
		};

		const resolvedMessages = computed(() => {
			return store.state.mentions
				.slice()
				.reverse()
				.map((message) => ({
					...message,
					key: entryKey(message),
					localetime: localetime(new Date(message.time)),
					channel: findTarget(message),
				}))
				.filter((message) => !message.channel?.channel.muted);
		});

		watch(
			() => store.state.mentions,
			() => {
				isLoading.value = false;
			}
		);

		const messageTime = (time: string) => {
			return dayjs(time).fromNow();
		};

		const dismissMention = (message: MentionWithContext) => {
			dismissStoredMention(message.key);
		};

		// Opening it reads it, and reading it clears the entry (inbox:read).
		const openMention = (message: MentionWithContext) => {
			if (message.channel) {
				isOpen.value = false;
				switchToChannel(message.channel.channel);
			}
		};

		const dismissAllMentions = () => {
			dismissAllStoredMentions();
		};

		const containerClick = (event: Event) => {
			if (event.currentTarget === event.target) {
				isOpen.value = false;
			}
		};

		const togglePopup = () => {
			isOpen.value = !isOpen.value;

			// Mentions are kept locally, so there is nothing to fetch
			isLoading.value = false;
		};

		const closePopup = () => {
			isOpen.value = false;
		};

		const onEscape = (layer: string | null) => {
			if (layer === "mentions") {
				closePopup();
			}
		};

		onMounted(() => {
			eventbus.on("mentions:toggle", togglePopup);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("mentions:toggle", togglePopup);
			eventbus.off("escapekey", onEscape);
		});

		return {
			isOpen,
			isLoading,
			resolvedMessages,
			messageTime,
			dismissMention,
			dismissAllMentions,
			openMention,
			containerClick,
		};
	},
});
</script>
