# Outstanding work — phased plan, ranked by capital at risk

First recorded **Sunday 26 July 2026, 09:14 SGT** from the outstanding-items
review in reply `№ 1,776`. **Re-ordered 09:51 SGT at the owner's instruction
("re-order the phases by capital at risk")**, now folding in the L1–L7 audit
(`audit/ROLLUP.md`, merged as `12d16bb`).

Status as of **21:22 SGT**: **P1, P2, P3, P4, P6, P7 and P8 are SHIPPED** (see
the ledger below) — every audit finding ranked ahead of a decision gate is now
closed. Everything still open carries a decision gate and does not start
without the owner's word.

Baseline: `main` @ `09de8da`.

## Shipped

| Phase | PR | Commit | What landed |
|---|---|---|---|
| **P1** | #397 | `7b2b8d4` | The daily-loss caps no longer read an unknown day as flat. `SUM` skips NULL `net_pnl`, so a day of broker-side stop-outs summed to zero and neither cap tripped. Unresolved closures older than a 15-minute grace now block, with `blockOnUnknownPnl` / `unknownPnlGraceMin` as the knobs. **Risk-limit change, owner-authorised.** |
| **P2** | #401 | `d078067` | `position-double`/`position-reverse` hardened rather than removed (D11: "harden both"): dedupe → reconcile → cap/bracket checks → order with inherited/mirrored protection, no more `allowNaked: true`. A leg-two reverse failure now reports `accountFlat: true`, writes a `risk_event`, and alerts — instead of a 502 body as the only record. |
| **P3(a)** | #396 | `e7730a3` | An ambiguous submission blocks a resubmit. The dedupe read `trades`, which the ambiguous path never writes, so the guard was blind to the one case that could double-fill. `order_failed` and `order_ambiguous` are now separated. |
| **P3(b)** | #395 | `159726d` | A skipped executor no longer marks a live position closed. `skipped` also covers `no_ctrader_position_id` and `unknown_volume`; only `ctrader_not_configured` may close DB-only now. |
| **P4** | #395 | `159726d` | Management actions route by the position's own account and host. An account absent from the registry is refused, never silently re-routed. |
| **P6** | #405, #406 | `8e60068`, `96ac895` | The C++ VPO tier stops discarding its own order result (counted outcomes + `GET /vpo-status`), then its five predicate divergences from the fitted JS strategies are closed: Donchian's volume gate restored, VWAP/EMA stops made structural, the shared RR floor applied to the six ports that lacked it, RSI-2's 60-minute timeframe floor enforced, vp-value's POC-side condition and catch-radius restored. Staging-only impact today (no `VPO_SYMBOLS` in production) — required before that variable is ever set there. |
| **P7** | #404 | `3c5cd50` | The three C++ sidecar thread-safety findings. C1: `SpotFeed::stop()` no longer tears the connection down from another thread (`wakeReader()` half-closes the socket instead of `SSL_free`+`close` under a live reader). C2: the reconnect backoff is interruptible and `/connect` no longer holds `vpoMtx` across `stop()`+`join()`, so `GET /health` can't block behind a thread join. C3: the spot feed is stopped and joined before `main` returns. Verified under ThreadSanitizer: the pre-fix `stop()` reported two data races; this code is clean. |
| **P8** | #398 | `1fb6d5b` | Staleness bounds on the regime read (240 min, stale → unknown → fail open as before) and the news cache (7 days, checked before the memo). |
| — | #399 | `a0500a5` | PRICE·R tape overlap: the de-overlap filter never fired (`filter` hands the callback the original array), and its thresholds sat below the label height. |
| — | #407 | `946afae` | Volume structure (VPOC/LVN/value-area) analysis layer + the `va_breakout` strategy, per the owner's spec — not an audit finding, but the foundation the remaining VP/Order-Flow work in `docs/order-flow-plan.md` builds on. |
| — | #408 | `09de8da` | `fib_confluence` and `va_breakout` were missing from `regime-gate.js`'s `STRATEGY_KIND` — both traded with zero regime gating since #407. Fixed, with a test that catches the next strategy that ships without an entry. |

Every audit finding ranked ahead of a decision gate is closed. **Everything
that remains is gated on an owner decision** — see the table above this
section, or §D below.

## What changed in the re-order, and why

The first ordering was by **effort and isolation** — cheapest, most contained
work first. That put a mechanical C++ thread-safety fix at the front and left
the largest capital exposures unranked, because most of them were not yet
findings when the list was written. The audit surfaced five exposures larger
than anything in the original P1–P7, none of which appeared in it at all.

