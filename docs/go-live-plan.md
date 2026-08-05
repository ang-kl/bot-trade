# Go-live plan — the 12 Aug 2026 decision

Owner's gate: **win% > 68% and profit factor > 1.68** before live trading starts
on 12 Aug 2026.

Everything below is measured, not estimated. Source and timestamp are given for
each figure so it can be re-run and disagreed with. Measured 05-08-2026 ~07:30
SGT against production (`sg-trade.up.railway.app`).

---

## 1. Where we actually are

`GET /state/perf-ledger?account=all` — 30-day window, which is also the 3M/6M/12M
window because there is no older data:

| | n | net | win% | PF | planned R:R | break-even win% | edge |
|---|---|---|---|---|---|---|---|
| **All, 30D** | 450 | **−$4,934.65** | **32.9** | **0.89** | 1.93 | 34.1 | **−1.2** |
| 43097342 | 70 | +$405.92 | 21.4 | 2.45 | 2.21 | 31.1 | −9.7 |
| 46130058 | 211 | −$3,775.07 | 30.3 | 0.87 | 1.89 | 34.6 | −4.3 |
| 47790949 | 166 | −$1,623.77 | 40.4 | 0.90 | 2.02 | 33.1 | +7.2 |

Two things in that table matter more than the headline.

**The system was profitable last month and is not this month.** Same accounts,
same code lineage:

| window | n | net | win% | PF | edge |
|---|---|---|---|---|---|
| Last month | 187 | **+$3,051.58** | 42.8 | **1.22** | +10.9 |
| Month to date | 263 | **−$7,986.23** | 25.9 | **0.74** | −9.8 |

A 17-point win-rate collapse inside four weeks is not strategy drift. It is
closer in time to the duplicate-cluster incidents (0066.HK ×9 on 02-08,
0005.HK ×6 on 03-08, DOW.US ×17 on 04-08) than to anything else that changed.

**We are 1.2 points from break-even, not 35 points from the target.** The gate
is stated as 68% / 1.68, but break-even at the current R:R is 34.1% and we are
at 32.9%. The distance to *not losing money* is small. The distance to the gate
as written is a different question, and §2 is about why.

---

## 2. The gate as written cannot be satisfied

Profit factor and win rate are not independent. With `R` = average
reward-to-risk and `w` = win fraction:

```
PF = (w / (1 − w)) × R
```

At our current R of 1.93:

- **68% win rate ⇒ PF = 4.10.** Not 1.68 — more than double it.
- **PF of 1.68 ⇒ 46.5% win rate.** Not 68%.

So "68% **and** 1.68" is, at this R:R, a demand for PF ≥ 4.10. The two numbers
describe two different systems:

- **68% win** is the signature of a mean-reversion book: many small wins, few
  larger losses, R below 1.
- **PF 1.68 at 33% win** is the signature of a trend/breakout book: few large
  wins, many small losses, R above 2.

Ours is currently the second kind (33% win, planned R 1.93) being measured
against a target written for the first.

**Both can hold at once, but only in a specific band.** Requiring w ≥ 0.68 and
PF ≥ 1.68 together implies:

```
R ≥ 1.68 × (1 − w) / w  =  1.68 × 0.32 / 0.68  =  0.79
```

**A coherent restatement of the gate: win ≥ 68% with R:R ≥ 0.79.** That is a
real, buildable target — and it is a mean-reversion target, not a fade of the
current book.

We have exactly one strategy with that shape already:

| strategy | n | win% | PF | planned R:R | net |
|---|---|---|---|---|---|
| **rsi2_reversion** | 9 | **66.7** | 0.64 | 1.39 | −$234.64 |
| fib_618_fade | 69 | 29.0 | 0.63 | 2.29 | −$4,000.07 |
| vwap_trend | 23 | 39.1 | 0.57 | 1.95 | −$498.29 |
| ema_pullback | 14 | 35.7 | **0.10** | 2.15 | −$2,733.47 |
| donchian_breakout | 3 | 33.3 | 0.54 | 3.16 | −$258.68 |

`rsi2_reversion` is already hitting 66.7% win on 9 trades. Its PF is 0.64 only
because its average loss (−$215.85) is three times its average win ($68.82) —
i.e. its **exits**, not its entries, are what fail. That is a smaller, more
tractable problem than raising a 29% win rate to 68%.

**Decision required from the owner (§6, D-1).** Nothing below assumes an answer.

---

## 3. What is actually stopping trades

`GET /state/veto-breakdown?days=7`. Approval rate **2.3%** — 1,245 approved
against 52,543 vetoes and 5,404 upstream skips. Grouped into families:

