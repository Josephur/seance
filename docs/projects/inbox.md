# Inbox: unread mentions on every device

_Noted 2026-10-23. Issue: [evilnet/seance#125](https://github.com/evilnet/seance/issues/125).
Status: step 1 (client-only) built; step 2 (server) to be proposed on the issue._

## Goal

One list of the messages that mentioned you and that you have not read, the
same on every device, cleared by reading them anywhere. The server stores
little and cleans up after itself.

## Shape

An **inbox entry** is a reference to one message:

| field     | what                                              |
| --------- | ------------------------------------------------- |
| `network` | the saved network's uuid                          |
| `target`  | the channel or query name, as the client shows it |
| `msgid`   | the IRCv3 `msgid`, when the server sends one      |
| `time`    | the message's `@time` (server time)               |
| `from`    | the sender                                        |
| `type`    | the message type (message, action, notice)        |
| `text`    | the text, kept only to display it                 |

Its **key** is `network/msgid`, or `network/target/time/nick` on a server
without `message-tags`. Never a session-local id from `irc/ids.ts`: those change on
every page load.

**Read rule:** an entry is read, and removed, once its target's read point
passes its `time`. The read point is the one `handlers/markread.ts`
`moveReadMarker` keeps: our own reading (opening the conversation, or the
window coming back to it), a `MARKREAD` from another session of the account,
and our own message in a history page. Dismissing an entry by hand removes it
on this device only.

## Step 1: client-only (no server change)

Every device builds the same list from what the server already gives it:

- **Live** highlights, and **catch-up** highlights: the `CHATHISTORY AFTER` /
  bouncer replay appended after a reconnect (`history.ts` `deliverAppend`) and
  the first history page of a cold load past the read marker
  (`countPageUnread`), all as the `inbox:add` bus event. Only what counted as
  unread, only in a channel or a query (the lobby has no read point), never
  a muted conversation's. Older scrollback is never added.
- **Pruned** by the `inbox:read {network, target, time}` bus event that
  `moveReadMarker` dispatches whenever the read point moves, and when the
  message is deleted or replaced by an edit.
- **Dismissed** on this device: the entry goes, and its key is remembered
  (`thelounge.mentions.dismissed`, 200 at most) so the next catch-up does not
  bring it back, until the conversation is read past it.

Stored in `thelounge.mentions`: 100 entries, 20 per conversation (every line
of a query is a highlight, so a busy one would otherwise push the rest out),
oldest out first; not carried by the settings backup. Lists stored by an
earlier build, keyed by session-local ids, are dropped on load. Logic in
`client/js/helpers/inbox.ts` (Vue-free, `test/helpers/inbox.ts`);
`client/js/mentions.ts` is the store glue.

Limits of step 1:

1. A dismissal does not reach the other devices (a read marker clears up to
   a point, not one message).
2. Only what this device fetched: the bouncer replay stops at 100 lines per
   target, and a channel you have left is never fetched.
3. Custom highlight words are this browser's; another client may disagree.

## Step 2: a server-kept inbox

Not built. Step 1's entry shape (network, target, msgid, time) is what a
server list would carry, so a network whose server one day offers one can
read its entries from there and keep step 1 as the fallback. The proposal
belongs on the issue, not here.
