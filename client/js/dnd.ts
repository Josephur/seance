/**
 * The global do-not-disturb, page side: the stored state (`thelounge.dnd`,
 * kept in step across this device's tabs by the `storage` event), the
 * verdict re-judged on every change and whenever it can next change by
 * itself (helpers/dnd.ts `nextChangeAt`), pushed to every
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
	editSchedule,
	nextChangeAt,
	parseDndState,
	presenceSummary,
	SUMMARY_LABELS,
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

let started = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function apply(): void {
	setGlobalDndAll(verdict.value.active, verdict.value.until);

	if (started) {
		armWake();
	}
}

/**
 * Wake when the verdict can next change: a timed DND's end or a window's
 * start on the dot, not up to a minute late, and the minute boundary at the
 * latest (mute entries expire and renew on the clock, with no line from the
 * server).
 */
function armWake(): void {
	if (wakeTimer !== null) {
		clearTimeout(wakeTimer);
	}

	const at = nextChangeAt(state, new Date());
	wakeTimer = setTimeout(() => {
		wakeTimer = null;
		now.value = new Date();
		apply();
		syncPresenceAll();
	}, Math.max(0, at - Date.now()) + 50);
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

const summary = computed(() =>
	presenceSummary(store.state.networks.map((n) => n.presence?.mode ?? "auto"))
);

/**
 * The pill's words: the page's own DND (with its end), then one shared from
 * another device, then what the networks' modes say together.
 */
const pillLabel = computed(() => {
	if (verdict.value.active) {
		return describeDnd(verdict.value, now.value, !!store.state.settings.use12hClock);
	}

	if (remoteOnly.value) {
		return "Do not disturb";
	}

	return SUMMARY_LABELS[summary.value];
});

/** The pill dot's colour: `dnd`, `away`, `mixed` or `online`. */
const pillState = computed(() => {
	if (verdict.value.active || remoteOnly.value || summary.value === "dnd") {
		return "dnd";
	}

	return summary.value === "away" || summary.value === "mixed" ? summary.value : "online";
});

function start(): void {
	if (started) {
		return;
	}

	started = true;
	apply();
	// Another tab of this device changed it: take its state, claim nothing
	// (that tab claimed, on its own connections).
	window.addEventListener("storage", (e) => {
		if (e.key === KEY) {
			Object.assign(state, parseDndState(e.newValue));
			now.value = new Date();
			apply();
		}
	});
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
	pillState,
	start,
	setManual(manual: DndManual): void {
		now.value = new Date();
		saveByHand({...state, manual});
	},
	setSchedule(schedule: DndSchedule): void {
		now.value = new Date();
		saveByHand(editSchedule(state, schedule, now.value));
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
