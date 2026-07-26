# Outstanding work — phased plan

Recorded **Sunday 26 July 2026, 09:14 SGT** (01:14 UTC) at the owner's
instruction, from the outstanding-items review in reply `№ 1,776`.

Status: **PROPOSAL. No code in this document has been written.** Nothing here
starts without the owner's word. Phases are ordered by my recommendation
(smallest-risk-highest-value first), not by how they were discovered.

Baseline at the time of writing: `main` @ `202b5dc` — PRs #385–#391 all merged,
no branch in flight, no PR open. Cockpit is live and reachable from the Desk
gauge wall and the Performance open-trades tables.

---

## Decision gates — these block the phases that name them

| # | Question | My recommendation | Blocks |
|---|---|---|---|
| D1 | Fix the three C++ sidecar findings? | Yes — C1 is undefined behaviour | P1 |
| D2 | Build `position_events`? | Yes, and first — it accumulates nothing until it exists | P2 |
| D3 | Cockpit endpoint id space: broker position id or DB row id? | DB row id, with `?brokerId=` as an alternate lookup — the DB row is the durable record | P4 |
| D4 | Rework the 127 s blocking loop pass? | Yes, but last of the server work and with a written plan first | P6 |
| D5 | Should FLEET rank by correlation instead of \|R\|? | No — the handoff defines FLEET as other open positions; relatedness belongs to the TCAS pane | P7 |
| D6 | `pre` / `post` / `halted` session states — what should the cockpit show? | Unspecified anywhere in the handoff; currently treated as closed. Needs a ruling, not a guess | P7 |
| D7 | Phone portrait `scale(0.8)` — shrink type too, or footprint only? | Footprint only; type is already at the legibility floor | P7 |
| D8 | Add visible VA / HVN / LVN labels to the volume profile? | Yes, once the profile is real (P3) — labelling demo bands invites misreading | P7 |
| D9 | F3: journal pitch measures 26.39 against a spec of ≤ 26 | Accept 26.39 or respace the panel — either is one edit | P7 |

---

## P1 — C++ sidecar thread-safety (independent review findings)

Effort: small. Isolated to `cpp-exec/`. No schema, no UI, no risk config.
Gate: **D1**.

Three findings, none fixed. **All three require `VPO_ENABLED` or
`TRAIL_TICK_ENABLED`, which default to false** — I could not read the Railway
environment from the sandbox, so I have never claimed these caused the sidecar
outage. They are real defects regardless of whether they have fired yet.

- **C1 (critical, undefined behaviour).** `SpotFeed::stop()`
  (`spot_feed.cpp:100`) runs on an HTTP thread via `POST /connect`
  (`main.cpp:360`) and calls `ws_.close()` while the feed thread is inside
  `recvText()`. That is concurrent `SSL_write` / `SSL_read` on one `SSL*`,
  followed by `SSL_free` + `::close(fd_)` under a live reader, then
  `FD_SET(-1, …)`. `ExecEngine` declares `std::mutex mtx_; // serializes all WS
  access`; `SpotFeed` has no equivalent. It is reachable in normal operation:
  `/connect` is memoised on `(host, roster, token)`, so a token refresh
  re-fires it.
  **Fix:** `::shutdown(fd_, SHUT_RDWR)` from `stop()` and let the feed thread
  tear its own socket down. No new locks.
- **C2 (high).** `/health` takes `vpoMtx`, which `/connect` holds across
  `stop()` + `join()`; the reconnect backoff `sleep_for` is uninterruptible up
  to 60 s. Result: health-check timeouts → Railway restart loop with no crash
  log, which is exactly what an outage looks like from outside.
  **Fix:** don't hold the mutex across teardown; make the backoff wait on a
  condition variable so shutdown interrupts it.
- **C3 (medium).** `std::terminate` if `server.run()` returns while
  `spotFeedThread` is joinable; the detached engine thread also captures a
  `main` local.

Verification: the repo Makefile builds and all 15 test binaries pass today —
that is the regression baseline for this phase.

## P2 — `position_events` table + write sites

Effort: small-medium. Additive schema, no reads changed. Gate: **D2**.
Specified in `docs/cockpit-data-endpoint-spec.md` §4 (table DDL, index,
retention).

The tweak journal is the only cockpit panel with **no recoverable source**.
`monitored_positions` keeps current flags (`be_moved`, `scaled_out`) and the
latest review, not a timeline. `action_log` is a generic HTTP log.
`decision_log` records decisions *upstream of the risk gate*. A journal built
from today's tables would show scan skips mislabelled as position tweaks.

Write sites, all non-throwing (same discipline as `recordDecision`):
profit-keeper ratchets / scale-outs / trail arm+tighten; the `loop.js` broker
action executor; the C++ `TrailEngine` reporting via the existing status route
so **Node** writes the row (the sidecar must never touch the DB); Telegram
manual actions and the `/actions/*` routes.

