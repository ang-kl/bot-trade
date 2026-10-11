# Theory-gap programme — measured report after steps 1–8

Claude · № 13,098 · 11-10'26 10:10 SGT · claude-builder. The plan the owner
approved at № 13,093 (measure first; live trade management, gates and loop
untouched). Every figure below was read from production routes merged this
morning (#1308, #1309, #1310; 005f9c07 live at 09:57 SGT), over the trades
the system actually opened. Nothing here changes a gate, a stop or a target;
each row ends in a decision that is the owner's.

## 0. Engineering status

| Step | What | PR | State |
|---|---|---|---|
| 1 | protected-boundary script, isolation test, `agent/config/research.json` | #1308 | merged, live |
| 2 | B6 R-field audit `GET /state/theory-gap?section=r-audit` | #1309 | merged, live, read back |
| 3 | additive exit-replay rules (partial at R, Chandelier, exit at mean, follow-through) + golden | #1309 | merged |
| 4 | `GET /state/exit-counterfactual` extensions B1–B4 (stop basis, own target, presets, groups, follow-through); legacy JSON identical | #1309 | merged, live, read back |
| 5 | B5a regime-block counts `section=regime-blocks` | #1310 | merged, live, read back |
| 6 | `agent/lib/tick-bars.js` (time bars and N-tick bars from recorded ticks) | #1310 | merged |
| 7 | `runBacktest` research options (R stats, fixed-R target, compute window) + golden | #1310 | merged |
| 8 | the bar-form research job (streaming segments, worker, two tables, routes, abort) | #1311 | open, gate and CI running; nothing runs until the owner posts |
| 9 | broker cross-check of tick bars; trade-level regime-gate tag (B5c) | local, behind #1311 | built and tested |

Protected boundary: 43 paths identical to main on every PR. The bar-form
job has NOT been run: a dry run, then the small run (2 symbols × 1 week),
each on the owner's word, with the before/after read-back the plan names.

## 1. The instrument's own limit, first

The exit replays run over the bars stored with each loss postmortem. Over the
last 90 days, 151 clean bot trades are replayable; **102 of them (68%) run
past the end of their stored window before the stop or the target is
reached.** The as-traded rule can score only 51 of 151. Every per-strategy
sample below is therefore small and truncated; the pooled view is the only
one above the 30-trade floor, and even it is a bar-close approximation (the
tick-level Chandelier, broker trailing, the hybrid tick trigger and partial
fill prices are not in the bars).

Decision for the owner (D0): extend the stored windows
(`/state/aftermath-extend-preview` already prices it; an apply is a write
the owner approves), or accept that follow-through past about two hours is
not measurable from today's record.

## 2. B6 — which tsmom R figure is right (r-audit, 365 days, 57 trades)

| Stop the R is measured against | Available | Win rate | PF_R | Expectancy | Net R |
|---|---|---|---|---|---|
| the broker's initial stop (`broker_sl_initial`) | 56 | 26.8% | **0.60** | −0.19R | −10.8 |
| the proposal's stop (risk event) | 53 | 26.4% | 0.47 | −0.26R | −13.8 |
| the monitor's `initial_risk` | 56 | 26.8% | 0.59 | −0.18R | −10.0 |
| the postmortem's stop (trailed) | 56 | 26.8% | 1.45 | +0.25R | +13.9 |
| `trades.sl_price` now (trailed) | 56 | 26.8% | 1.45 | +0.25R | +13.9 |

39 of 56 postmortems divided by a stop the momentum book had already
trailed; the ledger and the postmortem disagree on 37 of 56. **The true
tsmom result against the risk taken at entry is PF 0.60, not 1.45.** The
"PF 2.8" of the earlier review was this inflation. Decision D1: the
postmortem's R should divide by the broker's initial stop (a record fix, not
a trading change; it touches `loss-postmortem.js`, which is not protected but
is a live writer, so it is ask-first).

## 3. B5a — what the regime gate refuses (30 days)

| Refusal kind | Cycles | Episodes |
|---|---|---|
| fade-vs-trend (a mean-reversion fade against a trend) | 4,614 | 278 |
| trend-vs-trend (a breakout/trend signal against the daily trend direction) | 2,815 | 385 |
| trend-in-quiet (the QUIET rule) | 108 | 17 |

QUIET refusals, the owner's worry for the breakout strategies, are rare:
Donchian 5 episodes, value-area 2, VWAP 6, EMA 4. The large refusal on the
breakout side is **trend-vs-trend**: Donchian 121 episodes, VWAP 91, VA 87,
EMA 81 in 30 days — the daily trend direction vetoing an intraday signal the
other way. Nothing refused is scored: the stored detail carries bias, side
and entry only (stop, target, conviction are not recorded). Decision D2:
capture those three fields forward in `recordRegimeBlock` (logging only, but
it touches the loop's write path), so the next 30 days of refusals can be
scored; or leave it.

## 4. B1–B4 — exits over the same 151 trades (90 days, R against the broker's initial stop)

Actual, from the ledger: 145 scored, win rate 29%, PF 0.52, −0.17R.

| Rule (bar-close replay) | Scored | Truncated | Win rate | PF_R | Expectancy |
|---|---|---|---|---|---|
| as traded (stop and the stretched target) | 51 | 100 | 3.9% | 0.16 | −0.81R |
| the strategy's OWN target (pre-stretch, from the risk event) | 51 | 95 | 5.9% | 0.18 | −0.77R |
| own target + 0.5R trail | 78 | 68 | 55.1% | 0.72 | −0.13R |
| the live stack approximated (0.5R trail, +1R half for reversion, 2R half for the rest, Chandelier 3×22) | 98 | 53 | 44.9% | 0.67 | −0.11R |
| fixed +1R target | 76 | 75 | 42.1% | 0.73 | −0.16R |
| exit at the 20-bar mean | 108 | 43 | 36.1% | 0.31 | −0.20R |
| Chandelier 3×ATR(22) alone | 88 | 63 | 29.5% | 0.43 | −0.26R |
| half at 2R + 0.5R trail (the hybrid) | 78 | 73 | 53.8% | 0.65 | −0.16R |
| 120-minute time cap | 109 | 42 | 38.5% | 0.62 | −0.11R |

Readings, each with its limit:

- The live stack's approximation (PF 0.67) reproduces the actual (PF 0.52)
  only roughly: the bars cannot see the tick-level trail and the fills.
- Nothing replayed is above breakeven on this population. The strategy's
  own target is no better than the stretched one when held to the end: the
  trades do not travel. Follow-through confirms it as a bracket: +1R was
  reached for certain in 3% and at most in 71% of entries — the bracket is
  that wide because of the truncation in §1.
- Mean reversion (38 trades): exit-at-the-mean PF 0.33 is WORSE than the
  live stack's 0.56. The theory's exit does not help these entries.
- Breakouts (27 trades): Chandelier alone PF 0.79 against the stack's 0.65,
  on 12 scored trades — a direction, not a result.
- The largest clean group is the burn-in probes (79): live stack PF 0.91.

Per strategy, no sample reaches the floor (Donchian 22, VP 15, RSI 12, RSI2
11, tsmom 5, VA 4, FVG 2, cup 1). Decision D3: none of the exit options is
supported by data yet; the honest next step is D0 (longer windows) and the
bar-form run, not a management change.

## 5. Correlation (¶B·2), restated with the audited R

Using the regime at entry (the gate's own theory): mean-reversion entries in
a fitting regime PF_R 0.78 against 0.16 when against it; trend/breakout
entries 0.12 fitting against 0.52 against (523 closes, № 13,089). Step 9's
`gateTag` will put the gate's would-block verdict on every trade so this can
be read per rule once #1311 and step 9 are live.

## 6. Decisions the owner holds

| # | Decision | Touches live? |
|---|---|---|
| D0 | extend the stored postmortem windows | a write to the postmortem store; ask-first |
| D1 | postmortem R divides by the broker's initial stop | a record writer; ask-first |
| D2 | capture stop/target/conviction on regime refusals | the loop's write path; ask-first |
| D3 | any exit or R:R change | protected; not proposed on today's evidence |
| D4 | run the bar-form job: dry run, then small run | research only; owner's word |

Conversation ref: ordered № 13,093 · reported № 13,098. Session
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.

## 7. Corrections after the #1311 deploy (Claude · № 13,102 · 11-10'26 10:40 SGT)

Read from production at 02:37:35Z on commit 67f3227 (the Codex P1 fix on
follow-through live), over the same 151 clean trades of the last 90 days,
R against the broker's initial stop. The §4 follow-through line is
superseded by this table; the rest of §4 stands with the amendment review's
caveats (`docs/amendment-review-2026-10-11.md`).

| Level | Reached for certain | Possibly reached (window ended first) |
|---|---|---|
| +1R | 32 of 151 (21.2%) | 107 (70.9%) |
| +2R | 9 (6.0%) | 103 (68.2%) |
| +3R | 4 (2.6%) | 103 (68.2%) |

The earlier "3.3% for certain" at +1R was the defect the review caught
(a window that ended before the stop but had already touched +1R was not
counted); 21.2% is the corrected lower bound. The bracket stays wide because
102 of 151 windows end before stop or target (§1).

The trade-level regime-gate tag (step 9, B5c) reads: would_block 0,
would_pass 45, unknown 106. "Unknown" means no regime reading for the symbol
within four hours before entry — 106 of 151 trades. The regimes table is
too sparse to tag most entries; this is a data-coverage fact for area 5,
not a result.

Fast monitor after the deploy: 0 skipped ticks, busy share 0.161 over the
first ten minutes after restart (baseline 0.064 before it).

Conversation ref: reported № 13,102.

## 8. Common-cohort read after the #1312 deploy (Claude · № 13,105 · 11-10'26 11:06 SGT)

Read at 03:05:21Z on commit f47ecb7, 90 days, R against the broker's
initial stop, with the remediation's common cohort live: the rows EVERY
compared rule resolves inside its stored window, 51 of 151.

| Rule | Scenario | Headline (rows it resolves) | Common cohort (51) |
|---|---|---|---|
| as traded | fixed | 51 scored, PF 0.16, −0.81R | PF 0.16, −0.81R |
| fixed +1R target | fixed | 76 scored, PF 0.73 | PF 0.16, −0.73R |
| live stack approximated | current policy | 98 scored, PF 0.67 | PF 0.20, −0.49R |
| exit at the 20-bar mean | fixed | 108 scored, PF 0.31 | PF 0.05, −0.53R |
| Chandelier 3×ATR(22) | fixed | 88 scored, PF 0.43 | PF 0.23, −0.55R |

The headline spread between rules (PF 0.16 to 0.73) collapses on the
common cohort (0.05 to 0.23): the rules that looked better were mostly
resolving MORE trades, not resolving the same trades better, and the
common cohort is the subset that reached a stop or target inside a window
that ends early for most winners. This is the amendment's area-4 point
shown in numbers: on today's record no exit rule can be ranked, and the
instrument (the stored window) is what has to change first (D0).

Operational: the fast monitor read 0 skipped ticks and a busy share of
0.529 in the ten minutes after the deploy restart (0.064 before it). The
proposed research limit `maxBusyShare10m` 0.5 would therefore abort a run
started inside a restart's first ten minutes; either the ceiling or a
"no run within N minutes of a restart" rule is the owner's call.

Conversation ref: reported № 13,105.