This ordering is by **capital at risk**: how much money a defect can lose, and
how silently. Effort is now a note, not a sort key. Two consequences worth
stating plainly:

- **The new P1 is a change to a risk limit's behaviour.** Per `CLAUDE.md`, that
  is explicitly outside auto-merge and needs the owner's word even with a green
  gate. It is first because the brake is currently disabled, not because it is
  safe to touch unattended.
- **The old P1 (C++ thread-safety) drops to P7.** It is undefined behaviour and
  it should still be fixed, but it is reachable only when `VPO_ENABLED` or
  `TRAIL_TICK_ENABLED` is set, and those default to false. Ranking it above
  defects that fire on every trading day would be ranking by code quality,
  which is the thing this re-order exists to stop.

### Old → new mapping

| Old | New | Movement |
|---|---|---|
| P1 C++ sidecar thread-safety | **P7** | down 6 — conditional on env flags |
| P2 `position_events` + write sites | **P10** | down 8 — record integrity, no live exposure |
| P3 Bar retention per open position | **P11** | down 8 |
| P4 Cockpit data endpoint | **P12** | down 8 |
| P5 Execution facts + correlation | **P13** | down 8 |
| P6 Unblock the 127 s loop pass | **P14** | down 8 — availability, not capital |
| P7 Cockpit polish + tape overlap | **P15** | down 8 |
| — | **P1–P6, P8, P9** | new, all from the audit |

---

## Decision gates

Gates D1–D9 carry over unchanged in meaning; the "Blocks" column is renumbered.
D10–D14 are new and belong to the new phases.

| # | Question | My recommendation | Blocks |
|---|---|---|---|
| ~~D10~~ | ~~Loss-cap repair: treat a NULL `net_pnl` closure as unknown-and-blocking, or backfill-then-evaluate?~~ | **ANSWERED, unknown-and-blocking — shipped #397.** | ~~P1~~ |
| ~~D11~~ | ~~Harden the manual ADD/REVERSE routes, or remove them?~~ | **ANSWERED (owner): harden both, cTrader permits adding to and reversing an active trade — shipped #401.** | ~~P2~~ |
| D12 | Credential surface: keep one bearer token for every route, or split read from money-moving and add a second factor on the latter? | Split, and stop shipping any secret in the browser bundle | P5 |
| D13 | Should the LLM monitor be able to close a position without a deterministic second gate? | No — require a deterministic condition to agree before an LLM-initiated exit executes | P9 |
| ~~D14~~ | ~~Is `VPO_ENABLED` / `TRAIL_TICK_ENABLED` set in production?~~ | **ANSWERED 2026-07-26: both true in both environments; `VPO_SYMBOLS` on staging only. See below — P7 is production-reachable and moves to the front; P6 is staging-only for now.** | ~~P6, P7~~ |
| ~~D1~~ | ~~Fix the three C++ sidecar findings?~~ | **ANSWERED, yes — shipped #404.** | ~~P7~~ |
| D2 | Build `position_events`? | Yes, and first among the record work — it accumulates nothing until it exists | P10 |
| D3 | Cockpit endpoint id space: broker position id or DB row id? | DB row id, with `?brokerId=` as an alternate lookup | P12 |
| D4 | Rework the 127 s blocking loop pass? | Yes, with a written plan first | P14 |
| D5 | Should FLEET rank by correlation instead of \|R\|? | No — the handoff defines FLEET as other open positions | P15 |
| D6 | `pre` / `post` / `halted` session states — what should the cockpit show? | Unspecified anywhere; currently treated as closed. Needs a ruling | P15 |
| D7 | Phone portrait `scale(0.8)` — type too, or footprint only? | Footprint only | P15 |
| D8 | Add visible VA / HVN / LVN labels? | Yes, once the profile is real (P11) | P15 |
| D9 | F3: journal pitch 26.39 against a spec of ≤ 26 | Accept or respace — either is one edit | P15 |

### D14 — ANSWERED (owner, 2026-07-26, 14:50 SGT)

    cpp-exec, BOTH environments:  VPO_ENABLED=true   TRAIL_TICK_ENABLED=true
    staging only:                 VPO_SYMBOLS=EURUSD:1:vwap_trend:5

This splits P6 and P7 apart, and it promotes P7 to the top of the list.

