# Bot-Trade Trading Account Performance and Health Audit

**Repository:** `ang-kl/bot-trade`  
**Audited branch:** `main`  
**Audit date:** 2 August 2026  
**Scope:** Source-code audit of performance reporting, trading-account health, risk analytics, strategy health, data integrity and operational health.

---

## Executive Verdict

**The repository is not yet sufficient for a complete, globally comparable trading-account performance and health report.**

The system is already strong in:

- trade-level statistics;
- strategy-edge supervision;
- risk controls;
- trade provenance;
- post-trade review;
- data-integrity checks;
- operational monitoring.

However, the account-accounting foundation remains incomplete. In particular, the repository does not yet provide a dependable canonical layer for:

- historical account balance;
- historical account equity;
- unrealised P&L;
- deposits and withdrawals;
- cash-flow-adjusted returns;
- true equity drawdowns;
- time-weighted and money-weighted returns;
- complete risk-adjusted performance.

This means the current system is stronger as a **trading-control and strategy-supervision platform** than as a complete **account-performance reporting platform**.

> **Important limitation:** This was a source-code audit. It did not inspect the live SQLite database or broker account. The audit therefore assesses whether computations and fields exist, not whether the historical account records are complete or numerically correct.

---

## 1. Present Capability Assessment

| Reporting domain | What the repository presently computes | Assessment |
|---|---|---|
| Basic outcome | Net P&L, trades, wins, losses, win rate, average win and average loss | Strong |
| Trading edge | Profit factor, payoff ratio and expectancy per trade | Strong |
| Planned trade quality | Planned R:R, required win rate and win-rate edge | Useful, but not actual realised R |
| Time windows | 1H, 4H, 12H, yesterday, 3D, WTD, 1W, 2W, 30D, MTD, last month, 3M, 6M and 12M | Strong |
| Attribution | Market, symbol, account, strategy, timeframe, session, source and conviction | Strong |
| Strategy health | Rolling expectancy, profit factor, win rate, alpha decay and streaks | Strong |
| Trade review | Human-versus-bot attribution, on-plan exits, loss classifications and lessons | Strong |
| Drawdown | Absolute closed-P&L drawdown and charted drawdown band | Partial |
| Account return | Cash-flow-adjusted percentage return, TWR, MWR or XIRR | Missing |
| Risk-adjusted return | Sharpe, Sortino, Calmar, recovery factor and downside volatility | Mostly missing |
| Equity health | Historical balance, equity, unrealised P&L and margin series | Missing |
| Trading costs | Commission, swap, spread, slippage and latency fields | Partially captured, not consolidated |
| Exposure health | Live risk caps, currency exposure and correlation-cluster controls | Strong controls, weak historical reporting |
| Data integrity | Unknown-P&L controls, duplicate trades and same-symbol clustering | Strong |
| Operational health | Loop health, API health, errors, uptime, broker link and controller status | Strong |
| Cash movements | Deposits, withdrawals and transfers | Missing |
| Professional disclosure | Monthly return table, dated drawdowns, methodology and report version | Missing |

### Existing repository strengths

The performance ledger aggregates recorded closed trades across multiple time windows and market groups, including:

- net P&L;
- trade count;
- win rate;
- profit factor;
- TP, partial, SL and manual-close counts;
- planned R:R;
- required win rate;
- edge against required win rate;
- account and market slicing.

Relevant source:

