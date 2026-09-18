# Owner principles → build plan (11-09-2026)

> **STATUS (12-09-2026 07:3x SGT): the programme is COMPLETE — all eight PRs
> (A → B → C → E → D → G → F → H) are merged on `main` and deployed. §7 below
> is the per-PR record with merge commits and runtime read-back; §8 is how to
> resume from here (a fresh session, another agent or Codex) and what is still
> open on the owner's side. §1–§6 are left as written on 11-09-2026 so the
> decisions stay verbatim; the §4 headings carry a DONE marker only.

This document is self-contained: a fresh session, another agent or a person can
execute it from the repository alone. It records the owner's nine standing
principles (stated 11-09-2026 ~20:10 SGT, after P6b #894 merged), what in the
code contradicts each one (measured by three independent read-only
investigators, file:line), the owner's four decisions (asked and answered the
same evening), and the change order as eight PRs with scope, tests, mutation
checks and verification. Rules that bind every PR are at the end.

## 1. The principles (owner, verbatim in substance)

| # | Principle |
|---|-----------|
| 1 | The bot does not distinguish demo from live accounts. An account is only "how much is inside it". |
| 2 | Prioritise for opportunities. The tick-based switch (vs time-based) is on/off per account BY A HUMAN and AUTOMATICALLY by the bot. |
| 3 | Codebase-built blockages are addressed, not carried. |
| 4 | "Unknown" must not happen after four weeks of trading. Every trade has a reason. |
| 5 | The `.md` plans are checked (kept audited against the code). |
| 6 | The website shows no fake result. UI switches are logic-built, not for show. |
| 7 | Vetoes are part of what is minimised. |
| 8 | Trade direction is key for trending / momentum trading. |
| 9 | Restricted trading for certain accounts is removed. Setups are for all accounts and not hardcoded. |

## 2. Owner decisions (11-09-2026 ~20:25 SGT)

| Decision | Answer |
|----------|--------|
| PR-B: remove every demo/live behavioural gate — a live account is eligible for tick entries and app arming on the same evidence bar as demo | **Yes, no distinction.** Only routing (host, credentials, which sidecar) keeps `is_live`. |
| PR-C: one balance-derived position cap counting every held position | **Keep as is.** `maxOpenPositions` 5 and the book's 8 stay; adopted/manual/book positions keep counting. PR-C ships only the dedupe, the NULL-account leak fix, the pre-filter move, the skip reclassification, the bad_rr prefilter and the veto goal. |
| PR-D: shorts on the momentum book under the 9/10 conviction floor with regime-gate alignment | **Yes.** |
| PR-H: validation thresholds (all null today) | **Use the proposed defaults** (§4 PR-H). |

## 3. Measured contradictions (read-only, 11-09-2026, HEAD `ffd3f3a`)

### 3.1 Principles 1 and 9 — demo/live gates and hardcoded accounts

The C++ sidecar has **no** demo/live behavioural branch; every gate is on the
Node side. Routing stays; behaviour gates go.

Behavioural gates (class b) to remove:

| file:line | condition | replacement |
|---|---|---|
| `agent/services/entry-mode.js:112` | `tick_live_refused` — TICK_MOMENTUM only on demo | drop; readiness is the only gate |
| `agent/services/tick-permits.js:111` + `agent/services/exec-guard-sync.js:164` | `is_live === 1` struck from the tick-entry roster (paired — change both in one commit) | mode + readiness only |
| `agent/services/tick-readiness.js:91`, `agent/lib/entry-contracts.js:288`, `agent/services/tick-validation.js:206, 210-214` | two-tier evidence ladder: `DEMO_PASSED` only on demo, `LIVE_APPROVED` only by typed word | one bar for every account: `validationStage ≥ SHADOW_PASSED`; rename `DEMO_PASSED` to an environment-neutral traded stage judged on the account's own closed tick trades in R |
| `agent/services/earned-floor.js:42, 122, 138, 368` | `demoOnly: true`; the shrinkage prior admits only on demo | delete `demoOnly`; scope by evidence (`minSample`, rolling window, `minE`) — this is the widest split: live accounts are locked to the blanket 3.0R floor |
| `agent/services/stage-matrix.js:430` (+ `adaptive-breaker.js:118`, `edge-watchdog.js:165`) | `exemptHandPinnedDemo` — a pin survives a disarm on demo only | the exemption holds an explicit owner pin on every account |
| `agent/services/config-controller.js:344, 352` (+ `agent/loop.js:5297`) | `includeLive: false` | remove the flag |
| `agent/services/strategy-autopilot.js:775` | `isLive && !allowLive` → suggest-only | remove the term |
| `agent/services/account-capabilities.js:391-398` | `liveEntryRefusal` / `confirmLive` | remove; if a first-entry confirm is ever wanted it keys on stamped balance |
| `src/components/AccountPhaseSwitches.jsx:404`, `src/components/AccountSwitcher.jsx:88-121`, `src/pages/Connect.jsx:161-167` | greyed mode dropdown; "Type LIVE" prompts | enable the dropdown; one confirm for every account or none |
| `agent/services/managed-exit.js:165` | `demoOnly` option (inert) | delete so it cannot come back |

