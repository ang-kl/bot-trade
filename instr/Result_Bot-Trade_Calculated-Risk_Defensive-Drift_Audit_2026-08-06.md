# Result — Calculated-Risk, Trade-Readiness and Defensive-Drift Audit

**Repository:** `ang-kl/bot-trade` · **Branch:** `main`
**Frozen SHA:** `29fefb30f97284977b7b03b8113c6876fc5abc46` · working tree clean
**Mode:** AUDIT-ONLY — no code, configuration, broker state or live setting was
changed; no order was placed, amended, cancelled or closed.
**Run:** 2026-08-06, 19:45 SGT (11:45 UTC)

---

## 0. Verdict

> **A — UNDER-DEFENDED, on the dimension that is actually losing the money.**

And the three-way frame does not fit cleanly, so the qualification is part of
the answer rather than a hedge:

| Dimension | Verdict | Evidence |
|---|---|---|
| **Position size** | **Under-defended** | the same 5,000-unit position on a $46k and a $2k account; 7.5× that account's own per-trade budget |
| **Repeat entry on a losing symbol** | **Under-defended** | `symbolCooldownMinutes` = 5 (default 240); three JPN225 shorts in 76 minutes cost −$10,488 |
| **Trade duration** | **Over-defended** | 60% of postmortems classify `time_cap`; median hold 31 minutes against a 1.6R target |
| **Entry breadth** | Proportionate *now* | 3.4% approval, 41 fills/day — but only since the R:R floors were reverted this morning |
| **Capital preservation floor** | Proportionate | equity stop 8%, drawdown de-risk 0.5× at −5%/24h, portfolio guards present |

The system is **not** primarily suffering from too many gates. It is suffering
from **two absent limits and one over-eager clock**. Adding safeguards is the
wrong response; restoring two defaults and lengthening one timer is the right
one.

---

## 1. The measurement that decides it

### 1.1 Where the money actually went (broker statements, 03–06 August)

Two accounts, 234 closed deals, taken from the broker's own statements rather
than from our database:

| | 19_02 | 19_03 (46130058) |
|---|---|---|
| deals | 69 | 165 |
| win rate | 27.5% | 29.7% |
| profit factor | **0.21** | **0.81** |
| realised | −4,073 | −4,867 |
| median hold | **32 min** | **31 min** |
| losses < $50 | 36 deals, **−447 total** | 54 deals, **−992 total** |
| **top 5 losses** | **−3,468 = 67% of all loss** | **−16,080 = 63% of all loss** |

**Hundreds of small losses are not the problem.** Every loss under $50 on both
accounts adds to −$1,439 — about 15% of the damage. Five trades account for
roughly two-thirds of it:

```
JPN225 −9,171.76   JPN225 −2,681.29   USDZAR −2,186.29
JPN225 −1,315.92   NatGas −1,049.40   USDX     −740.00
```

A per-symbol cutout at −$40 or −0.15%, the intuitive fix, would have saved a few
hundred dollars and stopped **none** of those six: each was past that threshold
within seconds of opening.

### 1.2 Repeat entry — the single most expensive control failure

```
JPN225 Sell  close 03-08 20:15:36 → next open 20:53:44   gap 38.1 min
JPN225 Sell  close      20:54:45 → next open 21:31:22   gap 36.6 min
```

`symbolCooldownMinutes` is configured at **5** against a code default of **240**;
`cooldownMinutes` (post-streak) at **5** against a default of 60;
`maxConsecutiveLosses` at **4** against a default of 3. Provenance from
`/state/risk-full`:

```
symbolCooldownMinutes  5   source manual   at 2026-08-05T06:52:51.247Z
cooldownMinutes        5   source manual   at 2026-08-05T06:52:51.247Z
maxConsecutiveLosses   4   source manual   at 2026-08-05T06:52:51.247Z
maxPositionsPerSymbol  3   source manual   at 2026-08-05T06:52:51.247Z
```