- [`agent/services/perf-ledger.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/perf-ledger.js)

The wider repository also includes substantial account- and strategy-health capabilities:

- per-strategy rolling expectancy;
- per-strategy profit factor;
- live win rate;
- edge decay;
- entry-lag decay;
- live-versus-prior comparisons;
- streak detection;
- timeframe performance;
- adaptive breakers;
- automatic strategy disarming.

Relevant sources:

- [`agent/services/edge-watchdog.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/edge-watchdog.js)
- [`agent/services/alpha-decay.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/alpha-decay.js)
- [`agent/services/timeframe-performance.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/timeframe-performance.js)
- [`agent/services/performance-breaker.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/performance-breaker.js)

---

## 2. Critical Correctness Findings

### 2.1 “All-time” reporting is limited to 100 trades

The Performance page obtains trade records from `/state/trades`.

That endpoint returns only the latest 100 closed or rejected records:

```sql
SELECT *
FROM trades
WHERE status IN ('closed', 'rejected')
ORDER BY COALESCE(closed_at, opened_at) DESC
LIMIT 100
```

The page then calculates its “All-time” tiles and chart from that response.

This means that after an account exceeds 100 trades, the following figures are no longer truly all-time:

- total closed trades;
- net P&L;
- win rate;
- expectancy;
- payoff ratio;
- average win;
- average loss;
- streaks;
- maximum drawdown;
- equity chart;
- best and worst day;
- holding-period statistics.

Relevant sources:

- [`agent/routes/state.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/routes/state.js)
- [`src/pages/Performance.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/pages/Performance.jsx)

### Required correction

Create a dedicated server-side analytics endpoint that computes statistics over the complete selected period.

Keep the 100-record limit only for the visible trade journal.

---

### 2.2 Maximum drawdown may be calculated in reverse chronology

The trade route returns newest trades first.

The Performance page creates the P&L sequence and computes drawdown before constructing a separate chronologically sorted trade array for streaks and day-level calculations.

The current pattern is effectively:

```javascript
const pnls = closed.map(t => Number(t.net_pnl))

let peak = 0
let equity = 0
let mdd = 0

for (const pnl of pnls) {
  equity += pnl
  peak = Math.max(peak, equity)
  mdd = Math.max(mdd, peak - equity)
}
```

Because `closed` originates from a newest-first endpoint, this drawdown may be calculated backwards.

### Required correction

Before every path-dependent computation, sort trades using a canonical millisecond close timestamp in ascending order.

This applies to:

- drawdown;
- streaks;
- equity curves;
- recovery duration;
- time underwater;
- rolling returns;
- peak and trough dates.

---

### 2.3 Reserved database columns are not implemented analytics

The `performance_snapshots` table contains fields for:

```text
sharpe_ratio
max_drawdown_pct
avg_rr
```

However, the snapshot writer presently inserts only:

```text
total_trades
winning_trades
losing_trades
win_rate
profit_factor
total_pnl
avg_win
avg_loss
computed_at
```

Therefore:

- Sharpe ratio is reserved but not populated;
- maximum drawdown percentage is reserved but not populated;
- average R:R is reserved but not populated.

Relevant sources:

- [`agent/db.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/db.js)
- [`agent/loop.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/loop.js)

The snapshot also lacks:

- `account_id`;
- reporting period start;
- reporting period end;
- valuation frequency;
- data-coverage percentage;
- methodology version;
- resolved and unresolved P&L counts.

---

### 2.4 The displayed equity curve is a realised-P&L curve

The current chart:

1. starts from zero;
2. adds closed-trade net P&L;
3. derives a high-water mark from cumulative realised P&L.

It does not include:

- starting account capital;
- historical account balance;
- unrealised P&L;
- deposits;
- withdrawals;
- transfers;
- broker credit;
- margin usage;
- funding events.

It should therefore be labelled:

> **Cumulative realised P&L**

It should not be labelled as true account equity until account valuation snapshots are captured.

Relevant sources:

- [`src/components/ReportChart.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/components/ReportChart.jsx)
- [`src/components/PerfMacroSections.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/components/PerfMacroSections.jsx)

---

### 2.5 Deposits and withdrawals are not tracked

The Performance macro component explicitly acknowledges that the repository does not yet have a data source for deposits and withdrawals.

Without external cash-flow records, the system cannot calculate dependable:

- percentage account return;
- time-weighted return;
- money-weighted return;
- XIRR;
- true capital growth;
- cash-flow-adjusted drawdown;
- account-level performance across funding events.

Relevant source:

- [`src/components/PerfMacroSections.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/components/PerfMacroSections.jsx)