Hardcoded account ids that restrict:

| file | restriction | replacement |
|---|---|---|
| `agent/config/momentum-account.json` (`risk.js:1120-1123`, `evidence-gate.js:95`, `momentum-book.js:249`) | one momentum account; `exclusive` vetoes every other strategy there | the momentum pass runs on EVERY enabled account, sized from each account's own vol-target budget (`riskBudgetUsd`, `accountMarginPool`); delete `exclusive` and the `momentum_account_only` veto |
| `agent/config/tick-observation.json` | one account records → every other fails `observation_active` | `_all: RECORD`; disk reserve and `TICK_SPOOL_PATH` are the only limiters |
| `agent/config/strategy-pins.json` | five ids; two live ids and any new account get no pins → cold-start lockout at the evidence gate (`evidence-gate.js:99-106`) | one all-accounts list, or the pooled-evidence prior already implemented in `earned-floor.js` |
| `agent/config/account-horizons.json` | mechanism only; currently empty | keep the mechanism, keep it empty |

Reporting defect: `agent/services/account-registry.js:177` returns the FIRST
enabled row's id under a field named `enabled`; `agent/index.js:321` prints it
as `enabled=<one id>`. All seven rows measured `enabled = 1`. Fixed in PR-A.

Routing to keep (class a): `ctrader-creds.js:44,55`, `loop.js` host choices and
same-side fan-outs, `heartbeat.js` side routing, `tick-readiness.js:27 sideFor`,
`tick-validation.js:172`, `tick-shadow.js:23,135`, `account-equity.js` cross-side
sweep, `exec-engine.js` rosters, `main.cpp:192` recorder header stamp.

### 3.2 Principle 7 — vetoes

- `evaluateTrade` (`agent/services/risk.js`) writes one `risk_events` row per
  (symbol × account × cycle) with no dedupe: ~36k evaluations/day. Production
  11-09: considered 12,307, reached gate 10,593, approved 13, vetoed 10,580;
  `max_positions` 9,915, `bad_rr` 418.
- `max_positions` (`risk.js:1426-1440`) is per account but leaky: `OR
  mp.account_id IS NULL` counts legacy rows against every account.
- Eight cycle-level guards sit at the gate although their inputs are
  per-account and cycle-stable: `max_positions`, `daily_loss_limit_hit`,
  campaign stop, `unknown_daily_pnl`, `loss_streak_cooldown`,
  `balance_not_account_scoped`, `overexposed_*`, `correlated_*`. The pre-gate
  block at `agent/loop.js:1345-1419` (margin pool, fundable universe, horizon,
  phases) writes `decision_log` skips — the model.
- `regime_block` (`loop.js:1217-1221`) and `evidence_gate` (`loop.js:375-389`)
  are written as risk_event vetoes, not skips.
- `bad_rr`: `agent/lib/strategy-prefilter-rr.js` exists and is not catching them.
- Vetoes are counted in four places (`decision-audit.js:245`, `journal.js:40-90`,
  `veto-breakdown.js`, `decision_audit_history`) and targeted in none; the goal
  table's only pipeline goal divides by approvals (`goal-table.js:147`).
- `risk_events.opportunity_key` is stamped (`risk.js:2126`) and used only for
  reporting (`opportunity-funnel.js:49`).

### 3.3 Principle 8 — direction

- `momentum-book.js:103,157,178` and `momentum-account.js:283,294,309` are
  literal long-only (`consensus_bias: 'long'`, SQL literal `'long'`).
- The 1.5× short-conviction rule lives only in `momentum-shadow.js:87-89`
  (9/10), where nothing is placed; shadow short rows are discarded at
  `momentum-book.js:157`.
- `agent/lib/tick-strategy.js:163-165` / `cpp-exec/src/tick_strategy.cpp:174-176`
  are symmetric with no higher-timeframe trend input.
- `agent/services/regime-gate.js:127-144` enforces trend alignment for
  mean-reversion only; the trend/breakout branch never reads `trend_direction`,
  though `regimes.trend_direction` is computed every ~30 min for every scanned
  symbol (`loop.js:4771`).
- Five of twelve scan strategies carry a private trend filter (ema_pullback,
  vwap_trend, rsi2_reversion, cup_handle …); donchian_breakout, va_breakout and
  fvg_retrace carry none.
- No entry carries a direction reason; `loop.js:1238` lets a watchlist
  `override_bias` flip direction with no reason recorded.

### 3.4 Principle 2 — the switch