At the shipped default both re-entries are refused. **−$10,487.68 across the two
trades the default would have prevented.** The control is not broken; it is
turned down to five minutes.

`OWNER POLICY DECISION - NOT A CORRECTNESS FIX`

### 1.3 Duration — where the system IS over-defended

`/state/postmortems?days=7`, n = 30:

```
time_cap   18   (60%)
clean_win   7
gave_back   3
stop_hunt   2
```

**The dominant exit is the clock.** `burn-in.js` sets the cap from a volatility
plan — hot 12 min, active **30 min**, quiet 45 min, trending 120 min — while
`burn-in.js:237` sets the target at **1.6 × the stop distance**.

That is the defensive-drift finding in one line: **a 1.6R target with a
30-minute deadline.** On a 15-minute timeframe that is one or two bars of
favourable movement to travel 1.6R. Most positions cannot get there, so they
are closed by the clock at whatever small adverse number they happen to hold —
which is precisely the "hundreds of small losses" pattern, and equally the
reason winners never mature.

The 31-minute median hold in §1.1 is the same fact seen from the broker's side.

### 1.4 Entry breadth — proportionate, but only since this morning

`/state/opportunity-funnel?days=1`, before and after the R:R floors were
reverted at 07:18 UTC today:

| | 06:16 baseline | 10:19 |
|---|---|---|
| opportunities | 1,883 | 1,832 |
| approved | 17 (0.9%) | **62 (3.4%)** |
| ordered | 9 | 43 |
| filled | **7** | **41** |

Every `bad_rr` floor above 1.5 now has a `lastAt` in the past. For the period
this audit was commissioned to examine, entry was **severely over-defended** —
0.9% approval, 7 fills a day — but that specific condition was removed hours
ago and it would be misleading to report it as current.

Live blockers now:

```
profit ratchet halt                          583
negative_expectancy kelly_negative           433
overexposed_0005.HK                          267
overexposed_USD                              266
regime_block fade-vs-trend (rsi2_reversion)  116
```

`unknown_daily_pnl`, which was 69% of all vetoes a few days ago, has fallen out
of the top ranks.

---

## 2. Controls audit — which are load-bearing, which are theatre

Rule 10 of the prompt: a monitoring control is not a veto unless it blocks. Rule
11: a configured control is not effective unless its branch is reachable.

