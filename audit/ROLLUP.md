# Audit ROLLUP — L1 through L7

Repository: `ang-kl/bot-trade` @ `main`, `package.json` version 0.1.381.
Consolidation of `audit/L1-L3.md`, `audit/L4-L5.md`, `audit/L6-L7.md`.
**No new findings.** Every row here is carried from a pass file by ID.

Counts: 46 findings — L1 10, L2 5, L3 5, L4 7, L5 15, L6 9, L7 6 (plus the
seven carried L0 findings, extended where later evidence warranted:
F-L0-06 by F-L1-01…05, F-L0-07 resolved by L5.1i, F-L0-02 by L5.4 and F-L6-07).

Halt conditions fired: **H1** (L5.2 — no parent link for child events; L6
attribution halted for reversed, added-to and partially-closed positions).
**H2** (L2.3 — declared book depth not establishable; no depth-conditional
strategy finding is claimed anywhere in this audit). H3 did not fire — nothing
in these three passes required running code forbidden by E4.

---

## C. SILENT-FAILURE REGISTER — consolidated, ranked

Ranked by consequence, not by layer. Thirty paths.

| # | Severity | Silent path | Evidence |
|---|---|---|---|
| S22 | CAPITAL | Portfolio and per-account daily-loss caps sum NULL P&L to zero, disabling the brake | `agent/services/global-guards.js:71-75`, `agent/services/risk.js:538` |
| S23 | CAPITAL | Local close with no broker close when the executor reports `skipped` — covers `no_ctrader_position_id` and `unknown_volume`, not just not-configured | `agent/loop.js:1985-1988` |
| S10 | CAPITAL | Ambiguous order timeout writes no `trades` row, so the 3-minute dedupe cannot see a fill that happened | `agent/loop.js:519-536`, `agent/loop.js:389-394` |
| S13 | CAPITAL | REVERSE leg-two rejection leaves the account flat; a 502 body is the only record | `agent/routes/actions.js:1191-1210` |
| S20 | CAPITAL | Multi-account mis-routing presents as `POSITION_NOT_FOUND`, which the amend path treats as already-closed | `agent/loop.js:833-846` |
| S11 | CAPITAL | VPO order result discarded — `(void)result`; fill, reject and error are one non-event | `cpp-exec/src/vpo_dispatcher.cpp:108-109` |
| S2 | CAPITAL | Regime row of unbounded age gates a live entry | `agent/services/regime-gate.js:34-37` |
| S21 | CAPITAL | Broker-side close leaves `net_pnl` / `gross_pnl` / `exit_price` NULL while reading as complete | `agent/services/reconciler.js:285`, `agent/db.js:884-893` |
| S15 | CAPITAL | Tranche P&L discarded on every scale-out; the trade's recorded outcome is the runner's | `agent/loop.js:894-936`, `agent/services/profit-keeper.js:323-334` |
| S17 | CAPITAL | Keeper SL amend failure counted then forgotten; `action_log` written only when something succeeded | `agent/services/profit-keeper.js:341-345,354` |
| S19 | CAPITAL | C++ trail amend failures live in stderr and an in-memory counter no Node service reads | `cpp-exec/src/trail_engine.cpp:155-162` |
| S16 | CAPITAL | `executeBrokerAction` returns broker errors as a string; a failed amend leaves `current_sl` describing a stop the broker does not have | `agent/loop.js:938-940` |
| S1 | CORRECTNESS | Strategy module import failure substituted with a compute that never signals | `agent/services/strategies.js:20-26` |
| S25 | CORRECTNESS | Strategy-scoped brakes skip NULL-`label_strategy` trades, so adopted trades cannot trip an auto-disarm | `agent/services/adaptive-breaker.js:54`, `agent/services/edge-watchdog.js:62` |
| S26 | CORRECTNESS | Calendar feed failure degrades to an unbounded-age cache | `agent/services/news-calendar.js:66-68` |
| S27 | CORRECTNESS | Calendar timestamps parsed with no timezone assertion | `agent/services/news-calendar.js:81` |
| S28 | CORRECTNESS | Login brute-force counter resets on restart and on each new code request | `agent/index.js:223,232,245` |
| S12 | CORRECTNESS | VPO sizing unavailable → arm dropped, `return true`, no log or counter | `cpp-exec/src/vpo_dispatcher.cpp:89-97` |
| S7 | CORRECTNESS | Firing on a stale tick after a spot-feed reconnect; no timestamp consulted | `cpp-exec/src/vpo_dispatcher.cpp:71-82`, `cpp-exec/src/spot_feed.cpp:281` |
| S14 | CORRECTNESS | Route-level partial close writes nothing; stale size, stale stop, and a false tamper alert next reconcile | `agent/routes/actions.js:1100-1118` |
| S24 | CORRECTNESS | Banked scale-out leg leaves no closure record at all | `agent/loop.js:894-936` |
| S3 | CORRECTNESS | Bars with a missing anchor field are dropped and the array closes up; indicators read positions as periods | `agent/lib/ctrader-ws.js:411` |
| S4 | CORRECTNESS | Strategy compute throws → whole loop cycle aborts, recorded without symbol or strategy | `agent/services/fib-strategy.js:453-455`, `agent/loop.js:2239-2245` |
| S5 | CORRECTNESS | Symbol not in this rotation batch produces no row of any kind | `agent/services/fib-strategy.js:547-559` |
| S6 | CORRECTNESS | Stall alerts suppressed 300 s after boot with recovery silent; a controller dead from boot shows `idle` | `agent/services/heartbeat.js:121-131,171-173` |
| S8 | CORRECTNESS | Corrupt universe JSON degrades to `[]` and logs as an owner configuration state | `agent/loop.js:1415` |
| S9 | CORRECTNESS | Depth book overflow clears the whole book; the empty snapshot is recorded as the same null as depth-off | `cpp-exec/src/depth_book.cpp:32` |
| S18 | CORRECTNESS | `pushTrailConfig` failure indistinguishable from "sidecar trailing is off" | `agent/lib/exec-engine.js:92-101` |
| S29 | CORRECTNESS | Completeness sweep cannot see rows with NULL `closed_at_ms` — the same blind spot as what it polices | `agent/services/close-completeness.js:38-40` |
| S30 | CORRECTNESS | Postmortem eligibility silently reclassifies NULL-P&L closes | `agent/services/loss-postmortem.js:303-309` |

