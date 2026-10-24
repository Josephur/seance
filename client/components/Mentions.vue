<template>
	<div
		v-if="isOpen"
		id="mentions-popup-container"
		data-escape-close="mentions"
		@click="containerClick"
		@contextmenu="containerClick"
	>
		<div class="mentions-popup" role="dialog" aria-labelledby="mentions-popup-heading">
			<div class="mentions-popup-title">
				<h2 id="mentions-popup-heading">
					Mentions
					<span v-if="total" class="mentions-total">{{ total }} unread</span>
				</h2>
				<button v-if="total" class="btn dismiss-all-mentions" @click="dismissAllMentions()">
					Dismiss all
				</button>
			</div>

			<div v-if="groups.length === 0" class="mentions-empty">
				<span class="mentions-empty-icon" aria-hidden="true"></span>
				<p class="mentions-empty-title">You're all caught up</p>
				<p class="mentions-empty-hint">
					A mention leaves this list once you read it, here or on any other device.
				</p>
			</div>

			<template v-else>
				<section
					v-for="group in groups"
					:key="group.key"
					class="mentions-group"
					:aria-label="group.label"
				>
					<div class="mentions-group-head">
						<button
							class="mentions-group-header"
							:disabled="!group.conversation"
							:title="group.conversation ? `Open ${group.target}` : undefined"
							@click="openGroup(group)"
						>
							<span class="mentions-group-name">{{ group.target }}</span>
							<span v-if="group.networkName" class="mentions-group-network">{{
								group.networkName
							}}</span>
							<span v-if="groups.length > 1" class="mentions-group-count">{{
								group.entries.length
							}}</span>
						</button>
						<!-- A conversation this page no longer has: reading cannot clear it. -->
						<button
							v-if="!group.conversation"
							class="btn dismiss-group-mentions"
							@click="dismissGroup(group)"
						>
							Dismiss
						</button>
					</div>
					<!-- A click opens the conversation; the header is the keyboard's way. -->
					<div
						v-for="message in group.entries"
						:key="message.key"
						:class="[
							'msg',
							'mentions-entry',
							message.type,
							{'mentions-entry-openable': group.conversation},
						]"
						@click="openFromRow($event, group)"
					>
						<div class="mentions-info">
							<span class="from" @click.stop>
								<Username :user="(message.from as any)" />
							</span>
							<time
								class="time"
								:datetime="message.time"
								:title="message.localetime"
								>{{ messageTime(message.time) }}</time
							>
							<button
								class="msg-dismiss"
								title="Dismiss on this device"
								aria-label="Dismiss on this device"
								@click.stop="dismissMention(message)"
							></button>
						</div>
						<div class="content" dir="auto">
							<ParsedMessage :message="(message as any)" />
						</div>
					</div>
				</section>
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
	box-sizing: border-box;
	width: min(26rem, calc(100vw - 1rem));
	right: 5rem;
	top: 3.4rem;
	max-height: 25rem;
	overflow-y: auto;
	overscroll-behavior: contain;
	z-index: 2;
	padding: 0 0 0.5rem;
}

.mentions-popup > .mentions-popup-title {
	position: sticky;
	top: 0;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	padding: 0.75rem 0.75rem 0.5rem;
	background: inherit;
}

.mentions-popup-title h2 {
	margin: 0;
	font-size: 1.125rem;
	font-weight: 700;
	color: var(--window-heading-color, inherit);
}

.mentions-popup .mentions-total {
	margin-inline-start: 0.375rem;
	font-size: 0.8125rem;
	font-weight: normal;
	color: var(--body-color-muted);
}

.mentions-popup .dismiss-all-mentions {
	margin: 0;
	padding: 0.25rem 0.5rem;
	font-size: 0.8125rem;
}

/* One conversation: a header that opens it, then its mentions as it reads. */
.mentions-group + .mentions-group {
	margin-top: 0.25rem;
}

.mentions-group-head {
	display: flex;
	align-items: center;
	padding-inline-end: 0.75rem;
}

.mentions-group-head .dismiss-group-mentions {
	flex-shrink: 0;
	margin: 0;
	padding: 0.125rem 0.375rem;
	font-size: 0.75rem;
}

.mentions-group-header {
	display: flex;
	flex: 1 1 auto;
	min-width: 0;
	align-items: baseline;
	gap: 0.5rem;
	width: 100%;
	padding: 0.5rem 0.75rem 0.25rem;
	background: none;
	border: 0;
	color: inherit;
	font: inherit;
	text-align: start;
	cursor: pointer;
}

.mentions-group-header:disabled {
	cursor: default;
}