**P7 is live in PRODUCTION.** `TRAIL_TICK_ENABLED=true` alone starts the spot
feed (`cpp-exec/src/main.cpp:183-190`), and the `/connect` teardown branch is
`if ((vpoDispatcher && !vpoSymbolIds.empty()) || trailTickEnabled)`
(`main.cpp:357`) — so with the trail flag on, **every `/connect` call runs
`spotFeed->stop()` from an HTTP thread**, which is exactly finding C1: a
concurrent `SSL_write`/`SSL_read` on one `SSL*`, then `SSL_free` + `close(fd_)`
under a live reader. `/connect` is memoised on `(host, roster, token)`, so a
token refresh re-fires it. C2 rides the same branch: `vpoMtx` is held across
`stop()` + `join()` while `/health` wants it. Both are undefined behaviour and
a restart-loop risk in the process that holds the broker session, in
production, today.

**P6 is live in STAGING only.** `VPO_ENABLED=true` does nothing without a
parseable `VPO_SYMBOLS` — the dispatcher is only constructed when
`vpoEnabled && !vpoSymbolsSpec.empty()` (`main.cpp:199`), and production has no
`VPO_SYMBOLS`. So the five predicate divergences and the discarded order result
are **not** reachable in production right now. They ARE reachable on staging
for `EURUSD` on `vwap_trend`, which is the M4 soak's own subject.

**Revised order:** P7 first (production UB, small and isolated), then P6
(before `VPO_SYMBOLS` is ever set in production — it is a loaded gun otherwise,
because that tier is the only place in the system that can open a position
without passing the risk gate).

**A correction to the soak watch's own reasoning.** With a VPO strategy armed
on staging, an empty `/state/risk-events` no longer implies "no trades opened":
a sidecar-originated fill never reaches Node's risk gate at all. The detection
path is `openPositions` / `openTrades` on `/health`, which populate one
reconcile after the fill adopts it. Both have read 0 all day, and EURUSD is
shut for the weekend — but the inference chain is now written down rather than
assumed.

---

## P1 — SHIPPED (#397) — The daily-loss caps cannot see a loss

Capital at risk: **the ceiling on a losing day.** Audit F-L6-06, F-L6-01, S22.
Effort: small in code, careful in review. Gate: **D10**. Risk-limit change →
owner's word required regardless of the gate.

`agent/services/global-guards.js:71-75` and `agent/services/risk.js:538` sum
`net_pnl` over closed trades. SQLite's `SUM` skips NULLs and the surrounding
`COALESCE` turns an all-NULL sum into `0`. Three of the seven closure paths
leave `net_pnl` NULL — including the reconciler's broker-side close
(`agent/services/reconciler.js:285`), which is the normal exit for a stop-out.
So a day composed of stop-outs presents as a flat day and neither the
portfolio cap nor the per-account cap ever trips.

`pnl-backfill.js` is the only repair, and it is gated on three conditions
(`agent/services/pnl-backfill.js:44-48,66,119`), any of which failing leaves
the row NULL indefinitely.

Two halves, and the second is the one that matters: make the closure paths
write the money fields, **and** make the caps refuse to treat "unknown" as
"zero". Fixing only the first leaves the brake blind to every row already in
the table.

## P2 — SHIPPED (#401) — ADD and REVERSE can create unprotected, unrecorded exposure

Capital at risk: **an unstopped position of arbitrary size, invisible to every
risk computation.** Audit F-L5-02, F-L5-03, F-L5-01, F-L5-08, S13, S14.
Effort: small. Gate: **D11**.

`POST /actions/position-double` (`agent/routes/actions.js:1154-1180`) places a
second market order with `allowNaked: true`, writes nothing to the DB, and has
no cap — no counter, no check, before or after send. No weighted-average entry
exists anywhere in the schema, so from that moment every R-multiple, exposure
sum and attribution for that symbol is computed against a basis that is not the
position's basis. `risk.js`'s `duplicate_symbol` veto does not protect it: that
veto lives in the strategy gate, not in this route.

`POST /actions/position-reverse` (`:1184-1211`) is a two-leg close-then-open.
The flat window is the whole of leg two — a fresh WS connect, app auth, account
auth and `NEW_ORDER_REQ`, up to a 20 s timeout. If leg two rejects, the account
is left flat with the thesis abandoned, and a 502 response body is the only
record anywhere. The new leg carries no stop, by explicit exemption.

Neither route has a dedup key, so a client retry after a timeout doubles the
add or the reversal.