---

### 2.6 Portfolio and account scoping require stronger isolation

The performance ledger includes rows where:

```sql
account_id = selected_account
OR account_id IS NULL
```

This supports legacy records, but it creates reporting ambiguity.

An unattributed legacy record may appear in multiple account views.

Professional reporting should instead expose:

- attributed records;
- unattributed records;
- account-specific totals;
- portfolio totals;
- the numerical effect of unattributed records.

Relevant source:

- [`agent/services/perf-ledger.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/perf-ledger.js)

The all-account carry baseline also appears to rely on a global account-balance state rather than a sum of independently timestamped balances for each registered account.

This can cause multi-account portfolio performance to reconcile incorrectly.

---

### 2.7 Unknown P&L is treated inconsistently

Some parts of the repository correctly exclude closed trades whose net P&L is unresolved.

Other areas do not.

Examples:

- performance snapshots use `COUNT(*)` for total closed trades;
- wins and losses depend on net P&L;
- timeframe performance applies `COALESCE(net_pnl, 0)`.

This can cause unresolved trades to:

- increase trade count;
- reduce win rate;
- appear as flat trades;
- distort P&L and expectancy denominators.

Relevant sources:

- [`agent/loop.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/loop.js)
- [`agent/services/timeframe-performance.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/timeframe-performance.js)
- [`agent/services/unresolved-pnl.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/unresolved-pnl.js)

Every report should separately state:

```text
total_closed_records
resolved_pnl_trades
unresolved_pnl_trades
excluded_records
invalid_records
attributed_records
unattributed_records
```

---

### 2.8 Planned R:R is not actual realised R

The ledger calculates planned R:R from:

```text
entry price
stop-loss price
take-profit price
```

That measures the design of the trade.

It does not measure the actual result after:

- partial exits;
- stop movement;
- slippage;
- commissions;
- swap;
- manual closing;
- trailing exits;
- scaling;
- gap fills.

The repository already contains some related fields:

- `initial_risk`;
- `mfe_r`;
- `mae_r`;
- `r_multiple`.

However, these are not yet demonstrated as complete and durable for every closed trade.

Relevant sources:

- [`agent/db.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/db.js)
- [`agent/services/perf-ledger.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/perf-ledger.js)
- [`agent/services/loss-postmortem.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/loss-postmortem.js)

---

### 2.9 Some outcome classifications are inferred

The performance ledger classifies TP, SL, partial and manual outcomes using:

- close-reason text;
- price proximity;
- fallback heuristics.

Where no close reason is available, a profitable trade may be classified as TP.

The report should distinguish:

```text
broker_confirmed
system_recorded
price_inferred
heuristic_inferred
unknown
```

An inferred TP should not have the same confidence as a broker-confirmed TP.

Relevant source:

- [`agent/services/perf-ledger.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/perf-ledger.js)

---

### 2.10 Day boundaries are not fully consistent

Most backend services use a shared, DST-aware 17:00 New York trading-day anchor.

`SessionReview` uses a fixed New York offset intended for July.

This can become incorrect when daylight-saving time changes and can cause the day or week review to disagree with the performance ledger.

Relevant sources:

- [`agent/shared/formulas.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/shared/formulas.js)
- [`src/components/SessionReview.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/components/SessionReview.jsx)

### Required correction

All time-window logic should use one shared server-side implementation.

---

## 3. Full Trading-Account Analysis Report Catalogue

The consolidated account report should contain the following sections.