.mentions-group-name {
	font-weight: 700;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.mentions-group-header:not(:disabled):hover .mentions-group-name,
.mentions-group-header:focus-visible .mentions-group-name {
	color: var(--link-color);
	text-decoration: underline;
}

.mentions-group-network {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.8125rem;
	color: var(--body-color-muted);
}

.mentions-group-count {
	margin-inline-start: auto;
	flex-shrink: 0;
	min-width: 1.25rem;
	padding: 0.125rem 0.375rem;
	border-radius: 999rem;
	background: var(--highlight-bg-color);
	font-size: 0.75rem;
	text-align: center;
	color: var(--body-color);
}

.mentions-popup .mentions-entry {
	margin: 0 0.375rem;
	padding: 0.375rem;
	border-radius: 0.375rem;
	user-select: text;
}

.mentions-popup .mentions-entry-openable {
	cursor: pointer;
}

.mentions-popup .mentions-entry:hover {
	background: var(--highlight-bg-color);
}

.mentions-popup .mentions-info {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	min-width: 0;
}

.mentions-popup .mentions-info .from {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.mentions-popup .mentions-info .time {
	flex-shrink: 0;
	font-size: 0.75rem;
	color: var(--body-color-muted);
}

.mentions-popup .msg .content {
	margin-top: 0.125rem;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
	line-clamp: 3;
	overflow: hidden;
	word-wrap: break-word;
	word-break: break-word; /* Webkit-specific */
}

.mentions-popup .msg-dismiss {
	margin-inline-start: auto;
	flex-shrink: 0;
	width: 1.5rem;
	height: 1.5rem;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: none;
	color: var(--body-color-muted);
	opacity: 0;
	transition: opacity 0.15s;
}

/* Hidden until the row is hovered or focused, except where the last pointer
 * was a finger: nothing hovers there. */
.mentions-popup .mentions-entry:hover .msg-dismiss,
.mentions-popup .mentions-entry:focus-within .msg-dismiss,
:where(html[data-input="touch"]) .mentions-popup .msg-dismiss {
	opacity: 1;
}

.mentions-popup .msg-dismiss::before {
	font-size: 1.125rem;
	line-height: 1.5rem;
	content: "×";
}

.mentions-popup .msg-dismiss:hover,
.mentions-popup .msg-dismiss:focus-visible {
	color: var(--link-color);
	background: var(--highlight-bg-color);
}

.mentions-empty {
	padding: 1.5rem 1.5rem 1.25rem;
	text-align: center;
}

.mentions-empty-icon::before {
	display: inline-block;
	width: 2.75rem;
	height: 2.75rem;
	line-height: 2.75rem;
	border-radius: 50%;
	background: var(--highlight-bg-color);
	color: var(--body-color-muted);
	font: normal normal normal 1.25rem/2.75rem FontAwesome;
	content: "\f00c"; /* https://fontawesome.com/icons/check?style=solid */
}

.mentions-empty-title {
	margin: 0.75rem 0 0.25rem;
	font-weight: 700;
}

.mentions-empty-hint {
	margin: 0 auto;
	max-width: 18rem;
	font-size: 0.875rem;
	color: var(--body-color-muted);
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
import {dismissMentions} from "../js/mentions";
import eventbus from "../js/eventbus";
import {switchToChannel} from "../js/router";
import {entryKey, groupByConversation} from "../js/helpers/inbox";
import localetime from "../js/helpers/localetime";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {computed, defineComponent, ref, onMounted, onUnmounted} from "vue";
import {useStore} from "../js/store";
import type {InboxEntry} from "../../shared/types/mention";
import type {NetChan} from "../js/types";

type MentionWithContext = InboxEntry & {
	key: string;
	localetime: string;
};

type GroupWithContext = {
	key: string;
	target: string;
	networkName: string;
	label: string;
	conversation: NetChan | null;
	entries: MentionWithContext[];
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

		const groups = computed((): GroupWithContext[] => {
			const several = store.state.networks.length > 1;

			return groupByConversation(store.getters.visibleMentions).map((group) => {
				const conversation = store.getters.findConversation(group.network, group.target);
				const target = conversation?.channel.name ?? group.target;
				const networkName =
					several || !conversation ? conversation?.network.name ?? "" : "";

				return {
					key: group.key,
					target,
					networkName,
					label: networkName ? `${target} on ${networkName}` : target,
					conversation,
					entries: group.entries.map((entry) => ({
						...entry,
						key: entryKey(entry),
						localetime: localetime(new Date(entry.time)),
					})),
				};
			});
		});

		const total = computed(() =>
			groups.value.reduce((sum, group) => sum + group.entries.length, 0)
		);

		const messageTime = (time: string) => {
			return dayjs(time).fromNow();
		};

		const dismissMention = (message: MentionWithContext) => {
			dismissMentions([message]);
		};

		const dismissGroup = (group: GroupWithContext) => {
			dismissMentions(group.entries);
		};

		// Opening it reads it, and reading it clears its mentions (inbox:read).
		const openGroup = (group: GroupWithContext) => {
			if (group.conversation) {
				isOpen.value = false;
				switchToChannel(group.conversation.channel);
			}
		};

		// A click on the row opens the conversation; one on a link, a nick
		// or a channel in the text, or a selection being made, does not.
		const openFromRow = (event: MouseEvent, group: GroupWithContext) => {
			const target = event.target as HTMLElement | null;

			if (target?.closest("a, button, .user, .inline-channel")) {
				return;
			}

			if (window.getSelection()?.toString()) {
				return;
			}

			openGroup(group);
		};

		// What is shown: a muted conversation's entries stay out of it.
		const dismissAllMentions = () => {
			dismissMentions(store.getters.visibleMentions);
		};

		const containerClick = (event: Event) => {
			if (event.currentTarget === event.target) {
				isOpen.value = false;
			}
		};

		const togglePopup = () => {
			isOpen.value = !isOpen.value;
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
			groups,
			total,
			messageTime,
			dismissMention,
			dismissGroup,
			dismissAllMentions,
			openGroup,
			openFromRow,
			containerClick,
		};
	},
});
</script>
