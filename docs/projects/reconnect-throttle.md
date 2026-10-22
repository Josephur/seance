# Reconnecting into the server's throttle

Reported 2026-10-22: Seance on a phone gets throttled when it is reopened
often, as happens when the user switches between apps. This page records the
cause, what the client now does, and what only the server can fix. The server
part is a proposal for nefarious2; filing it upstream is the maintainer's call.

## What happens

nefarious2's IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`) runs when a
connection is accepted, before TLS, the WebSocket upgrade and SASL. It counts
connections per address. The count restarts after a gap of more than
`IPCHECK_CLONE_PERIOD` (40 s) since the last connection, and the connection
that brings it to `IPCHECK_CLONE_LIMIT` (4) is refused. `last_connect` is set
before the check, so a refused connection still counts as the last one: a
client that keeps dialling inside the window keeps it closed. Over a WebSocket
the refusal is a close with code 1006, the same as an unreachable server.

A phone's OS drops the socket each time the app leaves the screen, so each
return is a new connection. Three returns within 40 s of each other use up
the window; the fourth is refused. Nothing refunds a connection that then logs
in, or that resumes a held bouncer session: `bounce_revive` and
`bounce_setup_local_alias` only call `IPcheck_connect_succeeded`.

The client made it worse. After a refusal its reconnect schedule retried at
once, then after 1, 2, 4, 8, 16 and 32 s, and each retry renewed the window: a
lockout of a minute and a half where 42 s of quiet would have done.

## What the client does now

`client/js/irc/dialLedger.ts` keeps this device's dials per server host in
`thelounge.state.dials`, so a reloaded or reopened app and its other tabs
share the record. Before any dial (a scheduled retry, the foreground poke, the
user's Connect) the transport asks it whether the server would refuse, and if
so waits out the gap. The strip says "Reconnecting to <network> in Ns: the
server limits quick reconnects.", and Connect now waits too, because dialling
would renew the window. The worst case is one wait of at most 42 s, never a
spiral. A deploy can tune the rule or turn it off with
`features.connectThrottle` (docs/resources/branding.md).

The cost: a dial that fails looks the same whether IPcheck refused it or the
server is simply down (connection refused, DNS failure, both close with 1006),
and only a radio that is off is told apart (`navigator.onLine`). So after three
quick failures against a server that is down, the next try waits up to 42 s
instead of the schedule's next step. The wait is never longer than one window,
whatever the record says: a clock that ran ahead and was put back cannot hold
a network. The service worker's own short connections (away on close, mark
read, a reply) count on the server but are not in the record.

That is as far as a client can go. It cannot keep a socket alive while the OS
has suspended the page, and it cannot see dials from other devices behind the
same address. Carrier NAT puts many phones behind one address, so the
per-address count reaches its limit faster for exactly the users this hurts.

## What the server could do

Ordered by recommendation.

1. **Refund the attempt once the connection logs in.** Call
   `IPcheck_connect_fail(cptr, 0)` when SASL succeeds, before registration
   completes. It is the hook nefarious2 already uses for a connection that is
   "not penalized for the failure" (`m_webirc.c:153`, `s_auth.c:906`); with
   `disconnect = 0` it lowers `attempts` and leaves the clone count alone.
   The success points are `sasl_complete_login()` in `ircd/sasl_auth.c` (local
   Keycloak and the P10 relay) and `iauth_cmd_sasl_done()` in `ircd/s_auth.c`
   (IAuth). Guard it with `IsIPChecked(cptr)` and do it once per connection.

   Unauthenticated floods stay throttled exactly as now. An attacker gains
   nothing without a valid account, and an account holder still meets the
   clone limit and the connection class limits. If a per-account cap is
   wanted, a small counter keyed by account would bound how often one account
   can reconnect.

   A narrower form refunds only a connection that resumes or attaches to a
   held bouncer session (`bounce_revive`, `bounce_setup_local_alias`). It
   covers Seance with SASL and persistence, which is the phone case, and
   changes nothing for other clients.

2. **Stop a refused connection from renewing the window.** Set
   `entry->last_connect` after the refusal check instead of before. A client
   in a retry loop then gets back in 40 s after its last accepted connection.
   This is weaker, and it changes ircu's deliberate penalty for clients that
   hammer the server.

3. **A separate limit for WebSocket ports.** Not recommended: it relaxes the
   throttle for everything on those ports, logged in or not.

The alternative that needs no server change is a native shell (E.4), which
can hold its socket in the background for longer than a page can.

## Reproducing it

The dev ircd relaxes the throttle (`tools/nefarious-dev/local.conf`: 100 /
1 s / 1 s) because the test suites reconnect a lot. To see the real behaviour,
run a private copy of the conf with the `IPCHECK_CLONE_*` features removed,
and wait out `IPCHECK_CLONE_DELAY`: the throttle is off for 600 s after the
ircd boots. Then dial four times within 40 s gaps
(`node tools/irc-ws-probe.mjs ws://127.0.0.1:8067/ x`); the fourth gets no 101. The client's side is covered by `test/irc/dialLedger.ts`,
`test/irc/transport.ts` "the dial gate" and
`tools/scenarios/reconnect-throttle.mjs`.