| № | Report section | Core computations |
|---:|---|---|
| 1 | Executive account health | Balance, equity, free margin, realised and unrealised P&L, MTD/YTD/since-inception return, current drawdown, margin level, data completeness and warnings |
| 2 | Returns and capital | Daily, weekly, monthly and annual returns; TWR; MWR/XIRR; cumulative return; starting and ending capital; deposits and withdrawals |
| 3 | Balance and equity | True balance and equity curves, high-water mark, funding markers, realised-versus-unrealised components |
| 4 | Drawdown and recovery | Maximum and current balance/equity drawdown in dollars and percentage; start, trough and recovery dates; duration; time underwater; recovery factor |
| 5 | Risk-adjusted performance | Sharpe, Sortino, Calmar, volatility, downside deviation, Omega or gain-loss ratio and return-to-drawdown |
| 6 | Trade statistics | Total, wins, losses, scratches, win rate, average and median win/loss, payoff, expectancy, profit factor, largest trade, streaks and holding duration |
| 7 | R and excursion analysis | Planned R:R, actual R, R distribution, MFE, MAE, exit efficiency, profit captured versus available and stop efficiency |
| 8 | Cost and execution quality | Gross P&L, commission, swap, spread cost, slippage, cost drag, latency, rejection rate, fill rate and adverse execution by symbol |
| 9 | Exposure and capital usage | Gross/net notional, margin used, minimum margin level, leverage, concurrency, time in market, concentration by asset/currency/cluster and correlated exposure |
| 10 | Performance attribution | Account, strategy, symbol, asset class, long/short, source, timeframe, session, day/hour, regime, conviction, entry lag and exit reason |
| 11 | Stability and process | Rolling expectancy/PF, recent-versus-prior edge, live-versus-backtest gap, sample size, confidence intervals, plan adherence, manual intervention and loss lessons |
| 12 | System and data health | Broker/API freshness, reconciliation lag, loop health, errors, unresolved P&L, duplicate records, attribution coverage, missing fields and report methodology |

---

## 4. Recommended Account-Health Headline

A compact headline should not be a single opaque score.

Use a state-based summary such as:

```text
ACCOUNT HEALTH: CAUTION

Capital
- Equity: SGD 10,420
- Current drawdown: -4.8%
- Free margin: 62%
- Margin level: 287%

Performance
- 30D TWR: +2.7%
- Profit factor: 1.21
- Expectancy: +SGD 8.30/trade
- Sortino: 0.84

Stability
- 2 of 5 strategies profitable live
- 1 strategy showing edge decay
- 19% of P&L consumed by costs

Data quality
- 96% P&L resolved
- 91% trades strategy-attributed
- 2 possible duplicate records
```

Recommended state rules:

| State | General interpretation |
|---|---|
| Healthy | Positive return, controlled drawdown, adequate margin, no serious integrity issues |
| Caution | Mixed performance, rising drawdown, cost drag, thin samples or partial data |
| Degraded | Negative edge, worsening drawdown, margin pressure, stale data or high unresolved P&L |
| Critical | Equity stop, margin danger, duplicate exposure, broker disconnect or reconciliation failure |
| Insufficient data | Sample or valuation history too incomplete for a defensible verdict |

The overall state should always disclose the dimensions that caused it.

---

## 5. Minimum Additional Data Model

### 5.1 Account valuation snapshots

Create an append-only table:

```sql
CREATE TABLE account_equity_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          TEXT NOT NULL,
  recorded_at_ms      INTEGER NOT NULL,
  balance             REAL,
  equity              REAL,
  realised_pnl        REAL,
  unrealised_pnl      REAL,
  used_margin         REAL,
  free_margin         REAL,
  margin_level_pct    REAL,
  credit              REAL,
  base_currency       TEXT,
  broker_source       TEXT,
  freshness_ms        INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Record snapshots:

- at a fixed cadence;
- after every trade close;
- after every deposit or withdrawal;
- after a material margin change;
- before and after account switching;
- after broker reconciliation.

This becomes the source for:

- true account return;
- true equity drawdown;
- true margin history;
- capital utilisation;
- time underwater;
- recovery duration.

---

### 5.2 External cash flows

```sql
CREATE TABLE account_cash_flows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            TEXT NOT NULL,
  occurred_at_ms        INTEGER NOT NULL,
  flow_type             TEXT NOT NULL,
  amount                REAL NOT NULL,
  currency              TEXT,
  amount_base_currency  REAL,
  broker_transaction_id TEXT,
  external_flow         INTEGER NOT NULL DEFAULT 1,
  note                  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Recommended `flow_type` values:

```text
deposit
withdrawal
transfer_in
transfer_out
credit
adjustment
fee_adjustment
```

Trading commissions, swaps and realised trading losses should not be treated as external cash flows.

---

### 5.3 Closed-trade analytics

Persist or deterministically derive for every completed trade:

```text
planned_risk_usd
initial_risk_usd
planned_rr
actual_r_multiple
mfe_r
mae_r
mfe_usd
mae_usd
commission
swap
spread_cost_usd
slippage_usd
slippage_pips
entry_latency_ms
notional_usd
margin_used
exit_efficiency_pct
outcome_source
data_quality_flags
```

The repository already contains migrations for several execution fields:

- slippage price;
- spread at entry;
- entry latency;
- commission;
- swap;
- relative volume;
- order-book context.

Relevant source:

- [`agent/db.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/db.js)

---

### 5.4 Account-scoped performance snapshots

Extend or replace `performance_snapshots` with:

```text
account_id
period_start_ms
period_end_ms
valuation_frequency
return_twr
return_mwr
return_simple
volatility_annualised
downside_volatility
sharpe_ratio
sortino_ratio
calmar_ratio
recovery_factor
max_balance_drawdown_pct
max_equity_drawdown_pct
current_drawdown_pct
drawdown_start_ms
drawdown_trough_ms
drawdown_recovery_ms
resolved_trade_count
unknown_pnl_count
data_coverage_pct
calculation_version
```

A `calculation_version` is necessary because future changes to:

- fee treatment;
- scratch-trade treatment;
- cash-flow handling;
- annualisation;
- return frequency;
- timezone boundaries;

must not silently rewrite historical meaning.

---

## 6. Canonical Computation Definitions

### 6.1 Net P&L

```text
net_pnl = gross_pnl - commission + swap - other_broker_costs
```

Use the broker-confirmed value when available.

---

### 6.2 Expectancy

Trade-based expectancy:

```text
expectancy = total_net_pnl / resolved_trade_count
```

Alternative decomposition:

```text
expectancy =
  win_rate × average_win
  -
  loss_rate × average_loss_absolute
```

Report both when possible and ensure they reconcile.

---

### 6.3 Profit factor

```text
profit_factor =
  gross_profit / absolute_gross_loss
```

Do not represent no-loss samples as an ordinary finite number.

Use:

```text
Infinity
```

or an explicitly labelled state:

```text
No losing trades in sample
```

---

### 6.4 Payoff ratio

```text
payoff_ratio =
  average_win / absolute_average_loss
```

---

### 6.5 Planned R:R

```text
planned_rr =
  absolute(tp_price - entry_price)
  /
  absolute(entry_price - initial_sl_price)
```

---

### 6.6 Actual R multiple

```text
actual_r =
  net_pnl
  /
  initial_risk_usd
```

`initial_risk_usd` must be frozen at entry.

Do not recalculate it using a later stop-loss value.

---

### 6.7 Time-weighted return

For every sub-period separated by external cash flows:

```text
subperiod_return =
  ending_equity_before_flow
  /
  beginning_equity_after_previous_flow
  - 1
```

Linked return:

```text
TWR =
  product(1 + subperiod_return)
  - 1
```

---

### 6.8 Maximum drawdown

For each chronological equity point:

```text
high_water_mark_t = max(equity_0 ... equity_t)

drawdown_t =
  equity_t / high_water_mark_t
  - 1

maximum_drawdown =
  minimum(drawdown_t)
```

Store:

```text
peak date
trough date
recovery date
drawdown percentage
drawdown amount
drawdown duration
time underwater
```

---

### 6.9 Sharpe ratio

Using periodic cash-flow-adjusted returns:

```text
sharpe =
  mean(periodic_return - periodic_risk_free_rate)
  /
  standard_deviation(periodic_return)
  × annualisation_factor
```

The report must disclose:

- return frequency;
- annualisation factor;
- risk-free-rate assumption;
- whether returns are balance- or equity-based.

---

### 6.10 Sortino ratio

```text
sortino =
  mean(periodic_return - target_return)
  /
  downside_deviation
  × annualisation_factor
```

---

### 6.11 Calmar ratio

```text
calmar =
  annualised_return
  /
  absolute(maximum_drawdown)
```

---

### 6.12 Recovery factor

```text
recovery_factor =
  net_profit
  /
  absolute(maximum_drawdown_amount)
```

---

### 6.13 Cost drag

```text
total_cost =
  absolute(commission)
  + absolute(negative_swap)
  + estimated_spread_cost
  + estimated_slippage_cost

cost_drag_pct_of_gross_profit =
  total_cost / gross_profit
```

Also report cost per trade and cost per lot.

---

## 7. Proposed Canonical Endpoint

Create one reconciled account-report endpoint:

```http
GET /state/account-report
  ?account=<id|all>
  &from=<ISO timestamp>
  &to=<ISO timestamp>
  &valuation=equity
```

Recommended response structure:

```json
{
  "metadata": {},
  "dataQuality": {},
  "capital": {},
  "returns": {},
  "drawdown": {},
  "riskAdjusted": {},
  "tradeStats": {},
  "rAnalysis": {},
  "costs": {},
  "execution": {},
  "exposure": {},
  "attribution": {},
  "stability": {},
  "process": {},
  "operations": {}
}
```

### Metadata

```json
{
  "accountId": "12345",
  "currency": "SGD",
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-08-02T08:00:00Z",
  "generatedAt": "2026-08-02T08:01:00Z",
  "calculationVersion": "1.0.0",
  "timezone": "America/New_York",
  "dayAnchor": "17:00"
}
```

### Data quality

```json
{
  "closedRecords": 418,
  "resolvedPnlTrades": 409,
  "unresolvedPnlTrades": 9,
  "attributedTrades": 387,
  "unattributedTrades": 22,
  "duplicateCandidates": 2,
  "valuationCoveragePct": 96.8,
  "cashFlowCoverage": "complete",
  "freshnessSeconds": 14
}
```

---

## 8. Recommended Implementation Sequence

## P0 - Correctness before new visualisation

1. Separate the 100-row journal endpoint from complete-period analytics.
2. Correct chronological drawdown calculation.
3. Add deterministic drawdown unit tests.
4. Capture historical account balance and equity.
5. Capture deposits, withdrawals and transfers.
6. Make every calculation account-scoped.
7. Report unresolved P&L separately.
8. Replace fixed DST offsets with the shared New York anchor.
9. Label cumulative realised P&L honestly until true equity exists.
10. Add data-quality metadata to every report.

---

## P1 - Complete account-health reporting

1. Implement TWR.
2. Implement MWR/XIRR.
3. Add daily, weekly, monthly and annual return series.
4. Add true balance and equity drawdowns.
5. Add current drawdown and time underwater.
6. Add Sharpe ratio.
7. Add Sortino ratio.
8. Add Calmar ratio.
9. Add recovery factor.
10. Persist actual R for every trade.
11. Persist complete MFE and MAE.
12. Consolidate commission, swap, spread and slippage reporting.
13. Add long-versus-short attribution.
14. Add notional, leverage and margin history.
15. Add concentration and correlation-cluster history.
16. Build the canonical `/state/account-report` endpoint.

---

## P2 - Advanced analytical capability

After P0 and P1 are trustworthy, consider:

- benchmark-relative return;
- excess return;
- beta and rolling correlation;
- Value at Risk;
- Expected Shortfall;
- Monte Carlo risk-of-ruin;
- confidence intervals;
- probabilistic Sharpe ratio;
- deflated Sharpe ratio;
- live-versus-backtest degradation;
- parameter sensitivity;
- walk-forward stability;
- return-distribution analysis;
- monthly disclosure reports;
- downloadable PDF, CSV and Markdown reports.

---

## 9. Mandatory Acceptance Tests

### 9.1 Complete-period tests

1. “All-time” trade count equals the complete scoped database count.
2. The result is not limited to 100 records.
3. Account-specific totals exclude other accounts.
4. Portfolio totals equal the sum of attributed account totals plus the unattributed bucket.

### 9.2 Drawdown tests

Use known chronological P&L sequences.

Example:

```text
+100
-40
-80
+60
```

Expected cumulative equity:

```text
100
60
-20
40
```

Expected maximum drawdown:

```text
120
```

The test should fail if the input is processed newest-first.

### 9.3 Cash-flow tests

1. Adding a deposit changes account capital.
2. Adding a deposit does not create trading profit.
3. Adding a withdrawal does not create a trading loss.
4. TWR remains unaffected by external funding.
5. MWR changes appropriately with funding timing.

### 9.4 Unknown-P&L tests

A closed trade with `net_pnl = NULL` must:

- increase closed-record count;
- increase unresolved-P&L count;
- not count as a win;
- not count as a loss;
- not count as a scratch;
- not enter expectancy;
- not enter profit factor;
- not enter drawdown;
- not enter return.

### 9.5 Cost-reconciliation tests

For every trade:

```text
gross_pnl
- commission
+ swap
- other_costs
= net_pnl
```

Any unreconciled trade should carry a data-quality flag.

### 9.6 Time-boundary tests

Test:

- New York DST start;
- New York DST end;
- Sunday week open;
- Friday market close;
- month end;
- year end;
- Singapore display conversion.

All pages and endpoints must produce identical trading-day boundaries.

### 9.7 Attribution tests

The following lenses must reconcile to the same canonical net P&L:

- account;
- symbol;
- market;
- strategy;
- source;
- timeframe;
- session;
- direction;
- conviction;
- regime;
- exit reason.

### 9.8 Reporting metadata tests

Every generated report must include:

```text
account scope
start timestamp
end timestamp
timezone
sample count
unresolved count
data freshness
cash-flow coverage
calculation version
```

---

## 10. Recommended Report Layout

### Page 1 - Account Health

```text
Health state
Balance
Equity
Free margin
Margin level
Current drawdown
30D return
YTD return
Profit factor
Expectancy
Sortino
Data-quality warning
```

### Page 2 - Capital and Returns

```text
Balance curve
Equity curve
Cash-flow markers
Daily returns
Monthly return table
TWR
MWR/XIRR
Cumulative return
```

### Page 3 - Drawdown and Risk

```text
Current drawdown
Maximum balance drawdown
Maximum equity drawdown
Peak date
Trough date
Recovery date
Time underwater
Volatility
Sharpe
Sortino
Calmar
Recovery factor
```

### Page 4 - Trade Edge

```text
Trades
Win rate
Profit factor
Expectancy
Payoff
Average win
Average loss
Median result
Actual R
Planned R:R
MFE
MAE
Streaks
Holding time
```

### Page 5 - Cost and Execution

```text
Gross P&L
Commission
Swap
Spread cost
Slippage
Net P&L
Cost drag
Latency
Rejected orders
Fill rate
Execution by symbol
```

### Page 6 - Attribution

```text
By strategy
By symbol
By market
By direction
By timeframe
By session
By day and hour
By human versus bot
By conviction
By regime
```

### Page 7 - Stability and Process

```text
Rolling expectancy
Rolling profit factor
Alpha decay
Live-versus-backtest gap
Plan adherence
Manual intervention
Loss classification
Trade lessons
```

### Page 8 - System and Data Health

```text
Broker connection
API status
Controller heartbeats
Loop duration
Errors
Reconciliation freshness
Unresolved P&L
Duplicate candidates
Same-symbol clusters
Attribution coverage
Valuation coverage
```

---

## 11. Repository Components Worth Retaining

The following are meaningful strengths and should be integrated into the canonical report rather than replaced.

### Performance ledger

- [`agent/services/perf-ledger.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/perf-ledger.js)

