# Do not disturb and per-network presence

Status: built, 2026-10-12. Branch `dnd` (from `origin/develop` `d9ec454d`).
This describes what was built; where the build changed the first plan, the
list at the end says so.

## What the user asked for

- A **do not disturb** state, switched on from a control next to the logo or
  by a **schedule**. While it is on the user stays away and neither browser
  notifications nor push notifications fire.
- A **presence mode per network**, chosen from the network list: **Online**
  (never away), **Auto** (away when not looking, today's behaviour), **Away**
  (always away), and **Do not disturb**.

Decisions taken in the design session (mock-ups:
<https://claude.ai/artifact/DAtxCRJ1BAPGMNyHXzktAF>):

| Question                        | Choice                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The global control              | **C**: a status pill under the logo, opening a menu                                                   |
| The per-network control         | **1**: a presence dot before the nick in the network's lobby row, opening the four modes              |
| What others see in Away and DND | Plain `AWAY *` for both (the server shows its `AWAY_STAR_MSG`, "Away"); nobody can tell DND from away |
| The schedule                    | One daily window (start, end, may cross midnight) and a set of weekdays                               |
| DND across the user's devices   | Shared: DND lives in the account's `draft/webpush/mute`, and every connected Seance reads it back     |

## Background: how away works today

`client/js/irc/presence.ts` sends `AWAY *` (`draft/pre-away`) when the page is
unattended — hidden at once, visible but unfocused after `UNFOCUSED_AWAY_MS`
(60 s) — and `AWAY` when attention returns, unless the user's own `/away` is in
force. `foreground.ts` feeds it through `manager.setAttendedAll`.

nefarious2 keeps each connection's state (present, away with a message,
`AWAY *`) and aggregates across the account's connections
(`bounce_compute_effective_away`): any present connection makes the user
present; `AWAY *` connections do not count; all `AWAY *` gives the
`AWAY_STAR_MSG` text. A change in the aggregate is broadcast to `away-notify`
clients in common channels. Consequence for this feature: **Away and DND
cannot override another device that is present on the same account.** They
mean "this client stops showing the user as present".

Push is gated by the account metadata key `draft/webpush/mute`
(`ircd/webpush_mute.c`): `;`-separated `target:until` entries (unix seconds),
`*` muting every target. The ircd notifies the account's own subscribed
connections when a key changes (`metadata_notify_subscribers`), which is what
makes a shared DND possible without a server change.

## 1. Model — `client/js/helpers/dnd.ts`

Vue-free, DOM-free, store-free; mocha loads it (`test/helpers/dnd.ts`).

```ts
type PresenceMode = "online" | "auto" | "away" | "dnd";

interface DndSchedule {
	enabled: boolean;
	start: string; // "HH:MM", local time
	end: string; // "HH:MM"; end <= start means the window crosses midnight
	days: number[]; // 0 = Sunday … 6; the day the window *starts* on
}

interface DndState {
	manual: {kind: "off"} | {kind: "until"; until: number} | {kind: "indefinite"};
	schedule: DndSchedule;
	// Off pressed inside a scheduled window: the window's end (ms). The
	// schedule is ignored until then.
	scheduleSkippedUntil: number | null;
}

dndAt(state, now: Date): {active: boolean; until: number | null; source: "manual" | "schedule" | null};
nextWindow(schedule, now: Date): {start: number; end: number} | null;
```

- Manual wins over the schedule while it is on; `until` in the past is off.
- **Off during a scheduled window** sets `scheduleSkippedUntil` to that
  window's end, so DND resumes with the next window, not the current one.
- An empty `days` list or `enabled: false` means no schedule.
- A window is judged in local time; a DST change is taken as it falls (the
  window is the wall-clock times, whatever their length that night).
- Stored in `thelounge.dnd` (JSON), carried by the settings backup (§6).

The global DND state is the one above. **Per network**, `SavedNetwork` gets
`presenceMode?: PresenceMode` (absent = `auto`), stored in
`thelounge.networks`; an unsaved network holds it on its `IrcClient` for the
session only. A `*` entry read back from the network's mute list (§4) is a
third input, `remoteDnd` on the client.

The **effective state** of a network:

```
dnd       = globalDnd.active || mode === "dnd" || remoteDnd
wantsStar = dnd || mode === "away" || (mode === "auto" && !attended)
```

`online` therefore never sends `AWAY *` — unless DND is on: DND always means
away.

## 2. Presence — `client/js/irc/presence.ts`

`setAttended` stops sending directly. A single `syncPresence(client)` compares
`wantsStar` with `starSent` and sends `AWAY *` or `AWAY` (quiet replies as
today); it is called when attention changes, when a mode or the DND state
changes (`manager.syncPresenceAll()`), and at registration
(`presenceRegistered`). Unchanged rules:

- `/away` (`userAway`) wins over everything; nothing automatic is sent while
  it is in force.
- `/back` sends exactly one line, chosen by the same rule (`sendBack`):
  `AWAY *` while DND, Away or an unattended Auto calls for it, else `AWAY`.
  Its reply is the user's acknowledgement, so it is not counted as a quiet
  one. `userAwayChanged` only records and reports the state; it sends
  nothing, so a `/back` in DND never sends an `AWAY *` + `AWAY` pair.
- Nothing is sent before 001 (`canSend`).
- A MARKREAD for the open channel is still scheduled only while the page is
  attended — attention, not presence mode, decides "the user has seen it".

## 3. Browser notifications — `client/js/socket-events/msg.ts`

`notifyMessage` returns before showing anything (and before the sound) when
the message's network is in DND. Unread counts, highlights, the mentions list
and the page title's count are untouched. The push worker's page
notifications (`webpush.pushWorkerFor`) go through the same function and are
covered by the same early return.

## 4. Push and sharing — `draft/webpush/mute`

A new Vue-free `client/js/irc/pushMute.ts` (`test/irc/pushMute.ts`):

- `parseMute(value)` / `formatMute(entries)` follow the server's grammar:
  entries split at the first `:`, an `until` of 0 or below is indefinite and
  live. `withGlobal(value, until)` and `withoutGlobal(value)` change only the
  `*` entry, keeping every other entry (per-channel mutes from other devices)
  and dropping expired ones; `globalUntil` is the live `*` entry's end
  (`Infinity` for an indefinite one).
- `IrcClient` keeps the last value seen (`muteValue`) and writes the merged
  value **private**: `METADATA * SET draft/webpush/mute private :<value>`.
  nefarious2 stores `* SET key *` as public, visible to anyone sharing a
  channel; a private value reaches only the account's own sessions, and the
  push gate reads it whatever its visibility. The clear (an empty value) is
  bare, `METADATA * SET draft/webpush/mute`, which deletes the key.
- **Reading**: `METADATA * SUB draft/webpush/mute` and
  `METADATA * GET draft/webpush/mute` go out **10 s after registration**
  (`MUTE_READ_DELAY_MS`), when the connect burst's fake lag is spent, and
  only with the `draft/metadata-2` cap and an account (push needs both). On a
  network with many channels they can still fall inside `catchup.ts`'s 4 s
  pacing: two commands of fake lag. The `GET` reply (761, or 766 for no key)
  and every later `METADATA` line update `muteValue` and `remoteDnd` (a live
  `*` entry). `handlers/metadata.ts` takes a value when its visibility is
  `private` or its target is our own nick; every other key stays silent.
  Each write comes back twice (the 761/766 and the subscribed `METADATA`
  line) and is recognised as our own echo (`mutePending`, dropped after
  30 s unechoed).

**Writing.** While a network's `dnd` holds, its `*` entry says the DND's end:
the end of a timed or scheduled DND, or now + 30 days for an indefinite one,
renewed when under 7 days remain (checked on the minute tick). Nothing is
written before the value has been read.

- **Ownership**: the entry is ours (`muteOwned`) while the live `*` entry's
  `until` equals the `until` this client last wrote (`muteOwnedUntil`). That
  survives a reconnect — the next `GET` reads our own entry back and it is
  still ours — but not a reload. Only an owned entry is rewritten or removed
  when local DND ends.
- **A live `*` entry another device wrote is adopted, never rewritten**:
  push is muted already, and rewriting it would have two devices that
  disagree on the end rewrite each other forever. When it expires our own
  entry goes in at the next sync (up to a minute later).
- **Cleared elsewhere**: when the live `*` entry disappears while this client
  still wants DND, another device turned it off. It is not written back
  (`muteSuppressed` until DND starts afresh) and the client dispatches
  `dnd:cleared`; the page (`client/js/dnd.ts`) then turns its own DND off
  (`reconcileRemote` → `turnOff`, so a scheduled window is skipped to its
  end).

**The pill reads shared DND**: when every connected network has `remoteDnd`
and the local state is off, the pill says "Do not disturb" (set on another
device) and its Off removes the entries (`clearRemoteDnd`, which also covers
an entry of ours that a reload stopped us recognising).

**Limitations (documented, not solved):**

- The schedule is per device, and the server's mute is "from now until X",
  so a scheduled window silences push only when some Seance is open at the
  window's start. A device cannot book a future window in advance.
- A change made from another session of the account **under a different
  nick** is not applied live: nefarious2 labels every `METADATA`
  notification `*`, private ones included, so it cannot be told from another
  user's public value. It is picked up at the next registration's `GET`.
  Push muting itself is server-side and immediate either way.

`webpush.setSnooze` and the Settings snooze buttons are removed; the pill menu
replaces them.

## 5. UI

- **Status pill** (`client/components/PresencePill.vue`, under the logo in
  `Sidebar.vue`): "Online · auto" (or the mix, "Online"), "Do not disturb ·
  until 07:00", "Do not disturb" (indefinite or set elsewhere). The click opens
  a menu: Off · For 1 hour · For 8 hours · Until I turn it off · Follow
  schedule (✓, with the window's text) · Edit schedule… (opens Settings →
  Notifications). The label wraps to two centred lines, breaking only after
  its separator ("Do not disturb ·" over "until 10:36 AM"), so the end time is
  never cut off; it is clamped only past two lines, and the whole label is
  also the button's title.
- **Presence dot** in `NetworkLobby.vue`, before the nick (`.lobby-presence`;
  alone when there is no nick): green present, amber away (`AWAY *` in
  effect or `/away`), red DND. A click opens Online / Auto /
  Away / Do not disturb for that network; the dot has its own `aria-label`
  and does not start a drag or select the row; a right-click on it opens the
  same menu, not the lobby's.
- **Network form** (`NetworkForm.vue`): the same four modes as a select; it
  shows the mode the dot set, and saving keeps it.
- **Settings → Notifications**: the schedule editor (enabled, start, end,
  weekdays) in place of the snooze buttons.
- Plain English copy as the surrounding components on this base (no i18n
  layer on `origin/develop`), sizes in `rem`, logical properties, the menus following the existing
  context-menu styling and keyboard handling.

## 6. Settings backup

`thelounge.dnd` joins `BACKUP_KEYS`; restoring a file made before it existed
resets DND to its default, as for every carried key. `presenceMode` rides in
`thelounge.networks` already.

## 7. Testing

- `test/helpers/dnd.ts`: windows crossing midnight, weekdays (the start day
  decides), manual over schedule, Off inside a window skipping to its end,
  expired `until`, an empty schedule.
- `test/irc/presence.ts`: each mode × attended/unattended × DND, `/away` on
  top, a mode change mid-session, nothing before 001.
- `test/irc/pushMute.ts`: parse/format, the `*` merge keeping other entries,
  expired entries dropped, `remoteDnd` from 761/766/`METADATA`, the private
  write and the bare clear, adoption, ownership across a reconnect,
  `dnd:cleared`.
- Browser check `tools/scenarios/dnd.mjs` against the dev ircd (also
  `--mobile --width=390 --height=844`): the pill and its menu, the dot and its
  menu (no navigation, no drag, its own right-click menu), the `AWAY *` /
  `AWAY` frames, `presenceMode` saved, a highlight from a helper connection
  raising a notification and the sound out of DND and neither in it, and the
  pill's whole label in the sidebar at the huge font step. The dev ircd has
  no services, so no account and no `METADATA` write: the wire is
  `test/irc/pushMute.ts`'s.
- `yarn test` and `yarn build` green; a CLAUDE.md entry pointing here.

## Out of scope

- Away messages of the user's own choosing for Away/DND (the user picked
  plain `AWAY *`).
- Several schedule windows.
- Overriding another present device of the same account (not possible
  through `draft/pre-away`).
- Any change to nefarious2 or its configuration.

## Changed during the build

- The mute list is written `private`, and the clear is a bare `SET` (the
  plan wrote it public, which any channel-mate could read).
- A live `*` entry another device wrote is adopted and never rewritten (the
  plan rewrote it to our own end, which looped between two devices).
- Ownership is "the live `*` entry's `until` equals the one we last wrote",
  kept across reconnects (a flag reset on reconnect left push muted after
  Off).
- Another device clearing the entry raises `dnd:cleared`, which turns this
  device's DND off instead of being written back.
- A change from a session under a different nick is not applied live (the
  server labels every notification `*`); it waits for the next `GET`.
- `SUB`/`GET` go out 10 s after registration, not in the connect burst.
- `webpush.setSnooze` and the snooze buttons are removed, not merged.
- `/back` sends one line chosen by the presence rule, never `AWAY *` then
  `AWAY`.
- The pill's label wraps to two lines rather than being cut off.
- Copy is plain English, not `t()`: the base has no i18n layer.