| count | share | cum | guard |
|---|---|---|---|
| 30,806 | 53.3% | 53.3% | `unknown_daily_pnl (account)` |
| 11,946 | 20.6% | 73.9% | `daily_loss_limit_hit` |
| 2,253 | 3.9% | 77.8% | `bad_rr` (all thresholds) |
| 1,840 | 3.2% | 81.0% | strategy `fib_confluence` is OFF |
| 1,761 | 3.0% | 84.0% | `insufficient_equity … usd_per_lot_unknown` |
| 1,645 | 2.8% | 86.9% | strategy `vwap_trend` is OFF |
| 1,370 | 2.4% | 89.2% | `insufficient_equity` (other) |
| 1,240 | 2.1% | 91.4% | weekend quiet hours |
| 966 | 1.7% | 93.0% | `overexposed_0005.HK` |

**Three quarters of everything is two guards, and neither is a strategy
judgement.**

`unknown_daily_pnl` is the biggest single fact about this system right now. Its
own example text, captured live:

> `17 closed trade(s) today have no realised P&L after 15m (oldest 2026-08-04 17:59:45)`

Seventeen, closed at 17:59:45 on 04-08. **That is the DOW.US cluster.** The
incident fixed in #639/#640 is the direct cause of the largest block in the
system: one runaway produced seventeen closes whose broker deal history had not
filled, and the guard then refused every new entry account-wide, 30,806 times.

`daily_loss_limit_hit` example: `pnl=-1464.13 limit=1455.21` — which is exactly
47790949's realised loss yesterday. The account traded into its cap and stopped,
correctly.

`fib_618_fade` / `fib_confluence` is both the worst-performing strategy by net
(−$4,000) *and* the one that produced all three duplicate clusters. It is
currently disarmed, which is why 1,840 of its signals are being skipped
upstream.

---

## 4. What we cannot currently measure — and must, before certifying anything

**56 of 190 decidable closed trades (29.5%) carry a `net_pnl` whose sign
contradicts their own `side`, `entry_price` and `exit_price`.** Examples:

| id | symbol | side | (exit−entry)×dir | booked net |
|---|---|---|---|---|
| 702 | JPN225 | BUY | −152.80 | **+$14,259.55** |
| 641 | JPN225 | SELL | +2.60 | **−$9,171.76** |
| 737 | JPN225 | SELL | +72.90 | −$2,681.29 |
| 624 | JPN225 | SELL | +17.70 | −$1,315.92 |

A long that exits 152.8 points below its entry cannot make money.

**This is a price-recording defect, not a P&L defect — and the distinction
matters.** `perf-ledger.js:98` classifies a win by `tr.pnl > 0`, and `net_pnl`
comes from the broker's deal history, which is authoritative for money. So
**win%, PF and net are trustworthy.** The net carried by all 56 contradicted
rows is only +$85.51 — they largely cancel.

What is *not* trustworthy is `exit_price`, on roughly a third of closed rows.
`closeTradeRow` (`db.js:1286`) writes `exit_price = COALESCE(?, exit_price)`,
and for a broker-side close the reconciler supplies a value that is not the fill.
Two consequences, both load-bearing for the gate:

1. **Realised R:R cannot be computed at all.** Every R figure we have is
   *planned* R — `perf-ledger.js:85-89` derives it from `entry`/`sl`/`tp`, i.e.
   from the bracket we set, not from where the trade actually ended.
2. **Therefore `edge = winPct − requiredWinPct` compares a REALISED win rate
   against a PLANNED break-even.** That is only valid if realised R matches
   planned R.

It does not. Of 240 closed trades:

| exit route | n | share |
|---|---|---|
| take profit | 98 | 40.8% |
| **time cap** | 60 | **25.0%** |
| stop loss | 28 | 11.7% |
| LLM thesis-invalidation (many distinct reasons) | ~40 | ~17% |
| stale reconcile / already closed / equity stop / loss cap | 14 | 5.8% |

**Only 52.5% of trades reach a bracket.** The other 47.5% are cut early — a
quarter of the whole book by time cap alone. Early exits truncate winners more
than losers, so **realised R is below planned R of 1.93, the true break-even
win rate is above 34.1%, and the true edge is worse than the −1.2 we report.**

We do not currently know by how much. That is the gap that has to close before
any number can certify a go-live.

---

## 5. The plan

Ordered so that each step makes the next one measurable. Nothing here changes a
risk limit without the owner naming it.

