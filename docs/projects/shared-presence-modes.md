# Shared presence modes and global away

Status: built 2026-10-15 on branch `dnd` (the commits after 1b4fb464); § 5
and § 9 record what the two-device runs changed. Builds on [do-not-disturb.md](do-not-disturb.md), which
introduced the presence modes, the pill and the shared do not disturb this
reuses.

## 1. What and why

Each network has a presence mode — Online, Auto, Away, Do not disturb — set
from the lobby row's dot or the network form. Until now the mode was kept on
the device (`presenceMode` on the saved network entry), so a phone and a
desktop on one account could disagree, and a change on one never reached the
other. And there was no way to go away everywhere at once: the pill under the
logo only switched do not disturb.

The user's requests (2026-10-15):

- the devices share the mode, **including a change made while a device is
  offline**, and when two devices changed it while apart, **the most recent
  change wins**;
- a **global away**: one switch that puts every network away, on top of the
  per-network modes (option A of the two the user was shown: each network
  keeps its own mode underneath, and switching back restores them all),
  shared between devices the same way.

What follows from that:

- A network's mode is the same on every device of the account; so is the
  global away switch. A change on one device shows on the others at once if
  they are connected, and at their next login if not.
- A change made on a device with no connection is kept there and applied at
  its next login, unless another device changed it later.
- Auto still means "this device follows its own attention": with Auto
  shared, each device goes away when nobody is looking at it.
- Two devices can no longer hold different modes at the same time (the
  desktop Online, the phone Away). That is the point of sharing.

Out of scope: the `/away` message (per device, `thelounge.state.away`), the
do not disturb schedule (per device; DND itself is already shared through
the push mute), and networks without an account or without
`draft/metadata-2`, which keep the mode on the device as before and apply
global away locally without sharing it.

## 2. Global away

- **What it does**: while on, every network wants `AWAY *`
  (`presence.ts` `wantsStar` gains `globalAway`), whatever its own mode. The
  network's mode is untouched, so its dot reads "Online · away", "Auto ·
  away" (`NetworkLobby.vue` already words a mode that is away for another
  reason that way), and switching global away off puts every network back
  on its own mode. Do not disturb outranks it: DND is also away, and only
  DND mutes push. Global away does not mute push.
- **The pill** (`PresencePill.vue`) becomes one status choice, then the
  schedule:
  - **Available** — global away off and do not disturb off (the old Off:
    it also clears the account's mute, as `dnd.turnOff` does). Checked when
    neither is in force.
  - **Away** — global away on, and do not disturb off. Checked while global
    away is on and DND is not.
  - **Do not disturb for 1 hour / for 8 hours / until I turn it off** — as
    before; picking one also switches global away off (one status at a
    time).
  - a divider, **Follow schedule (…)** (a toggle, unchanged) and **Edit
    schedule…**. A scheduled window leaves global away as it is: away
    resumes when the window ends.
- **The pill's words and dot**: do not disturb (as before), else "Away"
  with the amber dot while global away is on, else the networks' summary as
  before.
- **Kept on the device** in `thelounge.dnd`, beside the DND switch and
  schedule, as `away: {on, at}` (`at` the Unix ms of the user's last choice,
  null if never chosen). It follows the DND state across this device's tabs
  (the `storage` event) and in the settings backup.

## 3. Where the shared state lives

Two private account metadata keys per network (that is, per server):

```
METADATA * SET seance/presence private :<mode> <changedAt>
METADATA * SET seance/away private :<on|off> <changedAt>
```

- `<mode>` is `online`, `auto`, `away` or `dnd`; `<on|off>` is the global
  away switch.
- `<changedAt>` is the moment the user made the choice, in Unix
  milliseconds, on the device that made it. Not the moment it reached the
  server: a change made offline at 15:00 and uploaded at 16:00 still counts
  as 15:00.
- `private` is required: nefarious2 stores a `SET` without a visibility as
  public (found with the mute key, do-not-disturb.md § Server notes).
- nefarious2 accepts the keys (`a-z 0-9 _ . / -`, `m_metadata.c`
  `is_valid_key`) and persists account metadata server side (RocksDB), so
  the values outlive every connection of the account.
- A value that does not parse (an unknown word, no time, extra words) is
  ignored as if absent, so a later client can extend the format without
  older ones fighting over it.
- Global away is one switch for the whole device, but each network's
  server holds its own copy: a device writes it to every network it can,
  and adopting it from any one network makes the device write it to the
  others whose copy is older (§ 4). Networks on different accounts or
  servers therefore carry it between devices that share at least one of
  them.

## 4. The rule: the most recent choice wins

The same rule for both keys. For each network and key, a device knows its
own choice (value and `changedAt`, or none — a mode never chosen, global
away never touched) and the last value it read from that network's server
on this connection. It compares by `changedAt`; on a tie, by the value's
word (plain string order), so every device picks the same winner without
talking to the others.

- **Server newer than the device's choice**: adopt it — the value and its
  `changedAt` — save it, and apply it at once (`syncPresence`: `AWAY *` /
  `AWAY`, the push mute). For global away, adopting it on one network makes
  the page switch it for every network (§ 6), and each of those writes it to
  its own server if that copy is older.
- **Device newer than the server's value** (a change made here, online or
  offline, or a newer value a late older write replaced): write the device's
  choice, and remember it as the server's value so it is not written twice.
