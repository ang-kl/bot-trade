# Outstanding work — phased plan, ranked by capital at risk

First recorded **Sunday 26 July 2026, 09:14 SGT** from the outstanding-items
review in reply `№ 1,776`. **Re-ordered 09:51 SGT at the owner's instruction
("re-order the phases by capital at risk")**, now folding in the L1–L7 audit
(`audit/ROLLUP.md`, merged as `12d16bb`).

Status: **PROPOSAL. No code in this document has been written.** Nothing here
starts without the owner's word.

Baseline: `main` @ `12d16bb`. No branch in flight beyond this document.

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
| D10 | Loss-cap repair: treat a NULL `net_pnl` closure as **unknown and blocking** (no new entries until it is resolved), or backfill-then-evaluate and accept a window where the cap under-counts? | Unknown-and-blocking. A cap that cannot see a loss is not a cap, and the fail-safe direction on a money ceiling is "stop trading", the same convention `global-guards.js` already uses for an unreadable config | P1 |
| D11 | The manual `position-double` / `position-reverse` routes: harden them (weighted basis, re-derived stop, add cap, atomic reverse) or **remove** them? | Remove `position-double`; harden `position-reverse` into a single netted order if the venue supports it, otherwise remove it too. Neither is used by any automated path — this is a dashboard affordance whose failure modes cost real money | P2 |
| D12 | Credential surface: keep one bearer token for every route, or split read from money-moving and add a second factor on the latter? | Split, and stop shipping any secret in the browser bundle | P5 |
| D13 | Should the LLM monitor be able to close a position without a deterministic second gate? | No — require a deterministic condition to agree before an LLM-initiated exit executes | P9 |
| D14 | Is `VPO_ENABLED` / `TRAIL_TICK_ENABLED` set in production? (audit OQ-2, OQ-5) | Answer decides whether P6 and P7 stay where they are or drop below P10 — see the conditional rule below | P6, P7 |
| D1 | Fix the three C++ sidecar findings? | Yes — C1 is undefined behaviour | P7 |
| D2 | Build `position_events`? | Yes, and first among the record work — it accumulates nothing until it exists | P10 |
| D3 | Cockpit endpoint id space: broker position id or DB row id? | DB row id, with `?brokerId=` as an alternate lookup | P12 |
| D4 | Rework the 127 s blocking loop pass? | Yes, with a written plan first | P14 |
| D5 | Should FLEET rank by correlation instead of \|R\|? | No — the handoff defines FLEET as other open positions | P15 |
| D6 | `pre` / `post` / `halted` session states — what should the cockpit show? | Unspecified anywhere; currently treated as closed. Needs a ruling | P15 |
| D7 | Phone portrait `scale(0.8)` — type too, or footprint only? | Footprint only | P15 |
| D8 | Add visible VA / HVN / LVN labels? | Yes, once the profile is real (P11) | P15 |
| D9 | F3: journal pitch 26.39 against a spec of ≤ 26 | Accept or respace — either is one edit | P15 |

**Conditional re-rank rule (D14).** If both `VPO_ENABLED` and
`TRAIL_TICK_ENABLED` are **false** in production, P6 and P7 are not reachable
today: move both below P10 and treat them as hardening before those flags are
ever switched on. If either is **true**, they stay where they are — P6 becomes
the single largest exposure on this list, because a strategy tier is placing
live orders on predicates that were never fitted.

---

## P1 — The daily-loss caps cannot see a loss

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

## P2 — ADD and REVERSE can create unprotected, unrecorded exposure

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

## P3 — Two paths leave a position the ledger does not know about

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

## P4 — Position management addresses the globally selected account and host

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

## P6 — The C++ strategy tier trades predicates that were never fitted

Capital at risk: **live orders from predicates no backtest covers, at stop
distances that change position size.** Audit F-L1-01…05, F-L4-03, F-L4-04,
F-L5-09, S11, S12. Effort: medium. Gates: **D14**, plus audit OQ-2/OQ-3/OQ-4.

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

## P7 — C++ sidecar thread-safety (was P1)

Capital at risk: **indirect** — a restart loop that leaves positions unmanaged,
and undefined behaviour in a process that holds a broker session. Effort:
small, isolated. Gates: **D1**, **D14**.

- **C1, critical.** `SpotFeed::stop()` (`cpp-exec/src/spot_feed.cpp:100`) runs on an HTTP thread via `POST /connect` (`main.cpp:360`) and closes the socket while the feed thread is inside `recvText()`: concurrent `SSL_write`/`SSL_read` on one `SSL*`, then `SSL_free` + `::close(fd_)` under a live reader, then `FD_SET(-1, …)`. `ExecEngine` guards its socket with a mutex; `SpotFeed` has none. Reachable in normal operation — `/connect` is memoised on `(host, roster, token)`, so a token refresh re-fires it. Fix: `::shutdown(fd_, SHUT_RDWR)` from `stop()`, let the feed thread tear down.
- **C2, high.** `/health` takes `vpoMtx`, which `/connect` holds across `stop()` + `join()`; the reconnect backoff sleeps up to 60 s uninterruptibly. Health timeouts → restart loop with no crash log.
- **C3, medium.** `std::terminate` if `server.run()` returns while `spotFeedThread` is joinable; the detached engine thread captures a `main` local.

Regression baseline: the repo Makefile builds and all 15 test binaries pass.

## P8 — Staleness ceilings that are not ceilings

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
