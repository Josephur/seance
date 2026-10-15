# Shared presence modes

Status: design approved 2026-10-15, not built. Branch `dnd`. Builds on
[do-not-disturb.md](do-not-disturb.md), which introduced the presence modes
and the shared do not disturb this reuses.

## 1. What and why

Each network has a presence mode — Online, Auto, Away, Do not disturb — set
from the lobby row's dot or the network form. Until now the mode was kept on
the device (`presenceMode` on the saved network entry), so a phone and a
desktop on one account could disagree, and a change on one never reached the
other.

The user's request (2026-10-15): the devices share the mode, **including a
change made while a device is offline**, and when two devices changed it
while apart, **the most recent change wins**.

What follows from that:

- A network's mode is the same on every device of the account. A change on
  one device shows on the others at once if they are connected, and at their
  next login if not.
- A change made on a device with no connection is kept there and applied at
  its next login, unless another device changed the mode later.
- Auto still means "this device follows its own attention": with Auto
  shared, each device goes away when nobody is looking at it.
- Two devices can no longer hold different modes at the same time (the
  desktop Online, the phone Away). That is the point of sharing.

Out of scope: the `/away` message (per device, `thelounge.state.away`), the
do not disturb switch and schedule (`thelounge.dnd`; DND is already shared
through the push mute, its schedule stays per device), and networks without
an account or without `draft/metadata-2`, which keep the mode on the device
as before.

## 2. Where the shared mode lives

One account metadata key per network (that is, per server), written
`private`:

```
METADATA * SET seance/presence private :<mode> <changedAt>
```

- `<mode>` is `online`, `auto`, `away` or `dnd`.
- `<changedAt>` is the moment the user made the change, in Unix
  milliseconds, on the device that made it. Not the moment it reached the
  server: a change made offline at 15:00 and uploaded at 16:00 still counts
  as 15:00.
- `private` is required: nefarious2 stores a `SET` without a visibility as
  public (found with the mute key, do-not-disturb.md § Server notes).
- nefarious2 accepts the key (`a-z 0-9 _ . / -`, `m_metadata.c`
  `is_valid_key`) and persists account metadata server side (RocksDB), so
  the value outlives every connection of the account.
- A value that does not parse (an unknown mode, no time, extra words) is
  ignored as if absent, so a later client can extend the format without
  older ones fighting over it.

## 3. The rule: the most recent change wins

Each device knows, per network, its mode, the `changedAt` of that mode, and
whether that change is still to be uploaded (`pending`). It compares by
`changedAt`; on a tie, by the mode's name, so every device picks the same
winner without talking to the others.

- **Server newer than the device**: adopt it — the mode and its
  `changedAt` — save it, clear `pending`, and apply it at once
  (`syncPresence`: `AWAY *` / `AWAY`, the push mute).
- **Device newer than the server** (a `pending` change, or a value the
  server has lost to an older write): write the device's value.
- **Same value**: nothing; a pending flag is cleared (our write landed).
- **No value on the server**: the device writes its own only when it is not
  the default (Auto with no recorded change); otherwise there is nothing to
  share yet.

The server stores the last write it received, not the newest change. Two
devices can race: A reads an older value, B writes a newer one, A's write
lands after it. Every connected device is subscribed, so B hears A's older
value and, knowing a newer one, writes its own again. Only a device that
knows a strictly newer value ever writes in answer to a read, so this
settles on the newest change and stops.

Device clocks decide the order. Phones and computers set their clocks from
the network and agree to well under a second; a device whose clock is off
by minutes can lose a change made just after another device's. Accepted.

## 4. When it is read and written

- **Login**: the read that already happens 10 s after registration
  (`IrcClient.scheduleMuteRead`, `MUTE_READ_DELAY_MS` — after the connect
  burst, where nefarious2's fake lag is cheapest) subscribes to and gets the
  presence key alongside the mute key: `METADATA * SUB draft/webpush/mute seance/presence` and one `METADATA * GET` naming both keys (metadata-2 allows several keys per `GET`). The answer goes through § 3.
- **A change on this device** (the dot, the network form, `dnd:cleared`
  moving a `dnd` network back to Auto): applied at once as today, saved with
  `changedAt = Date.now()` and `pending`, and written when the connection
  can (registered, `draft/metadata-2`, logged in, and the login's read has
  answered — before that, § 3 decides at the read).
- **A change on another device**: the subscription's `METADATA` line, put
  through § 3 like a read.
- **Our own write's echo** (the 761 confirmation and the subscription's
  line): the same value; clears `pending`.