- **Same value, or neither has one**: nothing.

So a change made while offline needs no flag of its own: at the next login
the device's choice is newer than the server's and goes up; one made on
another device since is newer still and is adopted instead.

The server stores the last write it received, not the newest choice. Two
devices can race: A reads an older value, B writes a newer one, A's write
lands after it. Every connected device is subscribed, so B hears A's older
value and, knowing a newer one, writes its own again. Only a device that
knows a strictly newer choice ever writes in answer to a read, so this
settles on the newest and stops.

Device clocks decide the order. Phones and computers set their clocks from
the network and agree to well under a second; a device whose clock is off
by minutes can lose a change made just after another device's. Accepted.

## 5. When it is read and written

- **Subscribed from the start**: with `draft/metadata-2=before-connect` and
  a SASL login, `METADATA * SUB draft/webpush/mute seance/presence seance/away` rides the `CAP END` flush (before registration, so no fake
  lag; `IrcClient.metadataSubscribed`). Without `before-connect` it goes out
  with the login read below. Subscribing only 10 s in lost changes: a device
  that registered missed another device's change made in that window, and
  the server then answered its GET from the connection's own stale copy
  (§ 9), so the two devices stayed apart (found live, presence-shared
  case 5).
- **At registration**: nefarious2 sends the account's own metadata in a
  burst at registration (`metadata_burst_self_to_client`); its
  `seance/presence` and `seance/away` lines go through § 4 at once.
- **Login read**: 10 s after registration (`IrcClient.scheduleMuteRead`,
  `MUTE_READ_DELAY_MS` — after the connect burst, where nefarious2's fake
  lag is cheapest) one `METADATA * GET` names all three keys (metadata-2
  allows several keys per `SUB` and `GET`); it answers a key the burst did
  not carry (unset) and goes through § 4.
- **A choice on this device** (the dot, the network form; the pill's
  Available / Away / DND items for global away): applied at once as today, stamped with
  `Date.now()`, saved, and written to every network that can (registered,
  `draft/metadata-2`, logged in) once that network's login read has
  answered — before that, § 4 decides at the read.
- **Another device's DND Off** (`dnd:cleared`, irc/pushMute.ts) turns this
  device's global DND off and **leaves the network modes alone**. It used to
  set a network in mode `dnd` back to Auto; with the mode shared that
  stamped a choice newer than the real one (a device leaving mode `dnd`
  clears the mute, the other read that as a DND Off and stamped Auto, and
  every device adopted Auto — found live, presence-shared case 5). A device
  that leaves mode `dnd` sends its new mode itself.
- **A choice on another device**: the subscription's `METADATA` line, put
  through § 4 like a read.
- **Our own write's echo** (the 761 confirmation and the subscription's
  line): equal to what we remembered writing; nothing.
- A `FAIL METADATA` for our write: nothing now; the next login reads the
  server's value again and writes ours if it is still newer.
- A connection that closes forgets the server's values and that it read
  them: the next login reads again.

A device that missed a change while it was off still declares its old state
during the next registration (`registrationAwayLine`, before `CAP END`); the
registration burst brings the newer one a moment later, and it is adopted
then. Accepted.

## 6. Where it is kept on the device

- The mode's time: `presenceAt?: number` on the saved network entry
  (`saved-networks.ts`), beside `presenceMode`; absent for a mode never
  chosen. Carried by the settings backup with the entry; a restored old
  choice simply loses to a newer server value by § 4. A network that is not
  saved keeps it in memory for the page.
- Global away: `away: {on, at}` in `thelounge.dnd` (§ 2), held by
  `client/js/dnd.ts`, which hands it to every IRC client
  (`manager.setGlobalAwayAll`, beside `setGlobalDndAll`) and listens for one
  adopted from a server (`away:shared`).

## 7. Components

- **`client/js/irc/presenceShare.ts`** (new, Vue-free, DOM-free, under
  mocha): `PRESENCE_KEY`, `AWAY_KEY`, `parseStamped` / `formatStamped`
  (`<word> <ms>` against a word list), `newer(a, b)` (§ 4's order),
  `onPresenceValue` / `onAwayValue` (a value read: adopt, or write ours
  back), `syncShared(client)` (write whatever this device knows newer than
  its server).
- **`client/js/helpers/dnd.ts`**: `DndState.away`, its parse/serialize, and
  `pillStatus(state, now)` → `available` / `away` / `dnd` (the pill's
  checked item and words).
- **`IrcClient`**: `presenceAt`, `globalAway {on, at}`, and per key the
  server's last value and whether it was read on this connection (reset on
  close); `setPresenceMode(mode, at?)` (an `at` stamps the choice) and
  `setGlobalAway(away)`.