- A complete HUMAN per-account switch exists: `POST /actions/entry-mode`
  (`agent/routes/actions.js:1102-1168`, `requestEntryMode` with
  `expectedRevision`, the sidecar ack protocol, the drain, an `action_log` row
  with an `actor` field that has only ever been `'owner'`); UI
  `src/components/EngineStatusPanel.jsx:75-77` with the "Tick momentum"
  button hardcoded `disabled` and a stale tooltip.
- `agent/loop.js` neither reads nor writes the mode: **no automatic path**.
  The automatic de-escalation exists for PERMITS only
  (`tick-permits.js:198-207` PAUSE_CHECKS).
- Readiness on the recording account fails on `validation_stage`,
  `profile_pinned`, `replay_evidence` — all downstream of
  `agent/config/tick-validation.json` being ALL NULL (`thresholds_unset`
  makes REPLAY_PASSED and SHADOW_PASSED unreachable on every account).
  Horizon is NOT a blocker (cleared 09-09).

### 3.5 Principles 4 and 6 — unknowns, reasons, the website

- Decorative UI: `src/cockpit/TradeCockpit.jsx:311,313` Manage/Close with no
  `onClick` (the red Close claims "queues for next open" — false); `:174` a
  hard-coded "opens in 4h 23m" countdown that animates; `:717` fleet chips
  `role=button`, no handler, tooltip "(mock)"; `src/cockpit/cockpit-data.js:638`
  chart + volume profile synthetic even under a REAL position (`DEMO_FLEET`,
  `'0002.HK'` fallbacks); `PositionManager.jsx:230` / `OrderManager.jsx:101`
  permanently-disabled Modify as the dominant button; `PositionManager.jsx:113-118`
  pip defaults 10/15/3 shown as the position's settings when no guard exists.
- Half-wired: `src/pages/Tune.jsx:3759-3761` RSI/VWAP/FVG confluence filters are
  honoured by the manual routes only — `agent/loop.js` never reads them;
  `Tune.jsx:3458,3488` arm-benchmarks writes a key nothing reads.
  **CORRECTION (PR-F, 11-09-2026, measured):** both claims are wrong at HEAD.
  The loop reads the three switches via `scanFilterOptions` (`loop.js:3511`)
  → `runFibScan` annotate mode → `signal.filters_failed` → `tradeStageGate`
  (`loop.js:1424`); the chain was real but unpinned, and is now pinned by
  `agent/loop-confluence-filters.test.js`. `arm_benchmarks_json` is read by
  `GET /state/arm-benchmarks`; what was missing was a page reading it, which
  Tune now does. See `docs/plan-execution-audit-2026-09-11.md` §8.
- `docs/ui-control-inventory.md` is stale (pinned to `16defbd`).
- `entry_intents` UNKNOWN has no deal-history resolver (`broker_deals`
  unreferenced in `entry-ledger.js`) and no operator UI (`/actions/entry-intents/:id/resolve`,
  `/state/entry-intents` appear nowhere in `src/`), while one UNKNOWN holds an
  account out of its requested mode (`entry-mode.js:186-192`).
- `/actions/manual-order` (`actions.js:5608`, the order pad's only live entry
  button) writes no `strategy`, no `risk_event_id`, no `trade_plans` row — the
  sole entry path without a plan. `pending-orders.js:195,226,236` hard-codes
  `strategy = 'fib_618_fade'` though `pending_orders.strategy` exists.
  `trades.origin` is NULL on ~93 % of history with the backfill route built
  (`/actions/backfill-trade-origin`) and no button. Close reasons are all
  written (`closeTradeRow`), but `'already_closed'` / `'closed at the broker'`
  score `exit_matched = 0` and are never surfaced. External positions never get
  a strategy by design → the invariant is scoped to `CLEAN_BOT_ORIGINS`.
- Twelve attribution endpoints are served and read by no page:
  `/state/entry-intents`, `trade-plans`, `unknown-pnl`, `unresolvable-plan`,
  `trade-consistency`, `attribution`, `refusal-cost`, `exit-counterfactual`,
  `exit-price-suspects`, `open-duplicates`, `go-live-readiness`, `phase-audit`.

## 4. The change order

Each PR: its own branch from `main`, the standing gate, mutation checks
(present-before / absent-after / red / restored green), an independent checker
on the diff, register/README rows where the tick programme is touched, the
CLAUDE.md ledger write-back. Order: **A → B → C → E → D → G → F → H**. H's
config may land any time (numbers given); G's auto switch cannot fire until H
and the replay/shadow evidence exist.

### PR-A — Principles into CLAUDE.md; the boot line tells the truth — **DONE #895 (bcd3a45)**
- `CLAUDE.md`: a new owner-confirmed section "Owner principles (11-09-2026)"
  with the nine principles and the four decisions. Owner-confirmed text is the
  last thing a tidying pass may drop.
