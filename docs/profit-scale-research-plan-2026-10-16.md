# Profit at scale — research plan and discipline (16 October 2026)

Claude · № 15,152 16-Oct (owner, after § 15,128: "Next, plan research, discipline how to maximise opportunity with
larger profit returns in thousands than just in single dollar profit or in tens or in hundreds"; claude-builder).
A plan, not a policy: nothing here changes a strategy, a stop, a target, a lot, a risk limit or an account. Each step
names its data source, its instrument in the repo, and the decision it feeds. The owner picks which steps become code.

## 0. The arithmetic, measured

Profit per month = Σ over trades of (R realised × risk in USD per trade). Both factors are measured on the five
accounts' 271 closed trades since 16 September (ledger export of 16-10 00:4xZ; `net_pnl` and `realised_rr` from the
broker's deals):

| factor | measured | source |
|---|---|---|
| R per trade | mean −0.06R, median −0.05R; win rate 48 %; average win +0.66R, average loss −0.72R; profit factor in R 0.85 | `trades.realised_rr`, 269 rows with R |
| trades ≥ 2R | 4 of 269 | same |
| trades at the initial stop (≤ −0.9R) | 59 of 269; 148 of 271 closes are broker stop fills | `trades.close_reason` |
| risk per trade (USD) | median 23, quartiles 5–51, max 1,011 (= net_pnl ÷ realised_rr) | derived; per account below |
| hold | median 4.1 h, upper quartile 23 h | `trades.hold_duration_ms` |

| account | n | net USD | median risk USD | ΣR |
|---|---|---|---|---|
| 42993489 (live) | 8 | +17 | 0.7 | +1.3 |
| 43097342 | 74 | +1,541 | 4.8 | −1.3 |
| 46130058 | 99 | −136 | 35.5 | −10.9 |
| 46979908 | 29 | −10 | 1.5 | −3.1 |
| 47790949 | 61 | −1,777 | 92.2 | −1.3 |

Two readings follow directly. **The expectancy is zero or below**: at any size, more trades of the same stream add
noise, not profit. **The size is tens of dollars**: at a median 23 USD of risk, a trade that pays +1R pays 23 USD —
the "single dollars, tens, hundreds" the owner describes is the risk unit, not the strategy. The largest single
contributors are not the bot's own stream: the index class's +1,184 USD is one externally opened JPN225 long adopted
by the reconciler (+1,602 USD, 1.6R); the energy class's −1,477 USD is NATGAS longs (−995 adopted, −612 own).

Thousands a month needs both factors at once, in this order: a positive, proven R per trade first (e.g. +0.3R mean
over ≥ 30 trades of a cell, lower bound above zero), then a risk unit sized to the account (e.g. 1–2 % of a 10,000
USD account is 100–200 USD). 0.3R × 150 USD × 60 trades a month ≈ 2,700 USD. 0 R × 23 USD × 270 trades = 0. The
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
  lower bound (`tick-replay-sim expectancyLowerR`), and NASA-6's train/confirm split (select on 70 % of the span,
  confirm on the rest; `trainFraction` in research.json).
- **Output**: per robust cell, mean R and its lower bound under: the exit as traded, let-run to a fixed R target (2R,
  3R), a trail at kR, a time stop at the mean holding period. The 4-of-269 count of ≥ 2R trades is the number to
  move.
- **Decision it feeds**: whether an exit-policy change is worth an order (the owner's; no exit change without it).

## 3. Entry quality (why 22 % of trades die at the initial stop)

- **Data**: `trade_postmortems` (MAE/MFE in R, `entry_vol_regime`, premise), the stop-placement review
  (`GET /state/stop-placement`: stop ÷ ATR buckets, net-R lower bound per bucket), the regime at entry.
- **Instrument**: existing read-only routes; one new cut by premise distance (the NAS100 #1890 close 4 s after
  entry: a premise 0.007R from the fill) and by spread ÷ stop (`maxSpreadFracOfSL`).
- **Output**: the share of initial-stop losses whose MFE never reached +0.5R (bad entry) versus those that reached
  +1R first (bad exit); stop-width buckets ranked by lower bound.
- **Decision it feeds**: a premise minimum distance (booked follow-up), stop-width floors per class, or neither.

## 4. Selection (which cells, which classes, which hours)

- **Data**: steps 1–3; the tick-activity measurement (`GET /state/tick-activity`, selected side only) and the
  session calendar for the hour-of-day cut.
- **Instrument**: the evidence gate per cell (`GET /state/evidence-gate`; bars in `agent/config/tick-validation.json`:
  traded `minTrades` 30, `minProfitFactor` 1.3, `maxDrawdownR` 8), the class-routing policy
  (`agent/config/class-routing.json`, read back at `GET /state/class-routing`), the goal table.
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
| No trade without qualifying evidence | entries whose cell fails the evidence gate | § 14,730 objective; tick-validation.json | zero such entries per week in the decision log |
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
   configuration files for the limits and bars named. *Self-derived*: the risk-per-trade derivation
   (net_pnl ÷ realised_rr, 254 of 271 rows), the illustrative arithmetic in §0, the step order.
2. Population: every closed trade of the five accounts since 16-09 (271), all sources; adopted and manual trades
   are reported apart, not excluded.
3. Live check: Not Applicable — a planning document; each step it proposes carries its own live check when built.