- **`presence.ts`**: `wantsStar` includes `client.globalAway.on`.
- **`handlers/metadata.ts`**: both keys join `OWN_KEYS` (their replies stay
  silent) and are routed to `onPresenceValue` / `onAwayValue`, under the
  same `private`-or-own-nick check as the mute.
- **`bus.ts` / `manager.ts`**: a mode chosen here is stamped and saved with
  its time; `network:presence-shared` (a mode adopted from the server)
  saves it on the entry; `manager.setGlobalAwayAll`; new clients start with
  the saved `presenceAt` and the page's global away.
- **`client/js/dnd.ts`**: `setAway(on)` (stamped, saved, and DND off when
  on), `available()` (away off and `turnOff`), DND choices switch away off;
  `away:shared` adopted when newer; `pillLabel` / `pillState` read
  `pillStatus`.
- **`PresencePill.vue`**: the menu of § 2.
- **`client.ts` `scheduleMuteRead`**: subscribes to and gets the three keys.

## 8. Testing

- **`test/irc/presenceShare.ts`**: the values' parse and format (bad values
  ignored); `newer` including the tie; for each key: adopt a newer server
  value (the mode applied with its time and `network:presence-shared`; the
  switch applied with `away:shared`), write a device choice newer than the
  server's, adopt instead of writing when the server's is newer, an empty
  server with and without a device choice, our echo writing nothing, the
  race (an older value arriving after ours written back once, and not again
  on its own echo), no write before the login's read, a reconnect reading
  again before writing, nothing without an account or `draft/metadata-2`, a
  `FAIL METADATA` writing nothing, the login read's lines, and the
  subscription: before `CAP END` with `before-connect` after a SASL login
  (then the read only GETs), with the read without it, again after a
  reconnect.
- **`test/irc/presence.ts`**: global away sends `AWAY *` on every mode, and
  `AWAY` when it goes off (unless the mode or attention wants the star), and
  is declared before `CAP END`.
- **`test/helpers/dnd.ts`**: `away` parses, defaults and survives a bad
  value; `pillStatus` for each combination (DND outranks away).
- **`test/irc/saved-networks.ts`**: `presenceAt` round-trips and is dropped
  when malformed.
- **`test/irc/multi-network.ts`**: a dot or form choice is stamped and
  saved; the same mode re-posted by the form stamps nothing;
  `network:presence-shared` saves; another device's mute clear leaves a
  shared mode `dnd` as it is. (`manager.ts` imports the store and cannot
  load under mocha: `setGlobalAwayAll` and a new client's starting state
  are covered by the browser runs.)
- **Live, two devices** (`tools/scenarios/presence-shared.mjs`, the testnet
  rig, two Chromium profiles as in `away-two-devices.mjs`):
  1. A mode change on A reaches a connected B within a few seconds.
  2. B closed; A changes the mode; B reopens and shows it after its login
     read.
  3. B disconnected; the mode changed on B; B reconnects and uploads it; A
     shows it.
  4. Both change while apart, B later than A; after both reconnect, both
     show B's mode.
  5. Away on A's pill: B's pill reads Away, both devices' dots read
     "<mode> · away", others see the account away; Available on B brings
     both back to their modes.
- **Browser, one device** (`tools/scenarios/dnd.mjs`): its pill-menu steps
  follow the new items (Available replaces Off), plus Away → every network's
  dot "· away" → Available.
- **`tools/scenarios/presence-modes-two-devices.mjs`** gave each device its
  own mode (A Away, B Online). With sharing that state cannot be set up, so
  that scenario is reworked to share one mode (Away) and keep its
  measurements; its step-7 regression stays covered by `test/irc/preaway.ts`.
- `yarn test`, and the existing `away-live.mjs` and `away-two-devices.mjs`
  runs (their Off steps now click Available).

## 9. Server notes (measured on the testnet, not changed here)

- nefarious2 keeps a copy of the account's own metadata per connection. A
  `SET` updates the writer's copy and the account store and notifies the
  subscribers, but a connection that was not subscribed keeps its old copy,
  and a later `GET` from it, and the registration burst of a connection
  resuming a held session as primary, answer from that copy. Measured with
  `/tmp`-only probes (two raw connections on one account): the primary was
  handed `seance/away on …892110` while an alias of the same session got the
  newer `off …900141`. § 4's rule tolerates a stale read (the stale value is
  older, and the device holding the newer choice writes it back when it sees
  the older one); subscribing before registration (§ 5) closes the window
  in which a connection missed a change. A candidate upstream issue.
- A `SUB` before `CAP END` is accepted (770, answered under the
  pre-registration nick) and survives registration.
- **Known gap**: a device that resumes a held session as primary can be
  handed a stale value that is newer than its own choice (in the burst, and
  again by the GET). It adopts it and writes nothing, so no other device
  sees a disagreement to repair: it holds the stale value until another
  device writes again. No read the client can make gets past the stale
  copy; the fix belongs in the server (keep the per-connection copy in step
  with the account store).
- A value this build cannot read (a later client's format) is never
  answered with a write; only a choice made on this device after it was
  read goes over it (§ 3: no fighting over a format we do not know).