## P3 — SHIPPED (#395, #396) — Two paths leave a position the ledger does not know about

Capital at risk: **unmanaged exposure, and a duplicate on top of it.** Audit
F-L4-01, F-L6-02, S10, S23. Effort: small-medium.

**The ambiguous timeout.** `wsPlaceOrder` correctly refuses to retry after
`NEW_ORDER_REQ` went out (`agent/lib/ctrader-ws.js:236-241`), so the fill may
have happened while the response was lost. The catch at `agent/loop.js:519-536`
writes a `risk_events` row and `last_order_error` — never a `trades` row. The
3-minute idempotency window then queries `trades` (`agent/loop.js:389-394`),
finds nothing, and the same signal can be submitted again against a position
that may already be live. The guard protects against the retry it disabled and
not against the one path that still doubles.

**The skipped executor.** `agent/loop.js:1985-1988` marks the monitored row
closed locally when `executeBrokerAction` returns `skipped`. The comment scopes
that to "not configured", but `skipped` is also returned for
`no_ctrader_position_id` and `unknown_volume` — cases where a live broker
position exists and is now unmanaged with the local record saying it is gone.

## P4 — SHIPPED (#395) — Position management addresses the globally selected account and host

Capital at risk: **closes and stop amends issued against the wrong account, and
demo-versus-live one config key apart.** Audit F-L4-02, S20. Effort: small.
Depends on audit OQ-10 for urgency, not for correctness.

`executeBrokerAction` reads `ctrader_account_id` and `ctrader_is_live` from
global state (`agent/loop.js:820-821`) and `selectBrokerContext` returns only
`positionId` and `volumeLots` (`agent/loop.js:1002-1007`) — no `account_id`,
although the column exists on both tables. With more than one account enabled,
a close for account B is issued on account A's session; and because
`ctrader_is_live` also selects the host, a demo position can be addressed
against the live host. The failure presents as `POSITION_NOT_FOUND`, which the
amend path treats as "already closed" — so a live position can be recorded as
gone.

## P5 — One resettable credential path guards every money-moving route

Capital at risk: **full trading authority.** Audit F-L7-04, F-L7-06, F-L7-05,
carried F-L0-01, S28. Effort: medium. Gate: **D12**.

Everything under `/actions` — including `position-double`, `position-reverse`,
`close-all` and `manual-order` — sits behind one bearer check accepting either
the master secret or a device session (`agent/index.js:352-363`). No per-route
authorisation, no second factor, no distinction between read-shaped and
money-moving routes.

The login path's protections are process-local: `lastCodeRequestAt` is one
global 30-second throttle, not per-IP, so any unauthenticated caller can force
a Telegram code to the owner's chat indefinitely; `verifyFailures` is an
in-memory counter that resets on process restart **and** on every new code
request (`agent/index.js:223,232`), so the advertised 5-attempt lock on a
6-digit code is not a durable bound. A successful verify mints a 90-day token.
Carried F-L0-01 puts a secret in the browser bundle as a second independent
route to the same authority. Audit OQ-16 asks whether it has been rotated since.

Also here: `GET /health` is unauthenticated and returns `commit`, `errorsToday`,
`lastError`, `openPositions`, the enable flags and `dbPath`.

## P6 — SHIPPED (#405, #406) — The C++ strategy tier trades predicates that were never fitted

Capital at risk: **live orders from predicates no backtest covers, at stop
distances that change position size.** Audit F-L1-01…05, F-L4-03, F-L4-04,
F-L5-09, S11, S12. Effort: medium. Gate: D14 answered — **staging-only today**
(`VPO_SYMBOLS=EURUSD:1:vwap_trend:5`), because production has no `VPO_SYMBOLS`
and the dispatcher is never constructed without one. Fix it BEFORE that
variable is ever set in production.

When `VPO_ENABLED=true` and `VPO_SYMBOLS` parses, `vpo_strategies.cpp` stops
being a mirror and becomes an **originating** decision-maker: `tryFire` calls
`engine_.placeOrder` directly (`cpp-exec/src/vpo_dispatcher.cpp:108`) with no
Node involvement, so the risk gate, the news gate, the duplicate-symbol veto
and the correlation caps are all bypassed. Five divergences, each source-cited
in `audit/L1-L3.md`:

