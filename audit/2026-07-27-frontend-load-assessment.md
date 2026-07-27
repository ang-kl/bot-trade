# Frontend page-load assessment — is page data-richness causing the connection storm?

Owner question (2026-07-27, live incident in progress — `/health` and `/state/accounts`
both timed out under direct probing at the time this was raised): is the amount of
information a webpage requests — a Cockpit-style page, or any other data-heavy page —
too much, and is that what's causing the backend to disconnect / become unreachable?

This is an operational addendum to the L1-L3/L4-L5 audit passes, not itself an L1-L7
layer — filed here because it bears directly on the same connection-storm failure mode
already diagnosed for the boot-time `SCAN_CONCURRENCY`/`MONITOR_CONCURRENCY` incident.

## Verdict: partially correct, but not for the reason stated

**Payload size is not the mechanism.** Every polled `/state/*` route returns a small,
explicitly bounded result — `LIMIT 100` on trades (`agent/routes/state.js:636`), capped
at 1000 on the action log and broker-deals routes, `limit`/`days` query params on
everything else. These routes are pure local SQLite reads (`db.prepare(...).all()`) —
confirmed by grepping `agent/routes/state.js` for any reference to `ctrader-ws.js`: none
found. A page polling `/state/positions` or `/state/trades` every few seconds cannot,
by itself, touch the broker connection at all.

**The real mechanism is broker round-trips per poll tick, not bytes returned.** Two
routes that pages call are different in kind from the `/state/*` reads: `POST
/actions/broker-positions` and `POST /actions/broker-history`. Both import
`agent/lib/ctrader-ws.js` and make several calls through `wsRun` — the exact same
function already implicated in the SCAN_CONCURRENCY/MONITOR_CONCURRENCY incident,
which opens a brand-new `new WebSocket(...)` connection with a full auth handshake
per call, with no pooling (`ctrader-ws.js:112-114`).

- `/actions/broker-positions` (`agent/routes/actions.js:2566-2933`) costs "~6 fresh WS
  connections with full auth handshakes (~20s)" per its own in-code comment
  (`actions.js:2559-2563`), and is called on every poll tick by Trade (`Trade.jsx:360`),
  Desk (`Desk.jsx:241`), and Accounts (`Accounts.jsx:116,139`).
- **This route was already fixed for exactly this reason**, before this session's
  question was raised: a server-side, cross-tab-shared 12-second TTL + in-flight
  coalescing cache (`bpShared`/`BP_TTL_MS`, `actions.js:2564-2568`), whose own comment
  states it exists because "the Desk polls this from several widgets at once, so
  uncoalesced it runs dozens of overlapping 20s snapshots and starves the box (the
  owner's 'everything is stale')" — i.e., this exact symptom happened before and was
  patched. Opening additional browser tabs of Trade/Desk/Accounts today does **not**
  multiply this route's WS fan-out, because the cache is shared server-side across
  every caller, not per-tab.
- `/actions/broker-history` (`agent/routes/actions.js:733-888`) had **no equivalent
  protection** — confirmed by direct inspection, then fixed in this same session
  (commit on `claude/handover-outstanding-file-1ktjs7`): it now mirrors the
  broker-positions pattern exactly, a `days`-keyed in-flight-coalescing map with a
  12-second TTL (`bhShared`/`BH_TTL_MS`). Before the fix, Desk called this route
  unconditionally every poll tick — as often as every 5 seconds while a position or
  order is open (`Desk.jsx:256,313-318`) — with each call opening a `wsGetDeals` call
  per 7-day chunk in the requested window plus `wsSymbolsByIds`/`wsGetSymbolsList`/
  `wsGetTrader`/`wsGetAssets`, all fresh WS connections, and this scaled linearly with
  both poll frequency and the number of open Desk tabs.

**Page-load traffic and the trading loop genuinely share the same resource.** There is
no separate connection pool or rate limiter between the main scan/monitor loop's broker
calls and these page-serving routes' broker calls — both go through the same
`ctrader-ws.js` `wsRun` function against the same broker endpoint. The C++ sidecar is
not involved in either of these two read routes (confirmed: no `cpp-exec` reference in
their code) — page-load pressure and loop pressure are additive on the Node-side broker
connection, not isolated from each other.

## Bottom line

- The Cockpit/Trade/Desk/Accounts pages are not too data-rich in the sense of payload
  size — that part of the hypothesis does not hold.
- They ARE too broker-round-trip-heavy in two specific spots, and one of those two
  spots (`/actions/broker-history`) had no defense against exactly the failure mode
  already diagnosed for the boot-time scan/monitor storm, until this pass. It is now
  fixed to match its sibling route's already-proven pattern.
- This is a genuine, additive contributor to "why can't I load any page" — worsening,
  not solely causing, the underlying broker-WS-connection-storm behavior — and it
  compounds specifically when a Desk tab is left open with a position or order active
  (the 5-second "active" poll interval), which is a very plausible description of how
  the owner actually uses the app day to day.
- The already-known SCAN_CONCURRENCY=6 / MONITOR_CONCURRENCY=4 boot-time storm remains
  a larger, independent contributor to the same symptom and is not resolved by this fix.

## Fix shipped this pass

`agent/routes/actions.js` — `/actions/broker-history` now uses a `days`-keyed
in-flight-coalescing cache with a 12-second TTL, identical in structure to
`/actions/broker-positions`'s existing `bpShared`/`BP_TTL_MS` pattern. No behavior
change for a single caller; multiple simultaneous callers (multiple tabs, or a fast
poll racing a slow broker response) now share one in-flight fetch instead of each
opening their own broker WS burst.

## Open items not resolved by this pass

- Whether the boot-time SCAN_CONCURRENCY/MONITOR_CONCURRENCY connection storm (the
  original incident) and this page-load contributor were BOTH active during the live
  unavailability observed at the time this question was raised (2026-07-27 ~09:53-09:56
  UTC — `/health` and `/state/accounts` both timed out under direct probing) is not
  established; both are plausible, additive contributors and this pass did not
  attempt to disambiguate which dominated that specific window.
- No connection-count telemetry exists anywhere in the codebase (confirmed absent by
  the earlier production-incident investigation) to directly measure broker-WS
  concurrency at any point in time — recommend this as a follow-up: a simple counter
  of concurrently-open `ctrader-ws.js` sockets, logged or exposed on `/health`, would
  let both this contributor and the scan/monitor storm be measured directly instead of
  inferred from code reading.