- `agent/services/account-registry.js ensureAccountRegistry` returns
  `{ total, enabledCount, enabledIds }`; `agent/index.js:321` prints
  `N account(s), M enabled (…last4, …)`. Test: three rows, two enabled → the
  count and both last-4s in the line; the old single-id field gone.
- This document committed.

### PR-B — One account model (principles 1, 9) — **DONE #897 (ad8d445)**
- Remove every class-(b) gate in §3.1 and replace the four hardcoded configs as
  listed. Momentum pass per enabled account: `momentum-account.json
  accountId: null` means all; sizing from each account's own budget; delete
  `exclusive` and the `momentum_account_only` veto. `tick-observation.json`
  `{"_all": "RECORD"}`. `strategy-pins.json` `{"_all": [...]}`.
- One evidence bar: `validationStage ≥ SHADOW_PASSED` for every account;
  `DEMO_PASSED` → `TRADED_PASSED` (judged on the account's own closed tick
  trades in R); `LIVE_APPROVED` collapses into it.
- Invariant test `agent/lib/one-account-model.test.js`: greps `agent/` and
  `src/` for `is_live`, `isLive`, `environment ===`, `'demo'`, `'live'`,
  `LIVE_APPROVED`, `demoOnly` outside an explicit allowlist of plumbing files
  (§3.1 routing list) and display badges; fails on any new occurrence.
- Tests per removed gate (each red when the gate is restored): live account
  requests TICK_MOMENTUM and is refused ONLY by readiness; the feeder lists a
  live account in TICK_MOMENTUM; the earned floor admits on a live row; a pinned
  strategy is held on live under the watchdog; config-controller proposes for a
  live account; the momentum pass runs on two accounts sized differently by
  balance; an unlisted account gets pins / observation.
- UI: dropdown enabled for every row; the three prompts become one neutral
  confirm.

### PR-C — Vetoes minimised (principle 7) — cap unchanged per the owner — **DONE #896 (37ebcd9)**
- Move the eight cycle-level guards into the `loop.js:1345-1419` pre-filter as
  `decision_log` skips; keep them in `evaluateTrade` as the backstop (the
  `checkSymbolCap` doctrine at `risk.js:1462-1470`).
- `persistRiskEvent` (`risk.js:2110`): when (opportunity_key, reason head via
  `veto-breakdown.js reasonKey`) is unchanged since the last row, increment
  `repeat_count` (new column) instead of inserting.
- Drop `OR mp.account_id IS NULL` at `risk.js:1433` (scope like
  `symbolCooldownMinutes`). No change to `maxOpenPositions` or the book's cap.
- `regime_block` and `evidence_gate` written as skips.
- `bad_rr`: make `strategy-prefilter-rr.js` catch the 418 (measure which
  strategies produce them; add their floors).
- `goal-table.js`: `vetoRate = vetoed / reachedGate` and
  `wasteRate = (vetoed − distinct opportunities vetoed) / vetoed` with
  `vetoRateMax` and `vetoMinReachedGate` in `DEFAULT_GOAL_TARGETS`; on the daily
  report (`journal.js`).
- Tests: a skip is written and no veto for a full account; repeat rows collapse
  with the count; the leak test (a NULL-account row does not cap another
  account); the goal reads off_track at 99.9 %.

### PR-E — Every trade has a reason; no UNKNOWN (principle 4) — **DONE #898 (bcdca71)**
- `/actions/manual-order`: `strategy`, `risk_event_id` and a `recordTradePlan`
  row like `/actions/execute-trade`.
- `pending-orders.js`: read `pending_orders.strategy`; the literal goes.
- `entry-ledger.js`: a deal-history resolver (`broker_deals` by intent tag in
  the label, then by account/symbol/side/time window) on the reconcile pass;
  UNKNOWN older than N hours with no evidence → stays UNKNOWN but is listed.
- UI: an "Unknowns" block in `EngineStatusPanel` listing UNKNOWN intents with
  a resolve form (reason required) → `/actions/entry-intents/:id/resolve`;
  a button for `/actions/backfill-trade-origin`; run it once.
- Invariant (extend `agent/services/close-completeness.js`): for trades since
  a cutoff with `origin IN CLEAN_BOT_ORIGINS` — `origin ≠ 'unknown'`,
  `strategy IS NOT NULL`, a `trade_plans` row, `risk_event_id IS NOT NULL`,
  closed → `close_reason` and a scored plan; `entry_intents`: no UNKNOWN older
  than N hours. On the goal table and the daily report. Non-attributive close
  reasons surfaced with their count.
- Tests: manual-order writes a plan (red when removed); the resolver settles a
  FILLED and a REJECTED from deals; the invariant reads 0 on a clean fixture and
  names each violation on a dirty one.

