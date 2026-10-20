/**
 * Paced per-channel catch-up after our JOIN: the history fetch
 * (`CHATHISTORY`) and the read-marker fetch (`MARKREAD`) for each channel.
 *
 * Why a queue: ircu-family servers (nefarious2 included) charge every
 * command from a non-oper about 2 s of "fake lag" (`lag = 2 + len/120`,
 * `parse.c`) and stop reading the socket once the client is 10 s ahead
 * (`s_bsd.c`). Firing MODE + CHATHISTORY + MARKREAD for every autojoined
 * channel the moment its JOIN echoes back put ~65 commands on the wire for 15
 * channels; the server then drained them at one per 2 s and the user's first
 * message queued behind all of it (measured 2026-08-27, see
 * docs/projects/connect-burst.md).
 *
 * So: the channel the user is looking at is served at once, everything else
 * one channel per {@link CATCHUP_INTERVAL_MS} — the two commands of a step
 * cost 4 s of lag, so this cadence keeps the penalty flat and the user's own
 * lines go out immediately. Opening a channel that is still waiting serves
 * it right away. Nothing here touches the store; tests drive it with fake
 * timers (`test/irc/catchup.ts`).
 */

import {ChanState} from "../../../shared/types/chan";
import type {Channel, MsgRef} from "./channel";
import type {IrcClient} from "./client";
import {fetchReadMarker, markReadEnabled} from "./handlers/markread";
import {requestChannelHistory, retryLostHistory} from "./history";
import {formatLine} from "./message";

/** Spacing between background catch-up steps (one channel each). */
export const CATCHUP_INTERVAL_MS = 4000;

interface PendingCatchup {
	chan: Channel;
	/** The channel's newest known message before this JOIN (reconnect catch-up). */
	before: MsgRef | undefined;
	/** History + marker already went out with the JOIN; only the modes are left. */
	prefetched: boolean;
	/** A query: no history to fetch, only its read marker (served after the channels). */
	markerOnly?: boolean;
}

interface CatchupState {
	queue: PendingCatchup[];
	timer: ReturnType<typeof setTimeout> | null;
	lastStepAt: number;
	/** Queries whose marker went out on this connection: asked once, like a channel's history. */
	asked: Set<Channel>;
}

const states = new WeakMap<IrcClient, CatchupState>();

function stateOf(client: IrcClient): CatchupState {
	let state = states.get(client);

	if (!state) {
		state = {queue: [], timer: null, lastStepAt: 0, asked: new Set()};
		states.set(client, state);
	}

	return state;
}

/** Channels still waiting for their catch-up, in order (tests / diagnostics). */
export function pendingCatchup(client: IrcClient): readonly Channel[] {
	return stateOf(client).queue.map((p) => p.chan);
}

/**
 * Send the history + marker fetch for `chan` right behind its JOIN, before
 * the echo: the server processes lines in order, so membership holds by the
 * time it reads them. Used for the active channel at connect time; the JOIN
 * echo then only has the modes left to ask for.
 */
export function prefetchCatchup(client: IrcClient, chan: Channel): void {
	const state = stateOf(client);
	state.lastStepAt = Date.now();
	chan.catchupPrefetched = true;
	fetchFor(client, chan, chan.newestRef);
}

/**
 * Our JOIN to `chan` was confirmed: queue its history + read-marker fetch.
 * The active channel jumps the queue and is served now.
 */
export function enqueueCatchup(client: IrcClient, chan: Channel, before: MsgRef | undefined): void {
	const state = stateOf(client);
	const prefetched = chan.catchupPrefetched;
	chan.catchupPrefetched = false;

	if (prefetched && (chan.id !== client.activeChannelId || chan.modesKnown)) {
		return; // nothing left to ask for
	}

	const existing = state.queue.find((p) => p.chan === chan);

	if (existing) {
		existing.before = before;
		existing.prefetched = prefetched;
	} else if (chan.id === client.activeChannelId) {
		state.queue.unshift({chan, before, prefetched});
	} else {
		state.queue.push({chan, before, prefetched});
	}

	if (chan.id === client.activeChannelId) {
		serveNow(client, state);
		return;
	}

	// A timer a query's marker fetch armed (enqueueMarkerFetch) would hold
	// this channel past its turn: re-arm from the last step.
	clearTimer(state);
	pump(client, state);
}

/**
 * After registration: ask for a query's read marker, so a private message
 * read on another device while this one was away stops counting here.
 * Queries are never JOINed, so nothing else asks, and the server volunteers
 * markers only for channels. Behind every channel, and skipped without
 * spending a slot while the query has nothing unread to lower. Never
 * queued for a server without the cap (the send would be refused and the
 * slot spent), and once per connection: `autojoin()` runs again after a
 * held session's restoration, by when a replay may have asked already.
 * Never stepped at once at registration (`lastStepAt` 0): the JOINs'
 * echoes are still in flight and nothing is queued ahead of it, so it
 * waits a slot, by which time they have queued their channels, which
 * {@link step} serves first. Later, when the queue has long drained, it
 * goes out as soon as the last step allows.
 */