### Risk management

- [`agent/services/risk.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/risk.js)
- [`agent/services/risk-reassess.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/risk-reassess.js)
- [`src/pages/Risk.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/pages/Risk.jsx)

### Strategy edge and decay

- [`agent/services/edge-watchdog.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/edge-watchdog.js)
- [`agent/services/alpha-decay.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/alpha-decay.js)
- [`agent/services/performance-breaker.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/performance-breaker.js)

### Trade review

- [`src/components/SessionReview.jsx`](https://github.com/ang-kl/bot-trade/blob/main/src/components/SessionReview.jsx)
- [`agent/services/loss-postmortem.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/loss-postmortem.js)

### Data integrity

- [`agent/services/trade-integrity.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/trade-integrity.js)
- [`agent/services/reconciler.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/reconciler.js)
- [`agent/services/pnl-backfill.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/pnl-backfill.js)

### Operational health

- [`agent/routes/state.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/routes/state.js)
- [`agent/loop.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/loop.js)
- [`agent/services/heartbeat.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/heartbeat.js)
- [`agent/services/error-log.js`](https://github.com/ang-kl/bot-trade/blob/main/agent/services/error-log.js)

---

## 12. Bottom Line

The repository already possesses several capabilities that many retail trading dashboards do not:

- deterministic pre-trade risk controls;
- per-strategy edge monitoring;
- automatic strategy disarming;
- alpha-decay analysis;
- entry-lag analysis;
- trade provenance;
- human-versus-bot attribution;
- post-loss review;
- duplicate-trade detection;
- same-symbol cluster detection;
- broker and controller health monitoring.

The main weakness is not the number of visible statistics.

The weakness is the absence of a canonical account-accounting layer beneath those statistics.

Until the following are implemented:

```text
historical balance
historical equity
external cash flows
complete account scoping
chronological ordering
unresolved-data treatment
true percentage returns
true equity drawdown
calculation versioning
```

additional metrics such as Sharpe, Sortino, Calmar and risk-of-ruin would look sophisticated but would not yet rest on a fully defensible foundation.

The correct priority is therefore:

> **Build the account ledger and valuation foundation first. Add advanced analytics second. Add more dashboard cards last.**

---

## Bibliography

1. **cTrader Analyze documentation**  
   Spotware Systems  
   Accessed 2 August 2026  
   https://help.ctrader.com/ctrader-analyze/ctrader-windows-analyze/

2. **MetaTrader 5 trading and testing reports**  
   MetaQuotes  
   Accessed 2 August 2026  
   https://www.metatrader5.com/en/terminal/help/trading/report

3. **GIPS Standards Handbook for Firms**  
   CFA Institute  
   Accessed 2 August 2026  
   https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/

4. **Commodity trading performance disclosure guidance**  
   US Commodity Futures Trading Commission  
   Accessed 2 August 2026  
   https://www.cftc.gov/foia/fedreg03/foi030313a.htm

---

## Audit Status

```text
Current reporting maturity: Intermediate
Trading-control maturity: Strong
Strategy-health maturity: Strong
Operational-health maturity: Strong
Account-accounting maturity: Incomplete
Professional performance-reporting readiness: Not yet sufficient
```