### PR-D — Direction is a stated reason (principle 8) — **DONE #899 (8eb4e75)**
- `direction_reason` on every synth/proposal, stored in `proposal_json`, set at
  each strategy's bias assignment (`donchian-breakout.js:52`, `vwap-trend.js:63`,
  `rsi2-reversion.js:74`, `momentum-book.js:103`, `momentum-account.js:309`,
  `tick-strategy.js:165`), plus `trend_direction` recorded at evaluation.
- `regime-gate.js:139-144`: the trend/breakout branch blocks trend-vs-trend
  (a trend signal against `trend_direction` in a trending regime), symmetric
  with the mean-reversion branch.
- One shared direction policy (`agent/services/direction-policy.js`) with
  `shortMinConviction` lifted from `momentum-shadow.js:87-89`; the book and the
  vol-target account become two-sided under the 9/10 floor; `tick-permits.js`
  withholds the against-trend side's permit.
- `loop.js:1238` `override_bias` must carry a reason or is refused.
- Quant researcher makes it; Statistics auditor checks the short evidence
  before the book's first short (shadow rows exist since #831).
- Tests: every proposal in a fixture cycle carries `direction_reason`; a
  donchian short in a trending-up regime is blocked; a book short with
  conviction 8 is refused, 9 admitted; the against-trend permit is absent.

### PR-G — The switch: human AND automatic (principle 2) — **DONE #900 (2c84d8a)**
- `entryModePolicy: 'manual' | 'auto'` in the `EngineStatus` contract
  (`agent/lib/entry-contracts.js`, default `manual`), seeded from
  `agent/config/entry-mode-policy.json` on the `tick-observation.json` pattern,
  exposed by `entryEnginesView`; `requestEntryMode` refuses `actor: 'auto:*'`
  on a `manual` account.
- A loop pass on the quant cadence (`loop.js:4745`) for `auto` accounts:
  promote to TICK_MOMENTUM after N consecutive ready cycles (`tickReadinessFor`
  + `validationStage ≥ SHADOW_PASSED`) — and, "prioritise for opportunities",
  only when the tick path's recent opportunity (signals taken in shadow over
  the window) exceeds the time-based path's (approvals over the same window,
  from PR-C's goal terms); demote to TIME_BASED on one failing cycle
  (immediate); always via `requestEntryMode(…, { actor: 'auto:readiness',
  readiness: tickReadinessFor })`.
- UI: the Tick momentum button gated on the live readiness predicate with the
  blocker list (the hardcoded `disabled` goes); a per-account policy switch.
- Tests: promotion after N clean cycles writes an `action_log` row with the
  auto actor; a failing check demotes within one cycle; a manual account is
  never touched; hysteresis prevents a flip-flop on alternating cycles.

### PR-F — Nothing fake on the website (principle 6) — **DONE #901 (fb94da1)**
- `TradeCockpit`: Manage/Close wired to the position routes (or removed); the
  countdown replaced by the symbol-hours source (`agent/lib/symbol-hours.js`)
  or removed; synthetic chart/VP never rendered under a real position — real
  data or an honest empty state; fleet chips removed.
- `PositionManager` / `OrderManager`: Modify removed until built; pip fields
  empty until the guard is read.
- `Tune`: the confluence filters honoured by `agent/loop.js` (or the switch
  removed); arm-benchmarks read by the loop or removed.
- A "Reasons" page reading the twelve attribution endpoints.
- `docs/ui-control-inventory.md` re-derived from HEAD and pinned by a test
  that every listed control maps to a route the backend reads and a read-back.