- A `FAIL METADATA` for our write leaves `pending` set: the next login (or
  the next change) tries again.

A device that missed a change while it was off still declares its old mode
during the next registration (`registrationAwayLine`, before `CAP END`),
because the shared value is read 10 s later. For those seconds it shows its
old state; then it adopts the newer mode. Accepted for now. A later step
could read the key before `CAP END` (the rig advertises
`draft/metadata-2=before-connect`), at the cost of waiting for the reply
before ending registration.

## 5. Where it is kept on the device

On the saved network entry, beside `presenceMode` (`saved-networks.ts`):

- `presenceAt?: number` — the `changedAt` of the current mode; absent
  for a mode never changed (Auto by default).
- `presencePending?: true` — this device's change is not yet confirmed by
  the server.

Both travel with the saved network in the settings backup like
`presenceMode` does. A restored `pending` change is harmless: § 3 compares
it by its own `changedAt`, so an old one loses to the server's newer value.
A network that is not saved keeps the three in memory for the page.

## 6. Components

- **`client/js/irc/presenceShare.ts`** (new, Vue-free, DOM-free, under
  mocha): `PRESENCE_KEY`, `parsePresenceValue` / `formatPresenceValue`,
  `newer(a, b)` (§ 3's order, tie on the name), `onPresenceValue(client, value)` (adopt / write back / clear pending) and `syncSharedPresence (client)` (write a pending change when the connection can).
- **`IrcClient`**: `presenceAt`, `presencePending`, `presenceKnown` (the
  login's read answered, reset on close like `muteKnown`), and
  `setPresenceMode(mode, {at, pending})` so a mode adopted from the server
  is not marked as a new local change.
- **`handlers/metadata.ts`**: the presence key joins `OWN_KEYS` (its
  replies stay silent) and is routed to `onPresenceValue`, under the same
  `private`-or-own-nick check as the mute.
- **`bus.ts`**: `setPresenceMode` saves `presenceAt` / `presencePending`
  with the mode; a new `network:presence-adopted` bus event (dispatched by
  `presenceShare.ts`, which cannot touch storage) saves an adopted mode on
  the saved entry, so the next reload declares it.
- **`client.ts` `scheduleMuteRead`**: subscribes to and gets both keys.

## 7. Testing

- **`test/irc/presenceShare.ts`**: the value's parse and format (bad values
  ignored); `newer` including the tie; adopt a newer server value (mode,
  time, not pending, `syncPresence` called, `network:presence-adopted`);
  write a pending local change that is newer; drop a pending change that is
  older; the empty server with a default and a non-default mode; our echo
  clearing `pending`; the race (an older value arriving after ours is
  written back once, and not again on its own echo); no write before the
  login's read; nothing without an account or `draft/metadata-2`; a
  `FAIL METADATA` leaving `pending`.
- **`test/irc/saved-networks.ts`**: `presenceAt` and `presencePending`
  round-trip and are dropped when malformed.
- **Live, two devices** (`tools/scenarios/presence-shared.mjs`, the testnet
  rig, two Chromium profiles as in `away-two-devices.mjs`):
  1. A change on A reaches a connected B within a few seconds: B's dot, and
     what other users see (`AWAY *` follows on B when the mode asks for it).
  2. B closed; A changes the mode; B reopens and shows A's mode after its
     login's read.
  3. B offline (its connection cut, page open); the mode changed on B; B
     reconnects and uploads it; A shows it.
  4. Both change while apart, B later than A; after both reconnect, both
     show B's mode.
- **`tools/scenarios/presence-modes-two-devices.mjs`** gave each device its
  own mode (A Away, B Online). With sharing that state cannot be set up, so
  that scenario is reworked to share one mode (Away, then Online) and keep
  its measurements; its step-7 regression (an away device resuming a session
  another device left present) stays covered by `test/irc/preaway.ts`.
- `yarn test`, and the existing `away-live.mjs` and `away-two-devices.mjs`
  runs, unchanged.
