/**
 * The global do-not-disturb, page side: the stored state (`thelounge.dnd`),
 * the verdict re-judged every minute and on every change, pushed to every
 * IRC client (manager.setGlobalDndAll); a DND shared from another device
 * read off the networks' presence. Model: helpers/dnd.ts. Spec:
 * docs/projects/do-not-disturb.md.
 */
import {computed, reactive, ref} from "vue";
import socket from "./socket";
import storage from "./localStorage";
import {store} from "./store";
import {
	describeDnd,
	dndAt,
	parseDndState,
	reconcileRemote,
	serializeDndState,
	turnOff as modelTurnOff,
	type DndManual,
	type DndSchedule,
	type DndState,
} from "./helpers/dnd";
import {claimMuteAll, clearRemoteDndAll, setGlobalDndAll, syncPresenceAll} from "./irc/manager";

const KEY = "thelounge.dnd";
const now = ref(new Date());
const state = reactive<DndState>(parseDndState(storage.get(KEY)));
const verdict = computed(() => dndAt(state, now.value));

function apply(): void {
	setGlobalDndAll(verdict.value.active, verdict.value.until);
}

/**
 * A change the user made here: every network's live `*` entry becomes
 * ours (irc/pushMute.ts claimMute), so the new want is written over it,
 * whoever wrote it. Claimed before the save, whose apply syncs at once.
 */
function saveByHand(next: DndState): void {
	claimMuteAll();
	save(next);
	// The verdict may not have changed (no sync ran): take the claim now.
	syncPresenceAll();
}

function save(next: DndState): void {
	Object.assign(state, next);
	storage.set(KEY, serializeDndState(state));
	apply();
}

const connected = computed(() => store.state.networks.filter((n) => n.status.connected));
const remoteOnly = computed(
	() =>
		!verdict.value.active &&
		connected.value.length > 0 &&
		connected.value.every((n) => n.presence?.dnd && n.presence.mode !== "dnd")
);

const pillLabel = computed(() => {
	if (verdict.value.active) {
		return describeDnd(verdict.value, now.value, !!store.state.settings.use12hClock);
	}

	if (remoteOnly.value) {
		return "Do not disturb";
	}

	const modes = new Set(store.state.networks.map((n) => n.presence?.mode ?? "auto"));
	return modes.size === 1 && modes.has("auto") ? "Online · auto" : "Online";
});

let started = false;

function start(): void {
	if (started) {
		return;
	}

	started = true;
	apply();
	setInterval(() => {
		now.value = new Date();
		apply();
		// Mute entries expire and renew on the clock, with no line from the server.
		syncPresenceAll();
	}, 60_000);
	// Another device turned the shared DND off (irc/pushMute.ts).
	socket.on("dnd:cleared", () => {
		const next = reconcileRemote(state, new Date());

		if (next !== state) {
			now.value = new Date();
			save(next);
		}
	});
}

export default {
	state,
	verdict,
	remoteOnly,
	pillLabel,
	start,
	setManual(manual: DndManual): void {
		now.value = new Date();
		saveByHand({...state, manual});
	},
	setSchedule(schedule: DndSchedule): void {
		now.value = new Date();
		saveByHand({...state, schedule, scheduleSkippedUntil: null});
	},
	followSchedule(on: boolean): void {
		now.value = new Date();
		saveByHand({
			...state,
			schedule: {...state.schedule, enabled: on},
			scheduleSkippedUntil: null,
		});
	},
	turnOff(): void {
		now.value = new Date();
		saveByHand(modelTurnOff(state, now.value));
		clearRemoteDndAll();
	},
};
