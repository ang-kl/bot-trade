# Profit at scale — research plan and discipline (16 October 2026)

Claude · № 15,152 16-Oct (owner, after § 15,128: "Next, plan research, discipline how to maximise opportunity with
larger profit returns in thousands than just in single dollar profit or in tens or in hundreds"; claude-builder).
A plan, not a policy: nothing here changes a strategy, a stop, a target, a lot, a risk limit or an account. Each step
names its data source, its instrument in the repo, and the decision it feeds. The owner picks which steps become code.

## 0. The arithmetic, measured

GROSS profit per month = Σ over trades of (R realised × gross risk per trade in the account's own currency); NET
profit per month = that sum − Σ (commission + swap) per trade. The two are not the same sign on this book: the USD
own stream reads +206 gross, −237 of costs, −31 net. Every cell ranking (steps 1 and 4) and every sizing scenario
(step 6) therefore uses NET R (`net_pnl ÷ gross risk`) or subtracts the modelled costs explicitly; a cell that is
gross-positive and net-negative is never promoted (Codex round 6). Both factors are
measured on the five accounts' 271 closed trades since 16 September (ledger export of 16-10 00:4xZ; `net_pnl` and
`realised_rr` from the broker's deals). **The bot's own stream is selected by `origin`** (Codex round 3):
`cleanBotOrigin()` in `agent/lib/trade-origin.js` — `bot_market_dispatch` (181) and `bot_pending_fill` (43), 224
trades — never by `source`, because `reconciler.js:811` stamps an adopted position `autopilot` when its label looks
like ours; the 47 others (23 reconciler-adopted, 22 manual, 2 unknown) are reported apart and never enter an
expectancy or a routing decision. **Money is never pooled across currencies** (Codex round 1): 42993489 and
43097342 are SGD accounts, 46130058, 46979908 and 47790949 USD accounts (the broker's asset list, read through
`depositCurrencies` on 16-10), so every money figure below is per currency; R is the only currency-free unit and
the only one pooled across all five.

| factor | measured | source |
|---|---|---|
| R per trade, own stream (224 trades) | mean −0.06R, median +0.01R; win rate 50 %; average win +0.61R, average loss −0.73R; profit factor in R 0.84 (all 271 incl. adopted/manual: mean −0.06R, PF 0.85) | `trades.realised_rr`, 222 own rows with R |
| trades ≥ 2R | 3 of 222 own (4 of 269 overall) | same |
| trades at the initial stop (≤ −0.9R) | 46 of 222 own (59 of 269 overall); 148 of 271 closes are broker stop fills | `trades.close_reason` |
| risk per trade, own stream, USD accounts (152 trades) | median 36 USD, quartiles 18–53, max 308 — GROSS basis: gross_pnl ÷ realised_rr on 143 rows with a usable R; costs (commission, swap) modelled apart: −237 USD over the 152 (net −31 USD, gross +206) | derived; per account below |
| risk per trade, own stream, SGD accounts (72 trades) | median 4.6 SGD, quartiles 3.3–5.3, max 20 (69 rows); costs −19 SGD over the 72 (net −35, gross −16) | derived; per account below |
| hold, own stream | median 2.4 h (4.1 h over all 271) | `trades.hold_duration_ms` |

The risk unit is derived on the GROSS basis (Codex round 3): `realisedRR` (`services/trade-consistency.js:72`) is the
price move over the original stop distance, while `net_pnl` is after commission and swap, so `net ÷ R` is not the
amount risked and a small R turns the cost into a spurious large "risk" (the earlier max of 1,011 was that artefact).
The exact unit — filled size × stop distance × the instrument's value per point — is step 1's to compute from the
ledger; gross ÷ R is the approximation used here and labelled so.

| account | currency | own n | own net (own currency) | own median gross risk | own ΣR | adopted + manual n / net |
|---|---|---|---|---|---|---|
| 42993489 (live) | SGD | 5 | 0 | 0.1 | 0.0 | 3 / +17 |
| 43097342 | SGD | 67 | −34 | 4.7 | −2.6 | 7 / +1,575 |
| 46130058 | USD | 91 | +90 | 35.0 | −9.6 | 8 / −226 |
| 46979908 | USD | 26 | −8 | 1.4 | −3.0 | 3 / −2 |
| 47790949 | USD | 35 | −113 | 92.4 | +2.1 | 26 / −1,664 |

Two readings follow directly. **The expectancy is zero or below**: at any size, more trades of the same stream add
noise, not profit. **The size is tens of dollars**: at a median 36 USD of gross risk on the USD accounts (4.6 SGD on
the SGD accounts), a trade that pays +1R pays 36 USD or 4.6 SGD — the "single dollars, tens, hundreds" the owner
describes is the risk unit, not the strategy. The largest single contributors are not the bot's own stream at all:
the adopted and manual trades net +1,593 SGD on the SGD accounts (one externally opened JPN225 long adopted by the
reconciler on 43097342, +1,602 SGD, 1.6R) and −1,892 USD on the USD accounts (NATGAS long adopted on 47790949,
−990 USD, among them); the bot's own NATGAS longs are −615 USD over 15 trades on the USD accounts and −2 SGD over
10 on the SGD accounts. The own stream itself nets −31 USD and −35 SGD over the 30 days.

Thousands a month needs both factors at once, in this order: a positive, proven R per trade first (e.g. +0.3R mean
over ≥ 30 trades of a cell, lower bound above zero), then a risk unit sized to the account (e.g. 1–2 % of a 10,000
USD account is 100–200 USD; the same rule in SGD on the SGD accounts). 0.3R × 150 USD × 60 trades a month ≈ 2,700
USD. 0 R × 36 USD × 150 trades = 0. The
second factor without the first multiplies losses by the same ratio — which is why size comes last below.

## 1. Decompose the P&L (where the money comes from and goes)

- **Data**: `trades` joined to `analyses` (strategy, timeframe, side, source, account), the broker class from the
  cached instrument tree (`agent/lib/asset-class.js`, `classOfSymbol` — #1390's deliverable, not on main until it merges; the only class reader on main today is the heuristic `categoriseSymbol` in `lib/sessions.js`, which maps 8 indices and is a fallback, not the source; Codex round 4), `realised_rr`, `net_pnl`, `commission`, `hold_duration_ms`,
  `close_reason`. Period: every closed trade since 16-09, then rolling 30 days.
- **Instrument**: a read-only route or report (the shape of `GET /state/performance-populations` and
  `/state/watchlist-stats`), one row per (class, strategy, side, account, source): n, ΣR gross AND net (`net_pnl ÷ gross risk`), mean net R, Σ money and median
  risk IN THAT ACCOUNT'S DEPOSIT CURRENCY (an account belongs to one currency, so a per-account row never mixes;
  class/strategy/side rollups are per currency, never summed across SGD and USD — Codex round 2), share of that
  money held by the top three trades, share of losses at the initial stop.
- **Output**: the cells where the bot's OWN stream — selected by `cleanBotOrigin(origin)`, never by `source`
  (Codex round 3) — is positive in R with n ≥ 10, and the cells where it loses; adopted/manual trades reported apart
  (they are the owner's, not the system's), `source` kept as a reporting dimension only. The risk unit per trade is
  computed exactly here: filled size × original stop distance × the instrument's value per point, in the account's
  currency; costs (commission, swap) as their own columns, never folded into the risk.
- **Decision it feeds**: which cells go into the class-routing policy (today's blocks rest on n 8–12), which cells
  the evidence gate should arm, and what "robust" means in numbers.

## 2. Exit counterfactuals (what the same entries would have paid)

- **Data**: the stored aftermath bars of every closed bot trade (`trade_postmortems.bars_json`, closed bars only
  since #1382), the entry, stop and target as sent. **Cohort reconciliation first** (Codex round 3):
  `replayablePopulation()` (`exit-counterfactual.js:78`) inner-joins `trade_postmortems`, and `runLossPostmortems()`
  writes no postmortem for a zero-net close, so the replay's `considered` count is not "every closed bot trade";
  the step reconciles the replay cohort against all clean closes (by `origin`), reports the closes without a window
  and resolves or labels them before any exit rule is selected. **Incomplete windows are excluded too** (Codex
  round 4): `runLossPostmortems()` caps its fetch at 400 bars (`loss-postmortem.js:562`) and knowingly keeps an old,
  long-held trade whose early holding period was clipped (the `bar window clipped` honesty guard at :593), while
  `replayablePopulation()` admits any non-empty `bars_json`; `replayExit()` then starts at the first remaining bar
  and can miss an earlier stop or target — a false counterfactual, not a missing window. The reconciliation
  checks that each window's first bar is at or before the entry (`bars[0].t <= opened_at + 2 × tf`) and either
  re-fetches the row from the entry or excludes it, counted as `clipped`, before any rule is scored.
- **Instrument**: the existing exit-replay engine (`GET /state/exit-counterfactual`, called with `?stop=initial`:
  the broker's first-held stop, `broker_sl_initial`, the denominator `realised_rr` uses; the route's default
  `stop=recorded` maps through `exit-counterfactual-extended.js stopOf()` to the proposal's `sl_price`, which after a
  re-anchored fill is the wrong stop and can turn a stop-out into a truncated trade — rows without `broker_sl_initial`
  take the route's documented fallback and are counted apart; Codex round 6; rules in
  `agent/config/research.json`: `trailR`, `tpR`, `followThroughR`, `exitAtMeanPeriod`, `maxDays`), the bootstrap
  lower bound (`tick-replay-sim expectancyLowerR`). **The exit replay has no holdout today** (Codex round 1):
  `trainFraction` lives under `barForm.validation` and only `bar-form-research-core.js` calls
  `trainConfirmSelection`; `exit-counterfactual-extended.js` reads `research.exitReplay` and scores its whole
  eligible population, so a rule selected and then "confirmed" on the same endpoint reuses its selection sample.
  Prerequisite for this step: a chronological split in the exit replay (select on the first 70 % of the span,
  confirm on the rest — NASA-6's rule applied to exits), or every exit figure labelled in-sample.
- **Output**: per robust cell, mean R and its lower bound under: the exit as traded, let-run to a fixed R target (2R,
  3R), a trail at kR, an exit at the SMA cross (`exitAtMeanPeriod` is an SMA-cross exit, `exitAtMean: {period}`,
  not a time stop), and — only once a separate replay rule exists for it — a holding-period time stop at the
  time stop derived per eligible cell from the TRAINING portion of its own clean replay (not the pooled 4.1 h median
  of all 271 trades, which includes the adopted/manual rows this plan excludes; the own stream's median is 2.4 h and
  each cell differs; Codex round 7). **Cost prerequisite** (Codex round 7, P1): `exit-counterfactual-extended.js`
  `COST_MODEL` carries no spread, slippage, commission or swap, so a rule that lengthens the hold, adds a partial or
  exits at another price can rank wrong on a book where costs already turn gross-positive into net-negative; before
  any rule is selected the replay must price each counterfactual exit net — spread from the broker's quote at the
  exit, commission from NASA-4's per-account terms, swap from the nights held — and until that exists its figures
  are labelled gross and select nothing. The 4-of-269 count of ≥ 2R trades is the number to move. **Granularity
  prerequisite** (Codex round 2): `exit-counterfactual-extended.js` filters by account and strategy and groups by
  `GROUP_KEYS` = strategy, timeframe, regime, family, gate tag — not by class, side or source — so today it cannot
  answer "per cell" as step 1 defines a cell; either the class/side/source filters are added to the replay before
  this step runs, or its results are read at the endpoint's own granularity (strategy × timeframe × regime) and
  labelled so.
- **Decision it feeds**: whether an exit-policy change is worth an order (the owner's; no exit change without it).

## 3. Entry quality (why 22 % of trades die at the initial stop)

- **Data**: `trade_postmortems` (`entry_vol_regime`, the aftermath bars) joined to `monitored_positions` (`mae_r`,
  `mfe_r`, `invalidation_trigger` — the excursions and the premise live there, as the stop-placement report's join
  already reads them; Codex round 1), the stop-placement review
  (`GET /state/stop-placement`: stop ÷ ATR buckets, net-R lower bound per bucket), the regime at entry.
- **Instrument**: existing read-only routes; one new cut by premise distance (the NAS100 #1890 close 4 s after
  entry: a premise 0.007R from the fill) and by spread ÷ stop (`maxSpreadFracOfSL`).
- **Output**: the share of initial-stop losses whose MFE never reached +0.5R (bad entry) versus those that reached
  +1R first (bad exit); stop-width buckets ranked by lower bound.
- **Decision it feeds**: a premise minimum distance (booked follow-up), stop-width floors per class, or neither.

## 4. Selection (which cells, which classes, which hours)

- **Data**: steps 1–3; the tick-activity measurement (`GET /state/tick-activity`, selected side only) and the
  session calendar for the hour-of-day cut.
- **Instrument**: the live evidence gate (`GET /state/evidence-gate`), which decides STRATEGY × ACCOUNT only —
  `evidenceRows()` aggregates every class and side of a strategy — so it is not a gate per cell as step 1 defines
  one: the class and side exclusions are the class-routing policy's job (the (class, strategy, side) tokens), and
  the gate's verdict applies to the strategy on the account (Codex round 2). The gate judges by its OWN persisted
  configuration — defaults 30 closes, net-money PF 1.5 over 90 days, no drawdown check (`services/evidence-gate.js`)
  — not by `agent/config/tick-validation.json`, whose traded bar (30 trades, PF 1.3, 8R drawdown) belongs to the
  tick-validation importer; the plan reads the gate's configuration as the endpoint returns it and names the
  validation bar separately for tick cells (Codex round 1). The class-routing policy (`agent/config/class-routing.json`,
  read back at `GET /state/class-routing`) is introduced by PR #1390 and is a prerequisite of this step until it
  merges. The goal table.
- **Output**: a ranked table of cells by expectancy lower bound at n ≥ 30; the routing map re-derived from it (blocks
  and priorities from measurement, not from n = 8); the hours in which the robust cells pay.
- **Decision it feeds**: the next routing map and the per-cell arming (owner's order per change).

## 5. Capacity (can the robust cells take ten times the size)

- **Data**: the broker's symbol metadata (`minVolume`, `maxVolume`, `stepVolume`), the per-account commission terms
  (NASA-4, from each account's own broker rate), measured spreads at entry (`spread_at_entry`, present on 78 of 271
  rows — the first task is to make it present on all), the TP1 slippage measurement of 02-10.
- **Instrument**: a read-only capacity report per class: at 1×, 3× and 10× today's median risk, the lot implied,
  whether it clears the step and the maximum, the cost (spread + commission + measured slippage) as a share of the
  stop distance, and the margin it commits against the pool (`maxMarginUsagePct`, `marginLevelFloorPct`).
- **Output**: per class, the size at which cost exceeds 10 % of the stop and the size at which the broker's limits
  bind.
- **Decision it feeds**: which classes can carry the risk unit the owner sets; which cannot (then more cells, not
  more size).

## 6. Sizing (last, and only on proven expectancy)

- **Data**: the R stream of the robust cells (steps 1–4), the account balances, the limits in force per account —
  `perTradeRiskPct`, `maxRiskCapPct`, the tiered daily cap (`dailyLossFloorUsd`, `dailyLossTierAtUsd`,
  `dailyLossTierSmallPct`, `dailyLossTierLargePct`, the flat `dailyLossLimit` it replaces), `equityStopPct`,
  `maxNotionalXBalance` — read as each account's EFFECTIVE values (`GET /state/config?account=`: global plus the
  account's overlay), not the code defaults (Codex round 5) — including `perTradeRiskUsd` (an absolute override under
  which `riskBudgetUsd` ignores the percentage) and `drawdownDeriskFactor` (the live sizing path halves later budgets
  after the 24-hour loss trigger). The replay applies both in chronological order; a scenario that omits them is
  labelled constant-risk, not engine-equivalent (Codex round 7).
- **Instrument**: a replay of the same R stream at 0.5 %, 1 %, 2 %, 3 % risk per trade per account: monthly result
  and maximum drawdown in NET R and IN THE ACCOUNT'S DEPOSIT CURRENCY — the modelled commission and swap are subtracted
  at the replayed size, scaled with the lots, never dropped (Codex round 6) — (SGD on 42993489 and 43097342, USD on the other
  three; no conversion — none is sourced; Codex round 2). **The hard ceiling bounds the scenarios** (Codex round 5):
  `riskBudgetUsd` clamps every percentage budget at `balance × maxRiskCapPct` (`risk.js:1140`; default 0.015,
  `risk.js:324`), so 0.5 % and 1 % are reachable through `perTradeRiskPct` alone while 2 % and 3 % are not — those
  two are replayed twice: clamped at each account's effective ceiling (what the engine would actually size), and as
  "ceiling raised" scenarios labelled as requiring a separately authorised `maxRiskCapPct` change (a risk-limit
  change: ask-first, P7, never implied by this study). Days the daily loss cap would have stopped trading — on the
  USD accounts only: the cap is defined in USD at runtime AND IS TIERED — `pacedDailyCap`
  (`daily-loss-pacing.js:153`) takes max(`dailyLossFloorUsd` 200, balance × 3 % below `dailyLossTierAtUsd` 10,000 /
  4 % above), which replaces the flat `dailyLossLimit` 300 while the three tier knobs are set (`risk.js:250–282`: a
  $46,073 account caps near $1,843, not $300), every value subject to the global and per-account overlays; the replay
  loads each USD account's effective knobs and applies the runtime calculation (Codex round 5). Native P&L is
  converted through `accountCurrencyConversion`, so an SGD replay cannot count cap days without a sourced historical
  USD/SGD rate; the statistic is omitted for 42993489 and 43097342 and said so, rather than compared at an unsourced
  rate (Codex round 4) — the Kelly fraction from the
  measured win rate and payoff (today f* = 0.48 − 0.52 ÷ (0.66 ÷ 0.72) < 0 — negative: no size is right until the
  expectancy is positive).
- **Output**: the risk unit per account that keeps the drawdown inside the owner's capital-preservation numbers.
- **Decision it feeds**: a change to `perTradeRiskPct`, and separately to `maxRiskCapPct` where a scenario needs the
  ceiling raised — each ask-first, the owner's alone (P7).

## 7. Discipline — standing rules, each with its live check

| rule | metric | source of the bar | live check |
|---|---|---|---|
| No trade without qualifying evidence | entries whose cell fails the evidence gate | § 14,730 objective; the live gate's own configuration (`/state/evidence-gate`); tick-validation.json for tick cells | zero such entries per week in the decision log |
| Initial-stop losses are a measured share, not a surprise | closes at ≤ −0.9R ÷ closes | step 3's cut (today 22 %) | weekly share within the measured band; a rise names the cell |
| Longs and shorts are judged apart | PF by side per cell | № 10,884 measured longs PF 0.47 vs shorts 1.77 — re-measured in step 1 | a side below 1.0 PF at n ≥ 30 is routed out |
| Losses are capped before they compound | daily loss cap hits; equity stop | `dailyLossLimit`, `equityStopPct` (owner's numbers) | cap honoured on every account; each hit logged with its trades |
| Size follows evidence, never the other way | risk unit per account vs the cell's lower bound | step 6 | risk per trade reads the configured unit; no override without a record |
| Adopted and manual trades are the owner's | source split in every report | step 1 | reports show own/adopted/manual apart |
| Every exclusion is a record | routed-out and vetoed candidates per day | class-routing view; decision log | counts present; zero unexplained skips |

## 8. What the owner decides first (§ 14,730, still open)

1. The conservative measure (the bootstrap 5th-percentile net R, or another).
2. The costs that count (commission is in; swap and slippage?).
3. The capital-preservation numbers (daily and weekly loss limit, maximum drawdown, maximum risk per trade).
4. The evidence bar's scope (bar strategies too; rank against principles 2 and 7; demo versus live; manual; the
   momentum book).

Steps 1–5 can run without these answers (they measure). Step 6 and every rule in §7 that carries a number waits for
them.

## 9. Sequence and what is not proposed

Order: 1 (decomposition) → 3 (entry quality) → 2 (exit counterfactuals) → 4 (selection) → 5 (capacity) → 6
(sizing). Steps 1, 3 and 5 are read-only routes or reports; 2 and 4 use existing research instruments; 6 is a replay.
Not proposed by this document: any change to risk limits, strategies, exits, the watchlist or an account; no live
order; no new native code.

## Grounding

1. Sources of the figures: the five accounts' trade exports of 16-10 00:4xZ (`trades` rows; `net_pnl` and
   `realised_rr` from the broker's deals through the ledger), the broker's instrument tree (classes), the repo's own
   configuration files for the limits and bars named; each account's deposit currency from the broker's asset list
   (`depositCurrencies`, 16-10); the bot's own stream by `origin` (`cleanBotOrigin`, trade-origin.js). *Self-derived*:
   the gross-basis risk approximation (gross_pnl ÷ realised_rr, 212 of 224 own rows, per currency), the illustrative
   arithmetic in §0, the step order.
2. Population: every closed trade of the five accounts since 16-09 (271): 224 own by `origin`, 47 adopted/manual
   reported apart, not excluded.
3. Live check: Not Applicable — a planning document; each step it proposes carries its own live check when built.