---

## D. LAYER VERDICT — consolidated

| Sub-item | Verdict | Blocking token |
|---|---|---|
| L1.1 Determinism per strategy | settled | — |
| L1.2 Parameters vs sample | NOT EVIDENCED | TIER-B, DR-1 |
| L1.3 Regime dependency | PARTIAL — runtime detected, fitting regime absent | TIER-B, DR-1 |
| L1.4 Look-ahead | settled, one live defect (F-L1-06); C++ side unresolved | TIER-B, DR-2 |
| L1.5 Dual-owned strategies | settled — not semantically identical for any of the eight | — |
| L2.1 Source / granularity / timezone / gaps | settled | — |
| L2.2 Survivorship / corporate actions | settled as absence | — |
| L2.3 Book depth | NOT EVIDENCED — **H2 fires** | TIER-C OQ-1; TIER-B DR-3 |
| L2.4 Staleness ceiling | settled — bars 1 bar, VPO 5 min fail-closed, **regime unbounded**, tick age unbounded | — |
| L3.1 Universe construction | settled — static blob, six inconsistent parsers, no pruner | — |
| L3.2 Liveness | settled — distinguished for the sidecar only | — |
| L3.3 Silence decomposition | settled as the finding — (a) not separable from silent unavailability or rotation exclusion | — |
| L4.1 Order lifecycle | settled — partial fill, cancel-replace, mid-flight restart and wrong-account routing all unhandled | — |
| L4.2 Idempotency | PARTIAL — no double-fill on the path that retries; double-fill reachable on the path that does not record | — |
| L4.3 Slippage / fees | settled — realised captured, assumed not modelled, fees deferred to a backfill | — |
| L4.4 Dual-owned guards | settled — mirrors, with C++ checks runtime-switchable and JS unconditional | — |
| L5.0 Capability inventory C01–C16 | settled — 9 PRESENT, 4 PARTIAL, 2 NOT PRESENT, 1 NOT EVIDENCED | C07 → TIER-C Q6 |
| L5.1a REVERSE | settled — two-leg, flat window = whole of leg two, leg two unstopped | — |
| L5.1b ADD basis | settled — no weighted basis exists → CAPITAL | — |
| L5.1c ADD stop | settled — not re-derived, new leg naked | — |
| L5.1d ADD cap | settled — none | — |
| L5.1e REDUCE residual | settled — inherits; route path also leaves size and tamper baseline stale | — |
| L5.1f REDUCE tranche P&L | settled — collapsed at final close; no table.column holds it | — |
| L5.1g HEDGE vs NET | settled in code — assumes netting, permits hedging | TIER-C Q6 / OQ-9 |
| L5.1h ROLL | settled as absence; back-adjusted-series question not in-repo | TIER-C OQ-8; TIER-B DR-8 |
| L5.1i C09 authority | **settled — resolves F-L0-07.** js: JS only. cpp+`TRAIL_TICK_ENABLED` unset: JS only. cpp+set: **both**, policy in JS, execution in C++, neither authoritative | — |
| L5.2 Identity and lineage | settled as the finding — **H1 fires** | — |
| L5.3 Idempotency / concurrency per capability | settled — C02/C03/C06/C08 keyless; C09 two writers | — |
| L5.4 Restart and reconciliation | settled — broker is the boot truth; human close detected with money fields NULL | interacts with TIER-C Q1 |
| L5.5 Silent-path enumeration | settled — S10–S20 | — |
| L6.1 Field completeness per closure path | settled — seven paths tabulated; three leave money fields NULL, one closes nothing | — |
| L6.2 Nullable-column filters | settled — 16 sites enumerated with no data, as required | — |
| L6.3 Hit rate + payoff + expectancy | **none reported, none owed** — no trade rows in the repository | TIER-B, DR-14 |
| L6.4 Can the schema support 6.3 | settled — **yes**; the gap is the interface (no `symbol` groupBy) plus the censoring and the H1 exclusions | — |
| L7.1 External inputs | settled — seven inputs tabulated; LLM output closes positions | — |
| L7.2 Trust boundary | settled — four unauthenticated endpoints; one resettable credential path guards every money route | TIER-C OQ-14…16, Q5 |
| L7.3 Three crowded assumptions | settled | — |