| Control | Configured | Reachable | Fires in production | Assessment |
|---|---|---|---|---|
| R:R floor (`minRR`) | 1.5 demo / 1.6 live | yes | now dormant above 1.5 | **proportionate today**; at 3.0 it vetoed 100% of proposals because strategies compute TP as a fixed multiple of SL |
| Per-symbol cooldown | **5 min** | yes | rarely — 5 min is shorter than the loop | **ineffective by configuration** |
| Consecutive-loss breaker | 4 | yes | did not fire on 3 JPN225 losses | **ineffective at this threshold** |
| Per-symbol position cap | 3 | yes | `overexposed_0005.HK` 267 | working |
| Duplicate-symbol gate | on | yes | yes | working |
| Equity stop | 8% | yes | not reached | proportionate |
| Drawdown de-risk | 0.5× at −5%/24h | yes | unverified this window | plausible |
| Profit keeper | on, arm $50, giveback 40%, trail 2.5 ATR | yes | `gave_back` 3 of 30 | see §3 |
| Time cap | 12–120 min by regime | yes | **18 of 30 exits** | **over-defended** |
| Protection audit | on | **stale 48h** | `lastAttemptAt: null` | **not effective — see §4** |
| Sizing / balance scope | new veto (#674, today) | yes | just deployed | closes the size hazard going forward |

---

## 3. Profit retention

`clean_win` 7 of 30, `gave_back` 3. The earlier Decision-Integrity audit measured
best-ever realised winner at **0.91R** and average winner at **0.15R** against
entry requirements of 1.5–1.6R. Two mechanisms compete for the same trade:

- the **profit keeper** arms at $50 profit and permits 40% giveback with a 2.5
  ATR trail — a swing-trade posture;
- the **time cap** closes at 30 minutes — a scalp posture.

They are not reconciled anywhere in the code. A position that arms the keeper at
$50 and then hits the 30-minute clock is closed by the clock; the keeper never
gets to do its job. **This is genuine defensive drift**: two individually
defensible controls whose combination has a behaviour neither intends.

---

## 4. Observability failures that hid all of the above

- **Protection audit stale 48 hours.** `/state/protection-audit` last ran
  2026-08-04 08:55 UTC, `lastAttemptAt: null`, while its heartbeat reports `ok`.
  It is the only check that reads the **broker's** stop rather than our belief
  about it. A control reporting health while its work product is two days old is
  worse than an absent control.
- **Disposition backlog 56,413 rows unsettled**, `counts {}`. The §70.8 sweep sat
  behind eight unguarded retention steps; one throw skipped it and the
  stamp-before-work schedule kept it skipped for eight hours at a time. Fixed
  today (#670/#671); first pass under the fixed code is 15:09 UTC.
- **Two of our own tables disagree about position size** — `trades` says 83.14
  and 3.45 where the broker holds 5,000 and 62 units.
- Until #671 shipped this morning, **no route could say who set a risk limit**.
  The §1.2 provenance block is the first time that question was answerable in one
  read.

---

## 5. Recommendations

All threshold changes are labelled as the prompt requires. None has been applied.

### 5.1 `OWNER POLICY DECISION - NOT A CORRECTNESS FIX`

1. **`symbolCooldownMinutes` 5 → 60–240.** Highest value single change in this
   audit; it alone would have prevented the −$9,171.76 trade.
2. **`maxConsecutiveLosses` 4 → 3**, and consider making it per-symbol — three
   losses on one instrument is a far sharper signal than three across the book.
3. **Reconcile the time cap with the target.** Either lengthen the cap so a 1.6R
   target is reachable, or lower the target to what 30 minutes can deliver.
   Holding both is the drift. Do not simply remove the cap — that converts
   time-capped small losses into stop-sized ones.
4. **Live account 42993489 holds USD 33.45.** It cannot meaningfully trade; decide
   whether it is funded or disabled.

### 5.2 Correctness work, no policy content

5. Make the protection audit's staleness loud — alert when the last verified
   reading exceeds a threshold, and surface it beside the heartbeat that
   currently contradicts it.
6. Resolve the `trades` vs `monitored_positions` volume disagreement; the risk
   gate reasons about a number the broker does not hold.
7. Make the cooldown veto print its own counterfactual (`configured 5m; last loss
   −$1,315 on this symbol 38m ago`) so a short window reads as a choice.

### 5.3 Explicitly NOT recommended

- **No new veto, gate or guard.** The audit's own question was whether
  safeguards have accumulated excessively; on entry breadth they had, and the
  answer to the remaining losses is not another gate.
- **No per-symbol $40 / 0.15% cutout as the primary fix.** Measured against the
  actual statements it would have saved a few hundred dollars and stopped none
  of the six trades that did the damage.
- **No relaxation of the equity stop, drawdown de-risk or portfolio guards.**
  None of them is implicated.

---

## 6. Scope and limits of this audit

Covered: baseline freeze, decision-path control inventory, veto-frequency
measurement, broker-statement reconstruction, exit-classification analysis,
configuration provenance, profit-retention analysis.

**Not** covered, and not claimed: counterfactual replay of the vetoed
candidates, walk-forward validation, and C++-versus-Node behavioural comparison.
Each needs the offline replay harness that is Phase 7 of the concurrent Verified
Defect Repair programme, and that programme's own precondition — reliable trade
origin — shipped only hours ago. Any number produced today would be computed
over `legacy_unattributed` rows the repair prompt explicitly forbids using as
evidence of strategy edge.

**No live trading action was taken.**
