# Closed queries stay closed

Asked 2026-10-22: closing a private conversation hid it on that device only.
After a reconnect, or in another tab or device, it opened again. Can that be
stopped without changing the server? Yes, on nefarious2: its
`draft/metadata-2` keeps private per-account keys, which Seance already uses
for shared presence (`seance/presence`, `seance/mode`).

## What reopened it

Every automatic way a query opens ends in `IrcClient.announceChannel(nick, QUERY)`:

- the server's catch-up after a reconnect (`history.ts` `deliverCatchup`),
  which opens a window for any private message in it;
- a private message, live or replayed without a batch (`handlers/privmsg.ts`);
- the query log the device keeps (`irc/querylog.ts`), restored as windows when
  the page loads. Another tab, or another device, still had the log.

Closing called `removeChannel`, which forgot this device's log and told
nobody else.

## The rule

Closing a query leaves a **tombstone** with two times:

- its **boundary**, the time of the newest line the server sent in that window
  (`Channel.newestServerAt`: lines with a msgid). A line this device made, such
  as an error pushed into the query, carries the device clock and never counts,
  so a clock that runs ahead cannot swallow a later message. A boundary may sit up to 15 minutes after this device's clock (it is the server's time, and a device clock can run behind it); values read from the account keep to a minute. A query with no line from the server leaves no
  tombstone: there is nothing to replay.
- its **event time**, when the close was made.

The rule, then:

- A line at or before the boundary never opens the window. That covers the
  catch-up (only the later lines are shown), an unwrapped replay, and a logged
  query at page load.
- A later line opens it as before. Closing hides a conversation; it does not
  block a person.
- The user's `/query` is a **reopen**: an event of its own that outranks an
  older close, here and on the account's other devices, so a conversation
  brought back stays back after a reload or the next read. A close made after
  the reopen outranks it in turn: each nick keeps only its newest event. A
  reopen is recorded (and written) only when there is a close to outrank, or
  before this connection's read of the account's list, when one may still
  arrive; a `/query` with nothing to reopen writes nothing.
- Nothing dated more than a minute after this device's clock is taken, from
  this device or the account, and nothing expired. That stops a close made on
  a clock that runs ahead, and a future-dated value written to silence a nick
  for good. An IRC operator can set another user's metadata, so one dated now
  can still hide that nick's earlier lines; a later line opens the query as
  ever.
- Removing the network forgets all its tombstones.

All of it is `client/js/irc/closedQueries.ts` (`ClosedQueries`,
`IrcClient.openAutoQuery`), Vue-free.

## Where tombstones live

- **This device:** `thelounge.state.closedQueries`, one list per network uuid,
  never in the settings backup. Another tab hears a change through the
  `storage` event (`manager.ts` → `closedStorageChanged`).
- **The account's other devices:** the private metadata key `seance/closed`.
  Its value is newest first: `nick:<boundary>[+<ms from the boundary to the close>]` for a close (a close made at its boundary carries no offset) and
  `nick:!<time>` for a reopen, all in base-36 ms. A 761 is taken only for our
  own nick, never another user's value an oper asked for. It
  is subscribed with the other shared keys (before `CAP END` where the server
  offers `before-connect`) and read in the login read 10 s after
  registration. A close is written only once this connection's GET has
  answered (761 or 766); a notification, the before-connect burst among them,
  can come from a stale copy and a write after it could drop another device's
  newer event. Every write is the device's events merged with what it has
  heard, cut to the server's `max-value-bytes` (nefarious2: 300, about a dozen
  closes) and to 30 days, oldest out first. A `max-value-bytes` that is not a
  plain number reads as 300.
- It is written **private**, so it is not in other users' WHOIS. **The network's
  IRC operators can still read it** (nefarious2 shows private metadata to
  opers, in WHOIS, GET and LIST): it is a list of the people the user closed
  conversations with in the last 30 days.
- **With private conversations not kept** (Settings → General,
  `keepPrivateConversations` off) tombstones live in memory for the page only
  and are never shared. Turning it off deletes this device's copy and, from
  every connected network, the account's shared list
  (`setClosedQueriesKept` → `manager.ts`'s hook → `IrcClient.unshareClosed`).
  A network that was down then, or a device where the setting was already off
  (a restored backup), deletes it at its next login read, once per network
  (`thelounge.state.closedUnshared`, cleared when the setting is turned back
  on). Another device that still keeps them writes its list again.

## A tombstone that arrives late

The metadata read comes after the catch-up and the restored windows, so a
query can already be open when the close arrives. Then it goes if this client
opened it by itself (`Channel.autoOpened`: a line or a restored log) and its
newest line from the server is at or before the boundary. A query the user
opened, read or wrote in during this page stays: a close elsewhere never takes
away what the user is looking at. A reopen closes nothing.

## Limits

- On a server without `draft/metadata-2`, or without an account, the fix covers
  this device only: its tabs and its reconnects.
- Two devices closing at nearly the same moment can each write without the
  other's close; the next write from either carries both, as each adopts what
  it hears.
- Events are ordered by the clocks of the devices that made them. A device
  whose clock runs behind can lose a close or reopen to an older one from
  another device.
- A device that missed a close for more than 30 days, or past the 300-byte cut,
  can reopen an old conversation from its own log.

Tests: `test/irc/closedQueries.ts`. Browser check (this device's tabs; the dev
ircd has no accounts): `tools/scenarios/query-close-sync.mjs`.