### Phase 0 — make the numbers mean something (blocking; ~2 days)

Without this, every later measurement is unfalsifiable.

- **P0-1. Fix `exit_price` on broker-side closes.** Take the fill price from the
  broker deal history in the same backfill pass that already supplies `net_pnl`,
  rather than from a reconcile snapshot. Then backfill the 56 contradicted rows.
  *Done when:* the sign-consistency check in §4 reports 0 contradictions on new
  closes, and the historical set is repaired or explicitly written off.
- **P0-2. Record realised R alongside planned R.** Add `realised_rr` at close
  (`(exit−entry)×dir ÷ |entry−sl|`) and make `requiredWinPct` and `edge` read it.
  *Done when:* `/state/perf-ledger` reports both, and `edge` compares like with
  like.
- **P0-3. Split the exit-route table into the ledger.** 25% time-cap exits is a
  finding, not a footnote; it should be a column the owner sees, per strategy.

### Phase 1 — stop the self-inflicted blocking (~1 day)

- **P1-1.** `unknown_daily_pnl` at 30,806 is a *consequence* of the DOW.US
  cluster, already fixed in #639/#640. Re-measure the veto breakdown 48h after
  those deploys; if it has not collapsed, the age-out ladder (#180) is still
  parked on its 6-hour rung and needs the unresolvable rows written off.
- **P1-2.** Decide `fib_618_fade` / `fib_confluence`. It is the worst strategy by
  net (−$4,000, PF 0.63), it caused all three duplicate clusters, and it is
  currently OFF while still generating 1,840 skipped signals a week. Either
  re-arm it with the #640 ceiling proven, or retire it and stop scanning for it.
- **P1-3.** `insufficient_equity … usd_per_lot_unknown` (1,761) is a missing
  quote-conversion, not a risk decision. It is also fragmenting the veto
  breakdown into 296 distinct guard strings because `risk_budget=$N` is not
  templated — which hid this family's true size until it was aggregated by hand.

### Phase 2 — decide which system we are building (owner, then ~1 week)

Depends entirely on **D-1** below.

- **If mean-reversion (win ≥ 68%, R ≥ 0.79):** the work is `rsi2_reversion`'s
  exits, not its entries — 66.7% win already, but average loss 3.1× average win.
  Tighten the stop or cap the loss, re-run, and require n ≥ 100 before believing
  the win rate.
- **If trend (PF ≥ 1.68 at ~33% win, R ≥ 3.4):** the work is raising realised R,
  which means the time cap (25% of all exits) and the LLM invalidation closes,
  not the entry gates.

### Phase 3 — certify (~3 days, cannot start before Phase 0 lands)

- Minimum **n = 200 closed trades** per account on the chosen configuration,
  with realised R recorded and 0 sign contradictions.
- Gate evaluated on the corrected numbers, per account, not pooled.
- Live start requires the owner to enable it explicitly. **Account 42993489 is
  live and is not touched by any step in this plan.**

---

## 6. Honest read on the 12 Aug date

Today is 05-08. That is **7 days**.

Phase 0 alone is ~2 days, and it is genuinely blocking: certifying a
68%/1.68 gate against a dataset where a third of rows disagree with themselves
and R:R is planned-not-realised would be certifying a number we know is wrong.
Phase 2 needs enough closed trades to have a win rate worth believing —
`rsi2_reversion` currently has **nine**.

**The measured position: the system is at PF 0.89 and 1.2 points below
break-even, on numbers that flatter it. It is not close to any reading of the
gate, and seven days is not enough to get there honestly.**

The recommendation is to keep the 12 Aug date as a **review** date rather than a
start date: land Phase 0 and Phase 1, re-measure on corrected numbers, and let
that measurement set the start date. That is a slip of the date, and it is the
owner's call, not this document's.

---

## Decisions required from the owner

- **D-1.** Restate the gate. "68% and 1.68" implies PF ≥ 4.10 at our R:R. Either
  (a) **win ≥ 68% with R:R ≥ 0.79** — the mean-reversion build, or (b) **PF ≥
  1.68 at the win rate the book actually produces** — the trend build. Phase 2
  cannot start without this.
- **D-2.** `fib_618_fade` — re-arm or retire (P1-2).
- **D-3.** Move 12 Aug from a start date to a review date, or hold it and accept
  starting on uncertified numbers.
- **D-4.** Still open and unrelated to this plan: A1 (`minRR` 6.16 on 43097342),
  the parked A2 `dailyLossPct` on 43097342 (task #192), credential rotation, and
  the 5268549 cTrader OAuth.
