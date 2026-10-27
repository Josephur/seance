/**
 * The dial ledger: this device's own record of when it dialled each server
 * and when its connections dropped, so the transport does not dial into
 * nefarious2's connection throttle (as far as this device can know: other
 * devices behind the same address count on the server too and are not seen).
 *
 * IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`, at accept time, before
 * TLS or the WebSocket upgrade) counts the connections from an address: the
 * count restarts after a gap of more than `IPCHECK_CLONE_PERIOD` (40 s) since
 * `last_connect`, and the connection that brings it to `IPCHECK_CLONE_LIMIT`
 * (4) is refused — and a refused one still counts as the last connection, so
 * dialling into a refusal renews it. `last_connect` also moves when the
 * address's last connection closes (`ip_registry_disconnect`), which resets
 * the count only when that is more than four windows after it — but not when
 * the bouncer holds the session (`bounce_hold_client` never calls
 * `IPcheck_disconnect`), so the client records a drop only for a session that
 * is not held (`IrcClient.createTransport`, `noteUnload` for the unload the
 * transport never sees). Counted at the accept, a dial that never opened
 * drops too: the transport records the end of every dial. The server counts whole seconds (`CurrentTime`) on
 * a clock a fraction of a second from this one, so the replay works in
 * milliseconds with a whole second and a margin to spare (`throttleWaitMs`).
 * Over a WebSocket a refusal looks like any lost connection (1006). A phone
 * whose OS drops the socket on every app switch makes a new connection on
 * every return; the fourth return inside the chain was refused, and the
 * reconnect schedule's quick retries (0, 1, 2, 4 s …) each renewed it, a
 * lockout of a minute or more. With the ledger the transport waits out the
 * gap instead: one wait of at most 42 s (docs/projects/reconnect-throttle.md).
 *
 * Kept in `thelounge.state.dials` (`{host: {d: [dial ms…], c: [drop ms…]}}`),
 * so a reloaded or reopened app and another tab see the same record.
 * Vue-free and DOM-free; tests: test/irc/dialLedger.ts.
 */

import storage from "../localStorage";
import {recordReader} from "../helpers/jsonRecord";

export interface ThrottleRule {
	/** The connection that brings the count to this is refused. */
	limit: number;
	/** A gap longer than this restarts the count. */
	periodMs: number;
	/** Added to a wait: the dial takes a while to reach the server. */
	marginMs: number;
}

/** nefarious2's defaults (`ircd_features.c`). */
export const NEFARIOUS_RULE: ThrottleRule = {limit: 4, periodMs: 40_000, marginMs: 1_000};

export interface DialGate {
	/** How long to wait before a dial at `now` would be accepted; 0 = dial now. */
	waitMs(now: number): number;
	/** A dial was made at `at`. */
	record(at: number): void;
	/** A socket that had opened closed at `at`. */
	closed(at: number): void;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

interface HostRecord {
	d: number[];
	c: number[];
}

const STORAGE_KEY = "thelounge.state.dials";
let backend: StorageBackend = storage;
const readRecord = recordReader<unknown>();

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/**
 * Replay the server's count over this device's dials (and the drops of its
 * sockets): the wait before a dial at `now` would get in. IPcheck compares
 * whole seconds, and the two clocks are a fraction of a second apart, so the
 * replay is conservative in milliseconds: a gap restarts the count only when
 * it is at least a whole second past the window plus the margin (42 s; 162 s
 * after a drop), and a dial waits for the same. Events dated after `now` (a
 * clock that has since gone back) say nothing about now.
 */
export function throttleWaitMs(
	dials: readonly number[],
	now: number,
	rule: ThrottleRule,
	closes: readonly number[] = []
): number {
	const gap = rule.periodMs + 1000 + rule.marginMs;
	const dropGap = rule.limit * rule.periodMs + 1000 + rule.marginMs;
	const events = [
		...dials.filter((at) => at <= now).map((at) => ({at, dial: true})),
		...closes.filter((at) => at <= now).map((at) => ({at, dial: false})),
	].sort((a, b) => a.at - b.at || Number(a.dial) - Number(b.dial));
	let attempts = 0;
	let last: number | undefined;

	for (const {at, dial} of events) {
		const since = last === undefined ? Infinity : at - last;

		if (dial) {
			if (since >= gap) {
				attempts = 0;
			}

			attempts++;
		} else if (since >= dropGap) {
			attempts = 0;
		}

		last = at;
	}

	if (last === undefined || now - last >= gap || attempts + 1 < rule.limit) {
		return 0;
	}

	return last + gap - now;
}

function hostRecord(value: unknown): HostRecord {
	const numbers = (list: unknown): number[] =>
		Array.isArray(list) ? list.filter((t): t is number => typeof t === "number") : [];
	const record = value as Partial<HostRecord> | null;
	return {d: numbers(record?.d), c: numbers(record?.c)};
}

/** The gate for one server host, over the shared record. */
export function dialGateFor(host: string): DialGate {
	const rule = NEFARIOUS_RULE;
	const key = host.toLowerCase();
	const read = () => hostRecord(readRecord(backend.get(STORAGE_KEY))[key]);

	const add = (at: number, field: keyof HostRecord) => {
		// Older than a whole refused chain can reach: it no longer counts.
		const horizon = at - rule.limit * rule.periodMs;
		const record = read();
		record[field] = [...record[field], at];
		const all = {...readRecord(backend.get(STORAGE_KEY))};
		all[key] = {d: record.d.filter((t) => t > horizon), c: record.c.filter((t) => t > horizon)};
		backend.set(STORAGE_KEY, JSON.stringify(all));
	};

	return {
		waitMs(now) {
			const record = read();
			return throttleWaitMs(record.d, now, rule, record.c);
		},
		record: (at) => add(at, "d"),
		closed: (at) => add(at, "c"),
	};
}