---

## E. DATA REQUESTS (TIER-B) — consolidated

| ID | Layer | What to export |
|---|---|---|
| DR-1 | L1.2, L1.3 | `backtest_results` grouped by strategy/symbol/timeframe with counts and date span; `agent_state.backtest_baseline_json`; the 2026-07-21 walk-forward output as data |
| DR-2 | L1.4 | One `POST /vpo-config` request body as sent, with the wall-clock time of the push, to prove closed-bars-only |
| DR-3 | L2.3 | `POST /depth` per configured symbol at `levels: 50`, recording `enabled`, `active`, and level counts returned |
| DR-4 | L2.4 | Per trade, the newest `regimes.computed_at` at or before `trades.created_at` — regime staleness at decision time |
| DR-5 | L3.3 | A week of `agent_state.last_error` / `api_ctrader_last_error` values, plus the full `controller_heartbeats` table |
| DR-6 | L1.5 | Sidecar `TELEMETRY_PATH` filtered to `TK_ORDER_SUBMIT` / `TK_ORDER_REJECT`, cross-referenced against `trades` whose label starts `vpo:` |
| DR-7 | L4.2 | `risk_events` where `veto_reason LIKE 'order_failed:%'`, plus broker deal history for the five minutes after each |
| DR-8 | L5.1h | `agent_state` values for `autopilot_symbols_json`, `watchlist_json`, `symbol_id_map` |
| DR-9 | L5.1f | Broker deal history for every `positionId` with `scaled_out=1`, versus that trade's `net_pnl` |
| DR-10 | L4.1 | `monitored_positions` active rows grouped by `account_id`, plus `ctrader_account_id` and `ctrader_is_live` |
| DR-11 | L5.1g | Open trades grouped by symbol and side, plus one `RECONCILE_RES` body |
| DR-12 | L5.3 | Sidecar `GET /trail-status` and `monitored_positions.current_sl` captured in the same minute |
| DR-13 | L5.4 | Count and date span of closed trades with NULL `net_pnl` |
| DR-14 | L6.3 | **The export that closes L6** — completeness census, then hit rate + payoff + expectancy by regime and by instrument, plus the H1-excluded row list. Full SQL in `audit/L6-L7.md` §E |
| DR-15 | L6.1 | Locally-closed-but-broker-open population, with a same-moment reconcile snapshot |
| DR-16 | L7.1 | `news_calendar_fetched_ms` sampled daily for a week, plus one raw calendar body to pin the `date` timezone format |
| DR-17 | L7.1 | Closed trades whose `close_reason` is neither a reconciler nor a stale-reconcile string — the LLM and position-manager residue |
| DR-18 | L7.2 | Railway logs filtered to `[auth] 401` and `POST /auth/telegram/` |
| DR-19 | L6.2 | Closed trades per day with the count of NULL `net_pnl` beside the summed P&L — days the loss cap under-counted |

