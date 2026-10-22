/**
 * The dial ledger: this device's own record of when it dialled each server,
 * so the transport never dials into nefarious2's connection throttle.
 *
 * IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`, at accept time, before
 * TLS or the WebSocket upgrade) counts the connections from an address: the
 * count restarts after a gap of more than `IPCHECK_CLONE_PERIOD` (40 s) since
 * the last one, and the connection that brings it to `IPCHECK_CLONE_LIMIT`
 * (4) is refused — and a refused one still counts as the last connection, so
 * dialling into a refusal renews it. Over a WebSocket the refusal looks like
 * any lost connection (1006). A phone whose OS drops the socket on every app
 * switch makes a new connection on every return; the fourth return inside the
 * chain was refused, and the reconnect schedule's quick retries (0, 1, 2, 4 s
 * …) each renewed it, a lockout of a minute or more. With the ledger the
 * transport waits out the gap instead: one wait of at most
 * `periodMs + marginMs` (docs/projects/reconnect-throttle.md).
 *
 * Kept in `thelounge.state.dials` (`{host: [ms…]}`), so a reloaded or
 * reopened app and another tab see the same record. Other devices behind the
 * same address (home Wi-Fi, carrier NAT) count on the server too and are not
 * seen here. Vue-free and DOM-free; tests: test/irc/dialLedger.ts.
 */

import storage from "../localStorage";

export interface ThrottleRule {
	/** The connection that brings the count to this is refused. */
	limit: number;
	/** A gap longer than this restarts the count. */
	periodMs: number;
	/** Added to a wait: the server compares whole seconds, and the dial takes a while to arrive. */
	marginMs: number;
}

/** nefarious2's defaults (`ircd_features.c`). */
export const NEFARIOUS_RULE: ThrottleRule = {limit: 4, periodMs: 40_000, marginMs: 2_000};

export interface DialGate {
	/** How long to wait before a dial at `now` would be accepted; 0 = dial now. */
	waitMs(now: number): number;
	/** A dial was made at `at`. */
	record(at: number): void;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

const STORAGE_KEY = "thelounge.state.dials";
let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/** Replay the server's count over `dials`: the wait before a dial at `now` would get in. */
export function throttleWaitMs(dials: readonly number[], now: number, rule: ThrottleRule): number {
	let attempts = 0;
	let last = -Infinity;

	for (const at of [...dials].sort((a, b) => a - b)) {
		if (at - last > rule.periodMs) {
			attempts = 0;
		}

		last = at;
		attempts++;
	}

	if (now - last > rule.periodMs || attempts + 1 < rule.limit) {
		return 0;
	}

	// Never more than one window: a record from a clock that ran ahead must
	// not hold the network for however far ahead it ran.
	return Math.min(
		rule.periodMs + rule.marginMs,
		Math.max(0, last + rule.periodMs + rule.marginMs - now)
	);
}

function readAll(): Record<string, number[]> {
	try {
		const parsed: unknown = JSON.parse(backend.get(STORAGE_KEY) ?? "{}");
		return parsed && typeof parsed === "object" ? (parsed as Record<string, number[]>) : {};
	} catch {
		return {};
	}
}

/** The gate for one server host, over the shared record. */
export function dialGateFor(host: string, rule: ThrottleRule = NEFARIOUS_RULE): DialGate {
	const key = host.toLowerCase();

	// A dial "in the future" was recorded by a clock that has since gone back:
	// it says nothing about now.
	const dials = (now: number): number[] => {
		const list = readAll()[key];
		return Array.isArray(list) ? list.filter((t) => typeof t === "number" && t <= now) : [];
	};

	return {
		waitMs: (now) => throttleWaitMs(dials(now), now, rule),
		record(at) {
			// Older than a whole refused chain can reach: it no longer counts.
			const horizon = at - rule.limit * rule.periodMs;
			const all = readAll();
			all[key] = [...dials(at), at].filter((t) => t > horizon);
			backend.set(STORAGE_KEY, JSON.stringify(all));
		},
	};
}
