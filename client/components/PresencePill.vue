<template>
	<div class="presence-pill-row">
		<button
			type="button"
			:class="['presence-pill', {'is-dnd': isDnd}]"
			aria-haspopup="menu"
			:aria-label="`Presence: ${label}`"
			@click="openMenu"
		>
			<span :class="['presence-dot', isDnd ? 'is-dnd' : 'is-online']" aria-hidden="true" />
			<span class="presence-pill-text">{{ label }}</span>
			<span class="presence-pill-caret" aria-hidden="true" />
		</button>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useRouter} from "vue-router";
import dnd from "../js/dnd";
import eventbus from "../js/eventbus";
import type {ContextMenuItem} from "../js/helpers/contextMenu";

const HOUR = 3600_000;

// The global do-not-disturb switch under the sidebar logo (client/js/dnd.ts):
// the pill says what holds now, its menu sets it.
export default defineComponent({
	name: "PresencePill",
	setup() {
		const router = useRouter();
		const isDnd = computed(() => dnd.verdict.value.active || dnd.remoteOnly.value);
		const label = computed(() => dnd.pillLabel.value);

		const openMenu = (event: MouseEvent) => {
			const manual = dnd.state.manual;
			const schedule = dnd.state.schedule;
			const tick = (on: boolean, text: string) => (on ? `${text} ✓` : text);
			const items: ContextMenuItem[] = [
				{label: "Off", type: "item", class: "dnd-off", action: () => dnd.turnOff()},
				{
					label: "For 1 hour",
					type: "item",
					class: "dnd-1h",
					action: () => dnd.setManual({kind: "until", until: Date.now() + HOUR}),
				},
				{
					label: "For 8 hours",
					type: "item",
					class: "dnd-8h",
					action: () => dnd.setManual({kind: "until", until: Date.now() + 8 * HOUR}),
				},
				{
					label: tick(manual.kind === "indefinite", "Until I turn it off"),
					type: "item",
					class: "dnd-indefinite",
					action: () => dnd.setManual({kind: "indefinite"}),
				},
				{type: "divider"},
				{
					label: tick(
						schedule.enabled,
						`Follow schedule (${schedule.start}–${schedule.end})`
					),
					type: "item",
					class: "dnd-schedule",
					action: () => dnd.followSchedule(!dnd.state.schedule.enabled),
				},
				{
					label: "Edit schedule…",
					type: "item",
					class: "dnd-edit-schedule",
					action: () => void router.push({name: "Notifications"}),
				},
			];
			eventbus.emit("contextmenu:items", {event, items});
		};

		return {isDnd, label, openMenu};
	},
});
</script>
