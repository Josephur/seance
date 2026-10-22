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

Closing a query leaves a **tombstone**: the casefolded nick and the server time
of the newest line the window held (`chan.newestRef.time`). Using the server's
time, not the device clock, means a skewed clock cannot swallow a later
message.

- A line at or before the tombstone never opens the window. That covers the
  catch-up (only the later lines are shown), an unwrapped replay, and a logged
  query at page load.
- A later line opens it as before. Closing hides a conversation; it does not
  block a person.
- The user's `/query` forgets the tombstone on this device.
- Removing the network forgets all its tombstones.

All of it is `client/js/irc/closedQueries.ts` (`ClosedQueries`,
`IrcClient.openAutoQuery`), Vue-free.

## Where tombstones live

- **This device:** `thelounge.state.closedQueries`, one list per network uuid,
  never in the settings backup. Another tab hears a change through the
  `storage` event (`manager.ts` → `closedStorageChanged`).
- **The account's other devices:** the private metadata key `seance/closed`.
  Its value is `nick:<close time in base-36 ms>` items, newest first. It is
  subscribed with the other shared keys (before `CAP END` where the server
  offers `before-connect`) and read in the login read 10 s after
  registration. A close is written only once this connection's GET has
  answered (761 or 766); a notification, the before-connect burst among them,
  can come from a stale copy and a write after it could drop another device's
  newer close. Every write is the device's tombstones merged with what it has
  heard, cut to the server's `max-value-bytes` (nefarious2: 300, about fifteen
  closes) and to 30 days, oldest out first.
- It is written **private**: a public key would be in everyone's WHOIS of us,
  a list of the people we talk to.

## A tombstone that arrives late

The metadata read comes after the catch-up and the restored windows, so a
query can already be open when the close arrives. Then it goes if this client
opened it by itself (`Channel.autoOpened`: a line or a restored log) and its
newest line is at or before the tombstone. A query the user opened, read or
wrote in stays: a close elsewhere never takes away what the user is looking at.

## Limits

- On a server without `draft/metadata-2`, or without an account, the fix covers
  this device only: its tabs and its reconnects.
- Two devices closing at nearly the same moment can each write without the
  other's close; the next write from either carries both, as each adopts what
  it hears.
- A device that missed a close for more than 30 days, or past the 300-byte cut,
  can reopen an old conversation from its own log.

Tests: `test/irc/closedQueries.ts`. Browser check (this device's tabs; the dev
ircd has no accounts): `tools/scenarios/query-close-sync.mjs`.
