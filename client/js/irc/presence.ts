/**
 * Attention: is a person looking at this client?
 *
 * The server pushes a notification only when nobody is attending the
 * account, and it judges that from each connection's away state and how
 * recently it spoke. "Spoke recently" is the wrong proxy for a phone: say
 * something, switch apps, and the reply goes unpushed for the whole idle
 * window while the frozen tab shows nothing either. The client knows
 * better, and `draft/pre-away` gives it the words: `AWAY *` means "not
 * present for an unspecified reason", per connection, and never overrides
 * a human away message set elsewhere. So a hidden page says `AWAY *`, a
 * page that comes back says `AWAY`, and the server's attention rule (and
 * its away aggregation) does the rest.
 *
 * Two things this must not do: clobber an away the user set with `/away`
 * (that is theirs until `/back`), and mark messages read while nobody is
 * there — `IrcClient.pushMessage` only schedules a MARKREAD for the open
 * channel while attended, and the return of attention marks it then.
 *
 * Vue-free and DOM-free: foreground.ts translates visibility and focus
 * into `setAttended`, tests call it directly.
 */

import type {IrcClient} from "./client";
import {formatLine} from "./message";
import {scheduleMarkRead} from "./handlers/markread";
import {syncPushMute} from "./pushMute";
import type {SharedNetworkPresence} from "../../../shared/types/network";

/** `draft/pre-away`: away for an unspecified reason. */
export const AWAY_STAR = "*";

/**
 * How long a visible-but-unfocused page waits before saying `AWAY *`. A
 * hidden page says it at once (that is the phone case); an alt-tab on a
 * desktop should not flap the state.
 */
export const UNFOCUSED_AWAY_MS = 60_000;

export interface PresenceState {
	/** A person is (probably) looking: page visible and focused. */
	attended: boolean;
	/** `/away` is in force; automatic `AWAY *` keeps its hands off. */
	userAway: boolean;
	/** This client sent `AWAY *` and has not cleared it. */
	starSent: boolean;
	/**
	 * Automatic AWAY commands whose replies (RPL_NOWAWAY / RPL_UNAWAY) are
	 * still to come and should not be shown: switching apps is not news.
	 * Replies arrive in send order, so a count is enough; a user's own
	 * `/away` sent after ours is still acknowledged.
	 */
	quietReplies: number;
	/** The last `network:presence` payload dispatched, as JSON. */
	lastReported: string;
}

export function initialPresence(): PresenceState {
	return {attended: true, userAway: false, starSent: false, quietReplies: 0, lastReported: ""};
}

function canSend(client: IrcClient): boolean {
	return client.transport.state === "open" && client.isConnected;
}

/** Do not disturb in force on this network. */
export function effectiveDnd(client: IrcClient): boolean {
	return client.globalDnd.active || client.presenceMode === "dnd" || client.remoteDnd;
}

/** Whether this connection should be `AWAY *` (ignoring `/away`). */
export function wantsStar(client: IrcClient): boolean {
	const mode = client.presenceMode;

	return (
		effectiveDnd(client) || mode === "away" || (mode === "auto" && !client.presence.attended)
	);
}

export function presenceSnapshot(client: IrcClient): SharedNetworkPresence {
	const p = client.presence;

	return {
		mode: client.presenceMode,
		dnd: effectiveDnd(client),
		away: p.userAway || p.starSent,
	};
}

/**
 * Bring the server in line with what this client wants: `AWAY *` or `AWAY`,
 * unless the user's own `/away` is in force; then report the presence to the
 * store and keep the push mute in step.
 */
export function syncPresence(client: IrcClient): void {
	const p = client.presence;

	if (!p.userAway && canSend(client)) {
		const want = wantsStar(client);

		if (want && !p.starSent) {
			p.starSent = true;
			p.quietReplies++;
			client.send(formatLine({command: "AWAY", params: [AWAY_STAR]}));
		} else if (!want && p.starSent) {
			p.starSent = false;
			p.quietReplies++;
			client.send(formatLine({command: "AWAY", params: []}));
		}
	}

	reportPresence(client);
}

/** Tell the store the presence if it changed, and keep the push mute in step. */
export function reportPresence(client: IrcClient): void {
	const p = client.presence;
	const snapshot = presenceSnapshot(client);
	const json = JSON.stringify(snapshot);

	if (json !== p.lastReported) {
		p.lastReported = json;
		client.dispatchBus("network:presence", {network: client.uuid, presence: snapshot});
	}

	syncPushMute(client);
}

/**
 * The page's attention changed. Tell the server (`AWAY *` / `AWAY`) unless
 * the user set an away of their own, and when attention returns, mark the
 * open channel read as the user would by looking at it.
 */
export function setAttended(client: IrcClient, attended: boolean): void {
	const p = client.presence;

	if (p.attended === attended) {
		return;
	}

	p.attended = attended;
	syncPresence(client);

	if (attended) {
		const chan = client.activeChannel();

		if (chan) {
			scheduleMarkRead(client, chan);
		}
	}
}

/**
 * Called for each RPL_NOWAWAY / RPL_UNAWAY: true when it answers one of our
 * automatic AWAY commands and should stay silent.
 */
export function takeQuietAwayReply(client: IrcClient): boolean {
	const p = client.presence;

	if (p.quietReplies > 0) {
		p.quietReplies--;
		return true;
	}

	return false;
}

/**
 * The user ran `/away` (`away` true) or `/back`. State only: the command
 * sends its own line (`/away` its message, `/back` through `sendBack`).
 */
export function userAwayChanged(client: IrcClient, away: boolean): void {
	const p = client.presence;
	p.userAway = away;
	// Whatever the user said replaces ours.
	p.starSent = false;
	reportPresence(client);
}

/**
 * `/back`: one line, whichever state the client wants — `AWAY *` while a
 * mode, do not disturb or a hidden page calls for it, else `AWAY`. Its reply
 * is the user's acknowledgement, so it is not counted as quiet.
 */
export function sendBack(client: IrcClient): void {
	const p = client.presence;
	const star = wantsStar(client);
	p.starSent = star;
	client.send(formatLine({command: "AWAY", params: star ? [AWAY_STAR] : []}));
	reportPresence(client);
}

/** The connection closed: whatever we told that server is gone with it. */
export function presenceClosed(client: IrcClient): void {
	client.presence.starSent = false;
	client.presence.quietReplies = 0;
	reportPresence(client);
}

/** Registration done: a page that is hidden while it connects says so. */
export function presenceRegistered(client: IrcClient): void {
	client.presence.starSent = false;
	syncPresence(client);
}