- Donchian's volume gate — a hard veto in JS — is deleted (`vpo_strategies.cpp:256-259`).
- Stop and target are the bare ATR buffer, not entry-to-structure, so size and R both differ (`:219-220`, `:49-50`).
- No R:R floor on six of the seven ports.
- RSI-2's 60-minute timeframe floor, a walk-forward result, is absent.
- The value-area strategy drops its POC-side condition and widens the catch radius 3×.

On top of that the tier **discards its own order result**
(`vpo_dispatcher.cpp:108-109`: `(void)result`), so a fill, a rejection and an
error are one non-event, and Node learns of a fill only when a later reconcile
adopts it.

## P7 — SHIPPED (#404) — C++ sidecar thread-safety (was P1)

Capital at risk: **direct, and live in production as of the D14 answer.** A
restart loop leaves positions unmanaged, and C1 is undefined behaviour in the
process that holds the broker session. Effort: small, isolated. Gate: **D1**
(D14 is answered).

`TRAIL_TICK_ENABLED=true` in production means the `/connect` teardown branch
runs on every call, so C1 and C2 are reachable now — not conditionally, not
hypothetically. This was ranked seventh on the assumption the flags were off.
They are not.

- **C1, critical.** `SpotFeed::stop()` (`cpp-exec/src/spot_feed.cpp:100`) runs on an HTTP thread via `POST /connect` (`main.cpp:360`) and closes the socket while the feed thread is inside `recvText()`: concurrent `SSL_write`/`SSL_read` on one `SSL*`, then `SSL_free` + `::close(fd_)` under a live reader, then `FD_SET(-1, …)`. `ExecEngine` guards its socket with a mutex; `SpotFeed` has none. Reachable in normal operation — `/connect` is memoised on `(host, roster, token)`, so a token refresh re-fires it. Fix: `::shutdown(fd_, SHUT_RDWR)` from `stop()`, let the feed thread tear down.
- **C2, high.** `/health` takes `vpoMtx`, which `/connect` holds across `stop()` + `join()`; the reconnect backoff sleeps up to 60 s uninterruptibly. Health timeouts → restart loop with no crash log.
- **C3, medium.** `std::terminate` if `server.run()` returns while `spotFeedThread` is joinable; the detached engine thread captures a `main` local.

Regression baseline: the repo Makefile builds and all 15 test binaries pass.

## P8 — SHIPPED (#398) — Staleness ceilings that are not ceilings

Capital at risk: **entries gated, or not gated, on data of unbounded age.**
Audit F-L1-09, F-L2-04, F-L2-05, F-L7-02, S2, S7, S26, S27. Effort: small each.

- **Regime, unbounded.** `latestRegime` reads `regimes ORDER BY computed_at DESC LIMIT 1` with no age bound (`agent/services/regime-gate.js:34-37`). A row from days ago keeps gating today's entries, and an absent row fails open.
- **Tick age at the C++ fire site, unbounded.** `tryFire` consults no timestamp (`cpp-exec/src/vpo_dispatcher.cpp:71-82`), and `SpotFeed` reconnects with a backoff during which no tick arrives.
- **News calendar, unbounded on the read path.** Both failure branches of `loadFeed` return the previous cache with no age check (`agent/services/news-calendar.js:66-68`); `cachedEventsSync` memoises on the fetch timestamp so it cannot tell 6 hours from 6 weeks. Its timestamps are parsed with bare `Date.parse` — no timezone assertion, so a feed-side format change moves every blocking window silently.

The one ceiling that is fail-closed today is the VPO config store's 5 minutes
(`cpp-exec/src/vpo_config_store.cpp:23,36`) — the shape the others should copy.

## P9 — Model output closes positions with no deterministic second gate

Capital at risk: **an exit taken on unvalidated text.** Audit F-L7-03. Effort:
small. Gate: **D13**.

`agent/loop.js:1964-1992`: on `check.action === 'EXIT'` the monitor calls
`executeBrokerAction(… FULL_EXIT …)` with `check.reasoning` as the recorded
reason. The action is not validated against a permitted set at the call site,
and the thesis text the model reasons over is itself partly model-authored and
stored (`monitored_positions.thesis`, appended to by the reconciler at
`agent/services/reconciler.js:108`) — so text that has passed through the
database can influence a live exit.

## P10 — `position_events` + write sites (was P2)

Capital at risk: **none directly; it is the record.** Audit F-L5-07 (the H1
trigger), F-L5-05, F-L6-03, S15, S24. Effort: small-medium. Gate: **D2**.