---

## F. OPERATOR QUESTIONS (TIER-C) — consolidated

Carried from L0, still unanswered, and now load-bearing for the findings named:

| ID | Question | Findings that depend on it |
|---|---|---|
| Q1 | Is `DB_PATH` set to a mounted-volume path, and on which service? | F-L5-04, F-L5-12, F-L6-01, F-L6-07, L5.4 |
| Q2 | Is `EXEC_ENGINE` js or cpp in production? | F-L1-01…05, F-L4-03, F-L4-07, F-L5-10 |
| Q3 | If cpp, what is `EXEC_URL`? | F-L0-03 |
| Q4 | Is `server/ctrader-monitor.js` deployed anywhere? | F-L0-05 |
| Q5 | Is `VITE_AGENT_SECRET` the only credential guarding agent write routes? | F-L5-08, F-L7-04, F-L7-06 |
| Q6 | Live capital status: paper, live or mixed? | F-L5-06, and the meaning of every L6 number |

New, one line each, closed:

| ID | Layer | Question |
|---|---|---|
| OQ-1 | L2.3 | Is a minimum book depth required by any strategy you run, and if so what is the number? |
| OQ-2 | L1.5 | Is `VPO_ENABLED` set to `true` on the deployed `cpp-exec` service? |
| OQ-3 | L1.5 | If yes, what is the exact `VPO_SYMBOLS` string, including the digits field per entry? |
| OQ-4 | L1.5 | What are `VPO_MACRO_TF` and `VPO_MICRO_TF` set to? |
| OQ-5 | L2.3 | Is `DEPTH_FEED_ENABLED` set to `true`? |
| OQ-6 | L1.3 | Was any registered strategy fitted on a regime other than the one it is armed in today? |
| OQ-7 | L3.1 | Is `autopilot_symbols_json` maintained by hand, or by `strategy-autopilot.js` alone? |
| OQ-8 | L5.1h | Is any traded instrument a continuous or back-adjusted series rather than the dated contract the broker fills? |
| OQ-9 | L5.1g | Are the accounts in use configured hedging or netting at the venue? |
| OQ-10 | L4.1 | Is more than one account enabled for trading simultaneously today? |
| OQ-11 | L4.4 | Has `POST /config` ever been called with `requireBracket` or `requireTarget` false on the deployed sidecar? |
| OQ-12 | L5.0 | When you halt, do you intend open positions to keep being managed, or to be frozen? |
| OQ-13 | L5.1 | Are `position-double` and `position-reverse` used in live operation, or are they dashboard-only affordances? |
| OQ-14 | L7.2 | Is the agent's `/health` endpoint reachable from the public internet, or only from inside the Railway network? |
| OQ-15 | L7.2 | Is the `cpp-exec` service's HTTP port publicly reachable? |
| OQ-16 | L7.2 | Has `AGENT_SECRET` been rotated since the frontend bundle containing `VITE_AGENT_SECRET` was last deployed? |
| OQ-17 | L7.1 | Do you intend the LLM monitor to be able to close a position without a deterministic second gate? |
| OQ-18 | L7.1 | Is the news-window gate enabled in `risk_config_json` today? |
| OQ-19 | L6.1 | Is the deal-history backfill known to be succeeding in production for the full period you care about? |

