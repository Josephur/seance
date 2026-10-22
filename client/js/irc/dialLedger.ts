/**
 * The dial ledger: this device's own record of when it dialled each server,
 * so the transport never dials into nefarious2's connection throttle.
 *
 * IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`, at accept time, before
 * TLS or the WebSocket upgrade) counts the connections from an address: the
 * count restarts after a gap of more than `IPCHECK_CLONE_PERIOD` (40 s) since
 * `last_connect`, and the connection that brings it to `IPCHECK_CLONE_LIMIT`
 * (4) is refused — and a refused one still counts as the last connection, so
 * dialling into a refusal renews it. `last_connect` also moves when the
 * address's last connection closes (`ip_registry_disconnect`), which resets
 * the count only when that is more than four windows after it; the server
 * counts whole seconds (`CurrentTime`). So the ledger keeps the closes of
 * sockets that had opened too, and replays both in whole seconds. Over a WebSocket the refusal looks like
 * any lost connection (1006). A phone whose OS drops the socket on every app
 * switch makes a new connection on every return; the fourth return inside the
 * chain was refused, and the reconnect schedule's quick retries (0, 1, 2, 4 s
 * …) each renewed it, a lockout of a minute or more. With the ledger the
 * transport waits out the gap instead: one wait of at most
 * `periodMs + marginMs` (docs/projects/reconnect-throttle.md).
 *
 * Kept in `thelounge.state.dials` (`{host: {d: [dial ms…], c: [close ms…]}}`;
 * a bare array is an older record of dials only), so a reloaded or
 * reopened app and another tab see the same record. Other devices behind the
 * same address (home Wi-Fi, carrier NAT) count on the server too and are not
 * seen here. Vue-free and DOM-free; tests: test/irc/dialLedger.ts.
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

const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * Replay the server's count over this device's dials (and the closes of its
 * sockets): the wait before a dial at `now` would get in. Never more than one
 * window, whatever the record says.
 */
export function throttleWaitMs(
	dials: readonly number[],
	now: number,
	rule: ThrottleRule,
	closes: readonly number[] = []
): number {
	const period = seconds(rule.periodMs);
	const events = [
		...dials.map((at) => ({at, dial: true})),
		...closes.map((at) => ({at, dial: false})),
	].sort((a, b) => a.at - b.at || Number(a.dial) - Number(b.dial));
	let attempts = 0;
	let last: number | undefined;

	for (const {at, dial} of events) {
		const gap = last === undefined ? Infinity : seconds(at) - seconds(last);

		if (dial) {
			if (gap > period) {
				attempts = 0;
			}

			attempts++;
		} else if (gap > rule.limit * period) {
			attempts = 0;
		}

		last = at;
	}

	if (last === undefined || seconds(now) - seconds(last) > period || attempts + 1 < rule.limit) {
		return 0;
	}

	// The first whole second past the window, plus the time the dial takes.
	const wait = (seconds(last) + period + 1) * 1000 + rule.marginMs - now;
	return Math.min(rule.periodMs + 1000 + rule.marginMs, Math.max(0, wait));
}

function hostRecord(value: unknown, now: number): HostRecord {
	const past = (list: unknown): number[] =>
		Array.isArray(list)
			? list.filter((t): t is number => typeof t === "number" && t <= now)
			: [];

	if (Array.isArray(value)) {
		return {d: past(value), c: []};
	}

	const record = value as Partial<HostRecord> | null;
	return {d: past(record?.d), c: past(record?.c)};
}

/** The gate for one server host, over the shared record. */
export function dialGateFor(host: string, rule: ThrottleRule = NEFARIOUS_RULE): DialGate {
	const key = host.toLowerCase();
	// An event "in the future" was recorded by a clock that has since gone
	// back: it says nothing about now.
	const read = (now: number) => hostRecord(readRecord(backend.get(STORAGE_KEY))[key], now);

	const add = (at: number, field: keyof HostRecord) => {
		// Older than a whole refused chain can reach: it no longer counts.
		const horizon = at - rule.limit * rule.periodMs;
		const record = read(at);
		record[field] = [...record[field], at];
		const all = {...readRecord(backend.get(STORAGE_KEY))};
		all[key] = {d: record.d.filter((t) => t > horizon), c: record.c.filter((t) => t > horizon)};
		backend.set(STORAGE_KEY, JSON.stringify(all));
	};

	return {
		waitMs(now) {
			const record = read(now);
			return throttleWaitMs(record.d, now, rule, record.c);
		},
		record: (at) => add(at, "d"),
		closed: (at) => add(at, "c"),
	};
}
