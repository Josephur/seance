# Inbox: unread mentions on every device

_Noted 2026-10-23. Issue: [evilnet/seance#125](https://github.com/evilnet/seance/issues/125).
Status: step 1 (client-only) in progress; step 2 (server) is a proposal._

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

- **Live** highlights (`socket-events/msg.ts`), as before.
- **Catch-up** highlights: the `CHATHISTORY AFTER` / bouncer replay appended
  after a reconnect (`history.ts` `deliverAppend`), and the first history page
  of a cold load past the read marker (`countPageUnread`). Older scrollback is
  never added: only what the read marker says is unread.
- **Pruned** by the `inbox:read {network, target, time}` bus event that
  `moveReadMarker` dispatches whenever the read point moves.

Stored in `thelounge.mentions` (100 entries, oldest out), not carried by the
settings backup. Logic in `client/js/helpers/inbox.ts` (Vue-free,
`test/helpers/inbox.ts`); `client/js/mentions.ts` is the store glue.

Limits of step 1:

1. A dismissal does not sync (a read marker clears up to a point, not one
   message).
2. Only what this device fetched: the bouncer replay stops at 100 lines per
   target, and a channel you have left is never fetched.
3. Custom highlight words are this browser's; another client may disagree.
4. A query whose peer changed nick keeps its entries under the old name until
   they are read or dismissed.

## Step 2: server inbox (proposal, not built)

A vendor capability, `evilnet.github.io/inbox`, on nefarious2.

**Stored per account:** `(target, msgid, time, sender, kind)`, about 100
bytes. The text stays in chathistory; the server renders it on request.

**What enters:** a channel line whose text mentions the account's nick (the
test `webpush_hl_account` already runs, without its push-only gates), from an
account-less or other account, not `SILENCE`d. Replies to one's own messages
and private messages are open questions.

**Limits:**

- Accounts only.
- At most N per account (say 200), oldest out; at most M per sender, so one
  sender's flood evicts its own entries first.
- An entry expires with its message's chathistory retention.
- An entry the account's read marker passes is deleted, not kept as read.

**Wire:**

- `INBOX LIST` → one `BATCH +ref evilnet.github.io/inbox` of the messages
  themselves, as in a `CHATHISTORY` reply: one command per connect.
- `INBOX DISMISS <msgid>` → removes one entry; echoed to every session of the
  account as `INBOX DISMISS <msgid>`.
- A new entry is announced to the account's sessions as `INBOX ADD <target> <msgid> <time>` so open clients stay in step.

**In Seance:** a network whose server offers the cap reads its entries from
`INBOX LIST` and the live lines instead of the local source; the local source
stays the fallback for every other server. On the first connect with the cap,
the network's local entries are dropped and the server's list taken (same
`msgid`, same message).