- `npm run audit:ui` with a bound position fixture (the audit today renders
  with no agent — CLAUDE.md failure mode #3).

### PR-H — Blockages cleared (principle 3) — **DONE #902 (dca96a9)**
- `agent/config/tick-validation.json` thresholds (owner-approved defaults):
  `replay { minTrades: 40, minProfitFactor: 1.3, maxDrawdownR: 8, minExpectancyLowerR: 0 }`,
  `shadow { minSignals: 200, minHours: 48, minTrades: 30, minLosses: 8, minProfitFactor: 1.3, minExpectancyLowerR: 0, maxDrawdownR: 8, maxResetSharePct: 20 }`,
  `traded` (ex-demo) `{ minTrades: 30, minProfitFactor: 1.3, maxDrawdownR: 8 }`.
- Then, in order: `scripts/tick-research.mjs` over the sealed segments →
  `POST /actions/tick-trials`; `POST /actions/tick-validation {stage:
  REPLAY_PASSED}` (pins the profile); the recording account RECORD → SHADOW
  held unbroken for the shadow window; `SHADOW_PASSED`; PR-G's rule promotes.
- Named owner-side blockages that remain: the bearer token (state routes 401),
  the three symbols unresolvable on demo (SPX500, USOIL, UKOIL).

### Standing — principle 5
After each PR above, the Release auditor re-runs the whole-plan check on the
diff; register rows change in the same PR; `docs/plan-execution-audit-2026-09-11.md`
gets a dated follow-up section rather than a new file.

## 5. Verification (whole plan)
- PR-A: boot line prints the count; the invariant test suite is green.
- PR-B: the one-account-model test green; `requestEntryMode(TICK_MOMENTUM)` on
  a live id refused only by readiness; two accounts run the momentum pass sized
  by balance.
- PR-C: after deploy `reachedGate` falls to the hundreds; `vetoRate` on the goal
  table with a target; repeat rows collapse.
- PR-E: the invariant reads 0 violations for trades since the cutoff; no UNKNOWN
  older than N h; the manual-order path writes a plan.
- PR-D: every `proposal_json` since deploy carries `direction_reason`; a
  trend-vs-trend block appears in `decision_log` (skip) on the book's path
  (stage `regime_gate`) and on the scan path once PR-C's `recordRegimeBlock`
  carries it; a short on the book only ever with a fresh down-trend reading.
- PR-G: an `auto` account is promoted after N ready cycles (action_log actor
  `auto:readiness`) and demoted on a failing check within one cycle.
- PR-F: `npm run audit:ui` and the inventory test green; the cockpit shows no
  synthetic panel under a real position.
- PR-H: `SHADOW_PASSED` reachable; the readiness view reads `ready: true` on
  the recording account once the evidence chain completes.

## 6. Rules that bind every PR (from CLAUDE.md)
- Full gate: `shopt -s globstar; node --test agent/**/*.test.js`, `npx eslint .`,
  `npx vitest run`, `npm run build`, `npm run check:no-green`, and for sidecar
  changes `make -C cpp-exec CXX=g++ test` and `make -C cpp-exec CXX=g++ tsan`;
  CI green and `mergeable_state: clean`; then undraft, squash-merge,
  unsubscribe, restart the branch on main, read back the deploy from the
  Railway logs and the public `/health`.
- Mutation checks count the target present before and absent after; restore
  with `touch`; never edit C++ while a build runs in that tree.
- A maker never certifies its own work: an independent checker (Race checker,
  Statistics auditor, Release auditor, Account/UI maker as named) reviews the
  diff before the PR.
- Risk limits, Railway variables and live-account operations are ask-first
  (P7); the four decisions in §2 are already given.
- Never print full 8-digit account ids; never a model identifier in a commit,
  PR, comment or code.
- Every text reply carries the serial (`№ N · DD-MM'YY HH:MM SGT`); the count
  is by replies made, written back to CLAUDE.md with each PR.

## 7. Execution status (12-09-2026, written after #902 merged)

Every PR below went through: an independent checker on the diff (a maker never
certifies its own work), the maker's fix round, the standing gate in a
worktree, a cherry-pick onto the working branch, the merged-tree gate, CI,
squash-merge, a branch restart on `main`, and a read-back of the deploy from
the Railway logs. Merge commits match `git log origin/main`.

| PR | Principle | Number · merge commit · merged (UTC 11-09) | Checker findings fixed before the PR | Runtime read-back (log evidence) |
|---|---|---|---|---|
| PR-A | ledger + boot line | #895 · `bcd3a45` · ~12:40 | one stale assertion (CI red once, fixed) | boot line `account registry: 7 account(s), 7 enabled (…3489, …2148, …9009, …7342, …0058, …9908, …0949)` |
| PR-B | 1, 9 — one account model | #897 · `ad8d445` · ~14:20 | 3 majors, 3 minors (pin exemption yields to an account's OWN streak/no-edge; daily pass applies margin/fundable rules; regex invariant with exact per-file counts; legacy cursor migrated) | pins `77 unchanged, 7 held`; momentum account `…_all`; tick observation 7 accounts; guard sync 53 ids both sides |
| PR-C | 7 — vetoes minimised | #896 · `37ebcd9` · ~13:45 | goal-table count 12→13 (gate red once, fixed) | health ok on 37ebcd9; regime/evidence skips as `decision_log` rows |
| PR-E | 4 — every trade has a reason, no UNKNOWN | #898 · `bcdca71` · 14:41 | 1 blocker (a truncated 500-row deal pull would have REJECTED an intent whose position exists), 4 majors, 5 minors | per-account reconcile passes on every account (`Reconcile[…7342/…0058/…9908]`); no UNKNOWN intent rows exist to settle |
| PR-D | 8 — direction is a stated reason | #899 · `8eb4e75` · 15:03 | 1 blocker (a flip in one batch dropped the exit), 3 majors, 9 minors | both sidecars booted, tick profile hash unchanged (`967c1defd6e78d09`); `Regime gate: CVX.US blocked — regime_block fade-vs-trend (fib_confluence)` on the scan path |
| PR-G | 2 — the switch: human AND automatic | #900 · `2c84d8a` · 15:11 | 2 blockers (the bot undid a human's TIME_BASED within one cycle; the streak grew while STOPPED), 4 majors, 4 minors | boot `entry-mode policy: 0 applied, 7 unchanged` (every account seeds `manual`) |
| PR-F | 6 — nothing fake on the website | #901 · `fb94da1` · 15:22 | 1 blocker (SPD/VSI/HDG still animated from sine waves under a real position), 4 majors, 2 minors; then the one-account invariant caught the chart's demo/live words (renamed synthetic/served) | boot on fb94da1, frontend served; inventory WIRED 119 · HALF 0 · DECORATIVE 0 |
| PR-H | 3 — blockages cleared | #902 · `dca96a9` · 16:09 (undrafted and merged by the owner) | 3 majors (the research route ran the grid synchronously on the keeper's loop — 48.8 s measured; a quadratic repeat handler; the replay bar passable on a 0-trade test block), 3 minors | `tick observation` SHADOW applied at the deploy boot; demo recorder RECORDING (723,667 events, 0 dropped, 1 gap, 48.76 GB free); **the shadow portfolio now closes trades** (`shadow portfolio: 1 closed trade(s) recorded (ledger seq 28 → 35)` through the evening) |

What the merged tree measures (merged-tree gate on #902): Node 4,240 pass /
0 fail, eslint clean, vitest 892, build, `check:no-green`. C++ suite + TSan ran
on #899 (the only PR of the eight that touched `cpp-exec/`).

Follow-up sections in `docs/plan-execution-audit-2026-09-11.md`: §7 (PR-C,
PR-B), §8 (PR-E), §9 (PR-D), §10 (PR-G), §11 (PR-F), §12 (PR-H). The
tick-programme rows touched are in `docs/tick-momentum/README.md` and
`readiness-register.csv`.

## 8. How to resume from here (a fresh session, another agent, or Codex)

Nothing in this plan is left to build. What remains is on the owner's side or
is a named follow-up; none of it should be started silently.

**Owner-side items (ask-first, each needs the owner's word or hand):**
1. The bearer token for the state routes (they answer 401): every read-back so
   far is log-derived; `/state/tick-readiness`, `/state/entry-intents`,
   `/state/perf-ledger`, the Reasons page all need it.
2. `replay.minTestTrades: 10` in `agent/config/tick-validation.json` — the
   PR-H checker's addition (a sample floor on the test block; it only tightens
   the owner's bar). Confirm the number or replace it.
3. P6c — the tick switch-on is an explicit typed order naming the account
   (`POST /actions/entry-mode {TICK_MOMENTUM}` from the engine panel, or
   `entryModePolicy: auto` and PR-G's rule). Readiness is still short of it:
   `validationStage` needs `REPLAY_PASSED` (a replay trial over the sealed
   segments) then `SHADOW_PASSED` (the shadow window: 200 signals / 48 h / 30
   closed shadow trades …). The shadow portfolio started closing trades on
   11-09 evening; the replay trial cannot run yet (item 4).
4. Replay research needs the sealed segments: they live on the demo sidecar's
   volume (`/data/tick` on cpp-exec), not on the Node service. Either set
   `TICK_SEGMENTS_DIR` where Node can read them (a Railway change) or build
   the next C++ step described in the audit's §12.3 (a segment list/download
   endpoint on the sidecar). Until then `POST /actions/tick-research` answers
   409 `no_segments` — honest, not a fake trial.
5. `TICK_SPOOL_PATH` on the live sidecar (cpp-acct has no volume): without it
   the live side builds no tick workers, so SHADOW is inert there and five
   readiness checks can never pass on a live account (audit §12.2). A volume +
   the variable is an infrastructure change.
6. The three symbols unresolvable on demo (SPX500, USOIL, UKOIL): the guard
   sync logs `not resolvable on this side (no id) — not carried` every push.
7. Task #6 (close the XRPUSD pair, cancel the MSFT.US limits) still waits on
   the token and the owner.
8. `RESIDUAL_GATES` in `agent/lib/one-account-model.test.js`: the two
   test-order refusals on a live selection (`/actions/validation-fill`,
   `scripts/exec-parity.js --order`) — keep or remove is the owner's call.
9. `getAccountBalance` in `agent/services/risk.js` sizes on the global
   balance when the scoped key is ≤ 0 (named in #891, a sizing change, not
   made).

**Follow-ups the checkers flagged (small PRs, no owner decision needed, but
say so before building):**
- `importTickTrial` checks key presence only — a hand-posted trial can pin
  `REPLAY_PASSED`; add a `source` and a recompute of the summary from the
  blocks (audit §12.3a).
- A withheld test block still counts in the summary totals; `sim.includeTest`
  passes straight through (audit §12.3a).
- Readiness's own side naming (`cpp_exec_demo` vs the heartbeat's `cpp_exec`
  on a collapsed deployment) — one vocabulary (audit §10).
- The cockpit bars fetch on a non-primary account is a permanent
  "bars unavailable" empty state (audit §11.1).
- Principle 5's standing re-audit: run the Release auditor over the whole
  plan set again now that all eight PRs are in, and fold the register rows.

**Rules that still bind (unchanged, §6):** the standing gate, the checker on
every diff, the mutation counts, the CLAUDE.md serial ledger written back with
each PR, last-4 account ids only, no model identifiers, P7 for anything
external. The working branch is `claude/handover-outstanding-file-1ktjs7`,
restarted on `main` after every squash-merge.

## 9. Checkpoint — 18-09-2026 18:02 SGT (owner: "list the work to be done so we know as a checkpoint")

Written so a fresh session, another agent or Codex can pick up without this
conversation. Main was `8fbb437` at the checkpoint; the branch is
`claude/handover-outstanding-file-1ktjs7`, restarted on `main` after every
squash-merge.

### 9.1 Done 16–18 Sep (merged and deployed, each read back from the Railway log)

| PR | What | Read-back |
|---|---|---|
| #943 PR-AU | re-verify cap gives back attempts spent against a verifier that could not answer | armed backlog non-zero |
| #944 PR-AV | the book's trail writes ATR + a note on every pass it reaches | `trailNote` on every open row |
| #945 PR-AW | cpp-verify: money by `moneyDigits`, timestamps ±1 s, volume as a double (contract 2) | 10 unit-only disputes cleared |
| #946 PR-AX | `exit_sent` book rows whose trade closed are reclassified | `N exit_sent row(s) reclassified closed` |
| #947 PR-AY | a verdict carries its contract version; stale disputes are re-asked once | 8 disputed re-asked under contract 2 |
| #948 PR-AZ | terminal is closed / rejected / cancelled, not `closed` alone | — |
| #949 | **fix the exits**: reconciler attributes bot closes from `position_events` / the book's `exit_sent`; a winner whose stop already sits past breakeven is HELD at its cap (`time_cap_held`), not closed; verifier compares volume in lots via `lotSize` (contract 3) | first `verified` record ever (XPTUSD); 0 new closes yet |
| #950 | keeper `armR 0.5`: the arm never fires before +0.5R of the position's own risk, both modes | `/state/profit-keeper armR: 0.5`; first arm decision not yet printed |
| #951 | keeper truth: the record carries the broker's fill volume + fill time; `reconcileTradePricesToBroker` writes both back to `trades` | `corrected 633 close time(s) and 260 fill volume(s)`; all 60 records rebuilt → unverified |

### 9.2 Built after the checkpoint on the owner's "build B·1 to B·6" (this PR + the next)

- **B1** — the re-verify cap counts asks of ONE record: `position_history.rebuilt_at`
  is stamped when a rebuild moves the watched figures; a record rebuilt after
  its last ask is eligible past the cap and its count restarts at 1. The
  migration backfills the 18 …0949 records #951's boot rebuild reset.
- **B3** — the trail loop retires an OPEN book row on all three terminal trade
  states (`BOOK_TERMINAL_TRADE_STATES`), the brake's `OPEN_ROWS_SQL` agrees.
- **B4** — `opposing_leg_cross_account`: an opposite-side position on the same
  symbol on another account vetoes the entry; `allowCrossAccountHedge: true`
  admits it deliberately.
- **B5** — `getAccountBalance(db, accountId)` for a NAMED account reads only its
  own key: a stamped 0 is a reading, an absent stamp is null, never the shared
  global. `sizingBalance` treats a stamped 0 as the account's own.
- **B6** — the verifier drain reads an unknown symbol's `lotSize` from the
  broker once (`lotSizeFor`), remembers it, and sends it; a failed read sends
  nothing.
- **B2** (separate PR, C++ + Node) — the live sidecar's `/health` reports the
  accounts the token was REFUSED for; the heartbeat treats tried-and-refused
  as not-drift (one warning on change, not an error every 2 minutes); the
  registry names them unauthorised.

### 9.3 Open on the owner's side (unchanged from §8, restated)

1. Task #6: close the two XRPUSD demo positions, cancel the MSFT.US limits.
2. P6c: the tick switch-on on a named account (typed order) → P6d 24 h soak.
3. SPX500 / USOIL / UKOIL unresolvable on the demo side; `TICK_SPOOL_PATH` on
   the live sidecar (Railway variable).
4. The bearer token for the state routes (read-backs are log-derived without it).

### 9.4 Read-backs still owed (watching, no action)

- First `<source>: <reason>` close and first `time_cap_held` under #949; first
  keeper arm line under `armR 0.5`; the 60 records' re-verdicts under contract
  3 with the corrected figures (18 of them only after B1 lands).
- Test-fixture temp-dir leak (57k dirs filled the container disk four times)
  — a scripts/test hygiene PR, no production effect.