---

## G. TOP 5 BY CAPITAL AT RISK — consolidated across all layers

Ranked by capital at risk, not by layer or by code quality. Each row names the
per-pass rank it is promoted from.

1. **F-L5-02 / F-L5-03 — ADD has no cost basis, no stop, and no cap.**
   `agent/routes/actions.js:1154-1180`. One route call places an unprotected
   second position; no weighted-average entry exists anywhere in the schema, so
   from that moment every R-multiple, exposure sum and attribution for that
   symbol is computed against a basis that is not the position's basis. It can
   be called again immediately — no counter, no veto, no alert. Promoted from
   L4-L5 rank 1. Depends on OQ-13.

2. **F-L6-06 / S22 — the daily-loss caps sum NULL P&L to zero.**
   `agent/services/global-guards.js:71-75`, `agent/services/risk.js:538`.
   Broker-side stop-outs close with `net_pnl` NULL (F-L6-01); `SUM` skips
   NULLs; `COALESCE` turns the empty sum into 0. The portfolio and per-account
   loss brakes are therefore disabled for precisely the trades most likely to
   be losses, and a losing day presents as flat. Promoted from L6-L7 rank 1.
   Depends on Q1, OQ-19.

3. **F-L1-01 / F-L1-03 / F-L1-05 — the C++ strategy tier trades different
   predicates, different stops and no R:R floor.** `cpp-exec/src/vpo_strategies.cpp:256-259`
   (Donchian volume gate deleted), `:219-220` and `:49-50` (stop is the bare
   ATR buffer, not entry-to-structure, so size and R both differ), `:421-509`
   (no floor on six of seven ports). Under `EXEC_ENGINE=cpp` with VPO armed
   this tier originates orders with no Node involvement
   (`cpp-exec/src/vpo_dispatcher.cpp:108`) and discards their outcome
   (F-L4-03). Promoted from L1-L3 ranks 1–3. Depends on Q2, OQ-2, OQ-3.

4. **F-L4-01 / F-L6-02 — the two places a position can exist that the ledger
   does not know about.** `agent/loop.js:519-536` (ambiguous order timeout
   writes no `trades` row, so the 3-minute dedupe is blind to a fill that
   happened) and `agent/loop.js:1985-1988` (a `skipped` executor marks the
   local row closed while a live broker position remains, for
   `no_ctrader_position_id` and `unknown_volume` as well as the intended
   not-configured case). Both produce unmanaged exposure with no distinguishing
   marker. Promoted from L4-L5 rank 2 and L6-L7 rank 2.

5. **F-L4-02 — position management addresses the globally selected account and
   host.** `agent/loop.js:833-846`, `agent/loop.js:1002-1007`.
   `executeBrokerAction` reads `ctrader_account_id` and `ctrader_is_live` from
   global state and `selectBrokerContext` returns no `account_id`, though the
   column exists on both tables. With two accounts enabled, closes and stop
   amends address the wrong session — and `ctrader_is_live` also selects the
   host, so demo and live are one config key apart. Promoted from L4-L5 rank 3.
   Depends on OQ-10, Q6.

**Ranked immediately below, and named so the cut is visible:** F-L5-01 (REVERSE
leaves the account flat on a leg-two rejection, silently, with the new leg
unstopped), F-L5-07 (no parent link for any child event — the H1 trigger, and
the reason the record used to size risk is incomplete by construction),
F-L7-04 / F-L7-06 (one resettable credential path guards every money-moving
route), F-L1-09 / F-L2-04 (regime read with no age bound), F-L7-03 (model
output closes positions with no deterministic second gate).