Specified in `docs/cockpit-data-endpoint-spec.md` §4. The audit strengthens the
case twice over: there is **no column linking a child event to a parent
position**, which is why H1 fired and why L6 attribution is halted for
reversed, added-to and partially-closed positions; and per-tranche realised P&L
has nowhere to live, so a position scaled out at +1R and stopped at breakeven
on the runner reports the runner's number as the trade's outcome.

Still first among the record work: history accumulates nothing until the writes
exist, so every day of delay is unrecoverable.

## P11 — Bar retention per open position (was P3)

Effort: medium. The largest single unlock: seven demo cockpit panels turn real
in one move (chart, EMAs, VWAP, volume profile, PRICE·15m, RVOL, true
MFE/MAE). No capital exposure of its own.

## P12 — `GET /api/positions/:id/cockpit` + WS patch stream (was P4)

Effort: medium. Gate: **D3** — cannot start until the id space is settled.
Specced in `docs/cockpit-data-endpoint-spec.md` §3.

## P13 — Execution facts + pairwise correlation (was P5)

Effort: small (spread, latency) + medium (correlation). Window and source for
the correlation need deciding before it can be specced further.

## P14 — Unblock the 127-second loop pass (was P6)

**[LIVE-IMPACT]** Effort: medium-large. Gate: **D4**, and a written plan
reviewed before any diff. Availability, not capital: production reported
`lastLoopMs: 127028`, and `better-sqlite3` is synchronous, so for roughly two
minutes the process serves nothing. PR #390 made the symptom honest; this is
the cause.

## P15 — Cockpit polish and known defects (was P7)

Effort: small each. Gates **D5–D9**. Includes the measured 2–3 px overlap
between adjacent PRICE·R tape labels.

## What's actually left (21:22 SGT)

Every audit-ranked phase (P1–P9) is shipped or gated on the owner alone —
none are blocked on more investigation. In gate order:

| Gate | Phase | What it decides |
|---|---|---|
| **D12** | P5 | Split the one bearer token (read vs money-moving), stop shipping any secret in the browser bundle |
| **D13** | P9 | Require a deterministic second gate before an LLM-initiated exit executes |
| **D2** | P10 | Build `position_events` — the record layer for weighted-basis exposure after an add |
| **D3** | P12 | Cockpit endpoint id space (DB row id vs broker position id) |
| **D4** | P14 | Whether/how to unblock the 127 s loop pass — needs a written plan first, not just a decision |
| **D5–D9** | P15 | Cockpit polish (FLEET ranking, session-state display, phone scaling, VA/HVN/LVN labels, tape pitch) |

Alongside those, `docs/order-flow-plan.md` (2026-07-26) adds three ranked,
**ungated** next steps — none touch risk limits, credentials, or live/demo,
so they ship as ordinary default-off strategy PRs, flagged to the owner
because they're new trading logic:

1. `multipleNodeLevels()` — HVN-coincidence confluence function in
   `agent/lib/volume-structure.js`, feeds conviction on strategies already
   shipped.
2. `vpoc_retest` — new default-off strategy: retest of a heavy-volume node,
   trading the continuation (distinct from `vp_value`'s fade and
   `va_breakout`'s edge-failure).
3. Volume-based take-profit assist in the exit layer — bank/tighten before
   the next LVN/HVN ahead of a winner.

## What the shipped work added to the soak watch

Three markers that should never appear on the demo trio, and that break the
watch's silence if they do: `order_ambiguous` and `unknown_daily_pnl` in
`risk_events`, and `CLOSE_NOT_EXECUTED` in `action_log`.

## Ongoing — M4 soak watch (not a phase)

Hourly, staging only, demo trio `43097342 / 46979908 / 46130058`; **live
accounts forbidden**. Silent unless anomalous. Last check 01:39 UTC clean on
all four probes.

---

## What is verified, and what is not

Unchanged from the first version of this document, and now backed by
`audit/ROLLUP.md` §E–F: **19 TIER-B data requests** and **19 TIER-C operator
questions** are open. The ones that gate this ordering are audit **OQ-2** and
**OQ-5** (are the VPO/trail flags set — D14), **OQ-10** (is more than one
account enabled — P4's urgency), **OQ-16** (has the agent secret been rotated
since the frontend bundle shipped — P5), and carried **Q1** (is `DB_PATH` on a
volume — on an ephemeral path P1's repair is undone at every redeploy).

Still not verified from this sandbox, and not assumed: the production POST path,
the Railway environment values, and Railway deployment IDs.
