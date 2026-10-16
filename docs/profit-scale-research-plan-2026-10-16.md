# Profit at scale — research plan and discipline (16 October 2026)

Claude · № 15,152 16-Oct (owner, after § 15,128: "Next, plan research, discipline how to maximise opportunity with
larger profit returns in thousands than just in single dollar profit or in tens or in hundreds"; claude-builder).
A plan, not a policy: nothing here changes a strategy, a stop, a target, a lot, a risk limit or an account. Each step
names its data source, its instrument in the repo, and the decision it feeds. The owner picks which steps become code.

## 0. The arithmetic, measured

Profit per month = Σ over trades of (R realised × risk per trade in the account's own currency). Both factors are
measured on the five accounts' 271 closed trades since 16 September (ledger export of 16-10 00:4xZ; `net_pnl` and
`realised_rr` from the broker's deals). **Money is never pooled across currencies** (Codex round 1): 42993489 and
43097342 are SGD accounts, 46130058, 46979908 and 47790949 USD accounts (the broker's asset list, read through
`depositCurrencies` on 16-10), so every money figure below is per currency; R is the only currency-free unit and
the only one pooled across all five.

| factor | measured | source |
|---|---|---|
| R per trade | mean −0.06R, median −0.05R; win rate 48 %; average win +0.66R, average loss −0.72R; profit factor in R 0.85 | `trades.realised_rr`, 269 rows with R |
| trades ≥ 2R | 4 of 269 | same |
| trades at the initial stop (≤ −0.9R) | 59 of 269; 148 of 271 closes are broker stop fills | `trades.close_reason` |
| risk per trade, USD accounts (189 trades) | median 36 USD, quartiles 19–88, max 960 (= net_pnl ÷ realised_rr, 175 rows with a usable R) | derived; per account below |
| risk per trade, SGD accounts (82 trades) | median 4.8 SGD, quartiles 3.4–6.7, max 1,011 (79 rows) | derived; per account below |
| hold | median 4.1 h, upper quartile 23 h | `trades.hold_duration_ms` |

| account | currency | n | net (own currency) | median risk (own currency) | ΣR |
|---|---|---|---|---|---|
| 42993489 (live) | SGD | 8 | +17 | 0.7 | +1.3 |
| 43097342 | SGD | 74 | +1,541 | 4.8 | −1.3 |
| 46130058 | USD | 99 | −136 | 35.5 | −10.9 |
| 46979908 | USD | 29 | −10 | 1.5 | −3.1 |
| 47790949 | USD | 61 | −1,777 | 92.2 | −1.3 |

Two readings follow directly. **The expectancy is zero or below**: at any size, more trades of the same stream add
noise, not profit. **The size is tens of dollars**: at a median 36 USD of risk on the USD accounts (4.8 SGD on the SGD
accounts), a trade that pays +1R pays 36 USD or 4.8 SGD — the "single dollars, tens, hundreds" the owner describes is
the risk unit, not the strategy. The largest single contributors are not the bot's own stream: the index class's
result is one externally opened JPN225 long adopted by the reconciler on 43097342 (+1,602 SGD, 1.6R); the energy
class's loss is NATGAS longs (−990 USD adopted on 47790949; the bot's own NATGAS longs −615 USD over 16 trades on the
USD accounts and −2 SGD over 10 on the SGD accounts).

Thousands a month needs both factors at once, in this order: a positive, proven R per trade first (e.g. +0.3R mean
over ≥ 30 trades of a cell, lower bound above zero), then a risk unit sized to the account (e.g. 1–2 % of a 10,000
USD account is 100–200 USD; the same rule in SGD on the SGD accounts). 0.3R × 150 USD × 60 trades a month ≈ 2,700
USD. 0 R × 36 USD × 190 trades = 0. The
second factor without the first multiplies losses by the same ratio — which is why size comes last below.

## 1. Decompose the P&L (where the money comes from and goes)

- **Data**: `trades` joined to `analyses` (strategy, timeframe, side, source, account), the broker class from the
  cached instrument tree (lib/asset-class.js), `realised_rr`, `net_pnl`, `commission`, `hold_duration_ms`,
  `close_reason`. Period: every closed trade since 16-09, then rolling 30 days.
- **Instrument**: a read-only route or report (the shape of `GET /state/performance-populations` and
  `/state/watchlist-stats`), one row per (class, strategy, side, account, source): n, ΣR, mean R, ΣUSD, median risk,
  share of ΣUSD held by the top three trades, share of losses at the initial stop.
- **Output**: the cells where the bot's OWN stream (source autopilot/preopen) is positive in R with n ≥ 10, and the
  cells where it loses; adopted/manual trades reported apart (they are the owner's, not the system's).
- **Decision it feeds**: which cells go into the class-routing policy (today's blocks rest on n 8–12), which cells
  the evidence gate should arm, and what "robust" means in numbers.

## 2. Exit counterfactuals (what the same entries would have paid)

- **Data**: the stored aftermath bars of every closed bot trade (`trade_postmortems.bars_json`, closed bars only
  since #1382), the entry, stop and target as sent.
- **Instrument**: the existing exit-replay engine (`GET /state/exit-counterfactual`; rules in
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
  measured median hold (4.1 h). The 4-of-269 count of ≥ 2R trades is the number to move.
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
- **Instrument**: the live evidence gate per cell (`GET /state/evidence-gate`), which judges by its OWN persisted
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

- **Data**: the R stream of the robust cells (steps 1–4), the account balances, the limits in force (`perTradeRiskPct`,
  `dailyLossLimit`, `equityStopPct`, `maxNotionalXBalance`).
- **Instrument**: a replay of the same R stream at 0.5 %, 1 %, 2 %, 3 % risk per trade per account: monthly USD,
  maximum drawdown in R and USD, days the daily loss cap would have stopped trading, the Kelly fraction from the
  measured win rate and payoff (today f* = 0.48 − 0.52 ÷ (0.66 ÷ 0.72) < 0 — negative: no size is right until the
  expectancy is positive).
- **Output**: the risk unit per account that keeps the drawdown inside the owner's capital-preservation numbers.
- **Decision it feeds**: a change to `perTradeRiskPct` — ask-first, the owner's alone (P7).

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
   (`depositCurrencies`, 16-10). *Self-derived*: the risk-per-trade derivation (net_pnl ÷ realised_rr, 254 of 271
   rows, per currency), the illustrative arithmetic in §0, the step order.
2. Population: every closed trade of the five accounts since 16-09 (271), all sources; adopted and manual trades
   are reported apart, not excluded.
3. Live check: Not Applicable — a planning document; each step it proposes carries its own live check when built.