export function enqueueMarkerFetch(client: IrcClient, chan: Channel): void {
	const state = stateOf(client);

	if (
		!markReadEnabled(client) ||
		state.asked.has(chan) ||
		state.queue.some((p) => p.chan === chan)
	) {
		return;
	}

	state.queue.push({chan, before: undefined, prefetched: false, markerOnly: true});

	if (state.timer !== null) {
		return;
	}

	if (state.lastStepAt === 0) {
		arm(client, state, CATCHUP_INTERVAL_MS);
	} else {
		pump(client, state);
	}
}

/** The user opened `chan`: if it is still waiting, serve it immediately. */
export function prioritiseCatchup(client: IrcClient, chan: Channel): void {
	const state = stateOf(client);
	const index = state.queue.findIndex((p) => p.chan === chan);

	if (index === -1) {
		return;
	}

	if (state.queue[index].markerOnly) {
		// A query's marker fetch keeps its turn: opened with someone looking,
		// the query is read (IrcClient.open) and step() skips it on
		// `unread === 0` without spending a slot; with nobody looking the open
		// reads nothing, so the server's marker is still wanted. A PM that
		// lands after the user leaves again is the case the fetch is for.
		return;
	}

	const [pending] = state.queue.splice(index, 1);
	state.queue.unshift(pending);
	serveNow(client, state);
}

/** Forget a channel we left / removed while it was waiting. */
export function dropFromCatchup(client: IrcClient, chan: Channel): void {
	const state = stateOf(client);
	state.queue = state.queue.filter((p) => p.chan !== chan);

	if (state.queue.length === 0) {
		clearTimer(state);
	}
}

/** Transport closed: nothing queued survives (the reconnect re-JOINs). */
export function cancelCatchup(client: IrcClient): void {
	const state = stateOf(client);
	state.queue = [];
	state.lastStepAt = 0;
	state.asked.clear();
	clearTimer(state);
}

function clearTimer(state: CatchupState): void {
	if (state.timer !== null) {
		clearTimeout(state.timer);
		state.timer = null;
	}
}

/** Run the head of the queue now (the user is waiting for it), then keep pacing. */
function serveNow(client: IrcClient, state: CatchupState): void {
	clearTimer(state);
	step(client, state);
}

/** Schedule the next step so that steps are at least CATCHUP_INTERVAL_MS apart. */
function pump(client: IrcClient, state: CatchupState): void {
	if (state.timer !== null || state.queue.length === 0) {
		return;
	}

	const wait = state.lastStepAt + CATCHUP_INTERVAL_MS - Date.now();

	if (wait <= 0) {
		step(client, state);
		return;
	}

	arm(client, state, wait);
}

/** Step in `wait` ms. */
function arm(client: IrcClient, state: CatchupState, wait: number): void {
	state.timer = setTimeout(() => {
		state.timer = null;
		step(client, state);
	}, wait);
}

function step(client: IrcClient, state: CatchupState): void {
	const channel = state.queue.findIndex((p) => !p.markerOnly);
	const [next] = state.queue.splice(channel === -1 ? 0 : channel, 1);

	if (!next) {
		return;
	}

	if (next.markerOnly) {
		if (
			next.chan.shared.unread === 0 ||
			!client.channels.includes(next.chan) ||
			client.transport.state !== "open"
		) {
			pump(client, state);
			return;
		}

		// One command, where a channel's step sends two: half a slot.
		state.lastStepAt = Date.now() - CATCHUP_INTERVAL_MS / 2;
		state.asked.add(next.chan);
		fetchReadMarker(client, next.chan);
		pump(client, state);
		return;
	}

	// Left again while waiting (or the socket went): skip without spending a slot.
	if (next.chan.state !== ChanState.JOINED || client.transport.state !== "open") {
		pump(client, state);
		return;
	}

	state.lastStepAt = Date.now();

	if (!next.prefetched) {
		fetchFor(client, next.chan, next.before);
	}

	// The modes line is cosmetic: other channels ask on first open
	// (IrcClient.open); the one being looked at gets it with its catch-up.
	if (next.chan.id === client.activeChannelId && !next.chan.modesKnown) {
		next.chan.modesKnown = true;
		client.send(formatLine({command: "MODE", params: [next.chan.name]}));
	}

	pump(client, state);
}

function fetchFor(client: IrcClient, chan: Channel, before: MsgRef | undefined): void {
	// nefarious2 volunteers the marker after a logged-in account's JOIN, a
	// held session's restore included; asking when we still have none is
	// defensive. First, so the answer is in before the history it decides
	// the unread count of (deliverPrepend): the server replies in order.
	if (!chan.readMarker) {
		fetchReadMarker(client, chan);
	}

	requestChannelHistory(client, chan, before);
	retryLostHistory(client, chan);
}