**This goes first among the data work** because history only starts
accumulating once the writes exist — the journal stays empty for however long
we delay, no matter when the endpoint lands.

## P3 — Bar retention per open position

Effort: medium. The single largest unlock in the whole backlog.

Bars are fetched per scan today and discarded. Retaining them per open
position turns **seven** demo panels real in one move: MFD chart (flown path),
EMA 9/20/50, VWAP, volume profile (POC / VA / LVN), PRICE·15m candles, RVOL,
and true MFE/MAE from bar extremes rather than stored scalars.

Open sub-questions to settle inside this phase: timeframe(s) retained, lookback
window, prune policy, and whether retention keys on the position or the symbol.

## P4 — `GET /api/positions/:id/cockpit` (+ WS patch stream)

Effort: medium. Gate: **D3** (id space) — cannot start before it is answered.
Fully specced in `docs/cockpit-data-endpoint-spec.md` §3.

Returns position + bars + indicators + tweaks (from P2) + armed + invalidation.
The cockpit swaps its in-memory adapter for this, deep links work cold, and the
amber DEMO DATA advisory shrinks on its own — that list is derived from the
data, not hardcoded, so it needs no separate edit.

WebSocket last, not first: the cockpit already polls a 2.2 s frame, so the
socket is a refinement. On a FLEET / TCAS instrument swap, close the old socket
**before** the new instrument's animations begin (BUILD-ORDER §7).

## P5 — Execution facts + pairwise correlation

Effort: small (spread / latency) + medium (correlation).

- Spread and latency exist in the sidecar and are simply not exposed per
  symbol. Small route work.
- TCAS traffic and MARKET SAYS need **pairwise** correlation of this symbol
  against the others; `/state/correlation` returns clusters, not coefficients.
  Window and source need a decision before this can be specced further, so it
  sits behind everything above.

## P6 — Unblock the agent loop (the 127-second pass)

Effort: medium-large. **[LIVE-IMPACT]** — touches the running agent.
Gate: **D4**, and I want a written plan reviewed before any diff.

Production reported `lastLoopMs: 127028`. `better-sqlite3` is synchronous, so
for roughly two minutes the process serves nothing: health checks, page loads
and order actions all queue behind it. That is the true cause of the
"unreachable" reports; PR #390 only made the symptom honest (accurate copy,
45 s abort on idempotent reads, no abort or retry on order actions).

Directions to evaluate, cheapest first: split the pass into interruptible
chunks that yield to the event loop between symbols; move the heaviest SQLite
work off the request path; only then consider a worker thread. Anything here is
verified on staging with the demo trio before it goes near production.

## P7 — Cockpit polish and known defects

Effort: small each. Gates: **D5–D9**.

- PRICE·R tape: 3–6 pairs of adjacent numeric labels overlap by 2–3 px.
  Measured, cosmetic, unfixed.
- D9 journal pitch 26.39 vs ≤ 26.
- D6 `pre` / `post` / `halted` session behaviour — currently treated as closed,
  which is a guess I am not comfortable leaving as the answer.
- D7 phone portrait scale semantics.
- D8 VA / HVN / LVN labels — after P3.
- D5 FLEET ranking — my recommendation is to leave it on \|R\|.

## Ongoing — M4 soak watch (not a phase)

Hourly, staging only, demo trio `43097342 / 46979908 / 46130058`; **live
accounts forbidden**. Silent unless anomalous (error spike, disconnect > 30 min,
a trade on a wrong account, circuit breaker). Last check 00:54 UTC was clean:
sidecar `connected: true` with the full demo roster, agent `errorsToday: 0`,
`circuitBreaker: null`, loop advancing.

---

## What is verified, and what is not

Verified by measurement, not inference:

- Cockpit live values: price, P&L, entry/SL/TP, signed R, market state, FLEET
  (computed over the account's other open positions), MFE/MAE from
  `monitored_positions`.
- The C++ findings were read against the source and the repo Makefile build
  (15/15 test binaries pass).
- The 127 s loop figure and the 1,773 reply count are both direct readings.

Not verified, and I will not claim otherwise:

- **The production POST path.** The sandbox `AGENT_SECRET` returns 401 against
  `sg-trade.up.railway.app` in 0.55 s while `GET /health` returns 200 in
  ~0.3 s — the secret authenticates against staging. A 401 never produced the
  "unreachable" message; that string comes only from the network-failure
  branch.
- **Whether `VPO_ENABLED` / `TRAIL_TICK_ENABLED` are set on Railway**, which is
  what decides whether C1/C2 have actually fired in production.
- **Railway deployment IDs** for any baseline — no Railway access from here.
