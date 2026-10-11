# Predeclared comparison design (amendment area 5) and the dry-run receipt

Claude · № 13,117 · 11-10'26 12:5x SGT · claude-builder. Ordered by the owner
at 12:4x SGT 11-10: "Permission to run and test. Draft the area-5 comparison
design, then run the dry run." This document is written BEFORE any bar-form
cell exists, so the comparisons, metrics, splits and decision rules below are
fixed before the data can influence them. It changes no live policy; a
candidate it produces is a candidate for further testing, never a live
recommendation (amendment §5, last paragraph).

Two populations are covered, because the amendment's area 5 applies to both:

- **A. Stored-trade replays** (`/state/exit-counterfactual` extensions, the
  regime-gate tag): the trades the system actually opened.
- **B. The bar-form research job** (`POST /actions/bar-form-research`): bars
  built from recorded ticks, every registry strategy except tsmom.

## 1. Population A — stored-trade replays

### 1.1 Cohort and horizon (fixed)

- Clean bot trades of the last 90 days with a stored postmortem window;
  the **common cohort** of R1 (#1312): a trade is scored for a rule only if
  EVERY compared rule resolves it inside the stored window. Dropped counts
  are published per rule (`droppedFromCommon`).
- R denominator: `broker_sl_initial` (the reconciler's first observed stop).
  This is a **sensitivity** denominator until P1 provenance tags exist
  (area 3); every figure in A carries that label and no ranking in A is
  final before P1.
- Horizon: the stored window. 102 of 151 trades end before stop or target
  (truncation), so the common cohort is the resolvable minority; D0 (window
  extension) is the prerequisite for anything beyond a descriptive read.

### 1.2 Primary comparison (one, fixed)

- **Primary:** `managed_approx` (the live stack approximated) against
  `as_traded`, paired on the common cohort, metric **expectancy R**
  (mean R per trade). Everything else in A is exploratory.
- Costs: none in both arms (price at the level; declared as `costs: none`).
- Intrabar: a bar touching both stop and target is `ambiguous` and excluded
  from both arms (exit-replay rule).

### 1.3 Regime pattern (hypothesis, not a result)

- Classification: the regime label at entry (`label_regime`), with the
  trade-level gate tag (`gateTag`: would_block / would_pass / unknown,
  readings within 4 h before entry).
- Reported every time: the missing-regime count and share, by strategy,
  account, timeframe and period. Missing labels are a group of their own
  (`(none)` / `unknown`), never inferred fitting or against.
- The breakout "reversal" (breakouts better against the trend) is tested
  only as a within-family paired comparison (fitting vs against), on the
  common cohort, with the missingness beside it. Today's reading
  (would_pass 45, unknown 106 of 151) says the regimes table is too sparse
  to test it; the test waits for coverage, not for a better-looking cut.

### 1.4 Uncertainty and dependence

- Interval: normal approximation on the mean R, 95% lower bound
  `mean − 1.96·sd/√n` (the `expectancyLowerR` the code computes).
- Dependence is **reported, not corrected**: several accounts trade one
  opportunity (five accounts closed trades in the window), repeated signals
  share periods. The effective sample is therefore smaller than the trade
  count; no claim in A uses the trade count as independent n. A dedupe by
  (symbol, entry minute) is the first change if A ever needs a verdict.
- The 30-trade floor screens cells; it does not establish precision.

## 2. Population B — the bar-form research job

### 2.1 Data and scope (fixed for the small run)

| Item | Value | Source |
|---|---|---|
| Feed | `cpp_exec_demo` (the demo gateway's spool; one feed per run) | sidecar side name |
| Window | 10 sealed segments, 02-10 03:13Z → 09-10 15:25Z (640 MiB) | `GET /state/tick-segments` |
| Symbols | NATGAS (10055), AVGO.US (11668) | rule below |
| Forms | time 15 s, 30 s, **1 m (baseline)**, 5 m; tick≈1 m, tick≈5 m | `research.json` |
| Strategies | the 12 registry keys except tsmom | registry |
| Cells | 2 × 6 × 12 = 144 (cap 864) | plan |
| Minimum sample | 30 trades per cell (`tick-validation.json traded.minTrades`) | plan |

**Symbol selection rule (predeclared):** the two feed-universe symbols with
the most closed demo-account trades by registry strategies over the last 90
days, burn-in probes and tsmom excluded. Read at 12:50 SGT: NATGAS 60
(vp_value 20, rsi2 15, va 12, donchian 9), AVGO.US 17 (donchian 10). The
second symbol is a US stock with a 6.5 h session, so its 7-day sample will
be small; the rule stands and the cell reads INSUFFICIENT if it is.

### 2.2 Training / evaluation split (fixed)

- **Calibration (training only):** the first 2 segments
  (02-10 03:13Z → 02-10 18:14Z) calibrate N for the tick forms; they are
  excluded from EVERY form's evaluated bars (R2, `calibrationCutMs`).
- **Evaluation:** segments 3–10 (03-10 10:39Z → 09-10 15:25Z), split
  chronologically into two halves of equal trade count per cell
  (`byHalf.first`, `byHalf.second`). The second half is the **holdout**: a
  candidate must be selected on the first half and confirmed on the second.
- **Confirmation set:** the full run (up to 12 symbols, the owner's go) is
  the out-of-sample set for any candidate the small run names. Nothing
  selected on the small run is reported as a result before it.

### 2.3 Primary comparison and metrics (fixed)

- Unit of comparison: one (strategy, symbol) pair; alternative form vs the
  **1 m time bar built from the same ticks** (baseline).
- **Primary metric:** expectancy R, with its 95% lower bound. Secondary,
  reported never ranked on: PF_R, max drawdown R, tail share (top-decile
  share of gross wins), win rate, trades, runs replayed / too short.
- R: against the strategy's own stop at entry, fixed-R target when the
  preset sets one; price-based, no costs, fills at the level.
- Intrabar: `resolveExit` takes the stop first (at the worse of stop and
  open), then the target, then the time cap. Same rule in every arm.
- Tick forms carry the label `tick` with a nominal timeframe, so strategies
  that parse the label read no time cap; cells say so in their note. Fixed-N
  bar `v` is bar speed, a separate variant, never read as volume parity.

### 2.4 Decision rule (fixed; produces candidates, not conclusions)

A form is a **candidate** for a strategy when, on each symbol it was built
for:

1. both cells read OK (≥ 30 trades);
2. the alternative's expectancy lower bound exceeds the baseline's point
   expectancy;
3. both chronological halves of the alternative have higher expectancy than
   the baseline's corresponding half (no sign flip);
4. the broker cross-check for that symbol agrees on the Donchian volume-gate
   decision within the predeclared tolerances (`closeTolerancePoints` 20,
   `ratioTolerance` 0.15) when the strategy is Donchian; otherwise the
   cross-check is reported, not required.

Anything short of all four is "no candidate", including "promising".
Multiplicity: 5 alternatives × 12 strategies × 2 symbols = 120 comparisons;
at a 95% bound about six would pass rule 2 by chance alone, which is why
rules 3 and 4 and the confirmation set exist. The minimum detectable effect
(`mdeR` = 2·sd/√n) is printed per cell; a cell whose mdeR exceeds the
baseline's |expectancy| cannot distinguish the forms and is read as
inconclusive whatever its point values.

### 2.5 Regime and missingness in B

Each cell reports `byRegime` from the `regimes` table reading at or before
entry, at most 6 h old (`REGIME_MAX_AGE_MS`); older or absent readings are
`unknown` and counted. No cell is compared across regimes until the full run,
and only descriptively.

### 2.6 Dependence

Trades in one cell are a single chronological series on one symbol; cells on
the same symbol across forms share the same market periods, which is exactly
why the comparison is paired (same symbol, same window) rather than pooled.
The two symbols are treated as two replicates (rule 1–3 per symbol), not
pooled into one n.

## 3. What this design does not do

- It does not rank exit rules in A (area 4's common-cohort read stays
  descriptive until D0 and P1).
- It does not claim tick-count parity with the broker (area 2) until the
  cross-check has run on the small run.
- It does not change any gate, stop, target, sizing or management.

## 4. Dry-run receipt (the small run planned, nothing executed)

Posted at 04:52:01Z (12:52 SGT) with the `agent-secret` actor,
`dryRun: true`, after this design was fixed.

| Field | Value |
|---|---|
| Deployment | bot-trade commit 19b24a8 (version 0.1.381), Railway service `04945f5c…`, env `7bc0dfc6…` |
| Run id | `81666097-60e`, state `dry_run`, 04:52:01.992Z |
| Request | side `cpp_exec_demo`; symbolIds [10055, 11668]; 10 named segments `seg-1790910835488-000001` … `seg-1791529146884-000002`; crossCheck [10055]; no other override (`overridden: []`) |
| Listing | 30 sealed segments on the demo side, 1 reachable sidecar; the 10 named all listed |
| Plan | forms time_15000ms, time_30000ms, time_60000ms, time_300000ms, tick_approx_60000ms, tick_approx_300000ms; 12 strategies; cellBound 144 of maxCells 864; minSample 30 from `tick-validation.json` |
| Limits (declared, read from the config) | workerMemoryMb 2048, maxRuntimeMs 3,600,000, maxTempBytes 201,326,592, maxCells 864, maxTransactionRows 1,000, maxPullsPerMinute 30, maxSkippedTicksDelta 0, maxBusyShare10m 0.5, pollMs 30,000 |
| Names | 10055 → NATGAS, 11668 → AVGO.US (resolved from the demo side's first registered account's map) |
| Response | HTTP 200 in 0.56 s; "nothing pulled, replayed or written" |
| Before | fast monitor skippedTicks 0, skipped10m 0, busyShare10m 0.062 (04:50Z) |
| After | 04:52:22Z: job view running none, slot none, the dry run in history; stored runs 0, cells 0; fast monitor 0 / 0 / 0.063; segment cache 0 bytes on both sides |

The dry run established: the request is valid under the declared limits, the
side and segments resolve, the names resolve, the slot is taken and released,
and nothing reaches the gateway, the cache or the database. It does not
establish runtime, memory, pull rate or cross-check behaviour: those are the
small run's receipt (amendment §1 accept-when), which runs on the owner's
next word with the same request minus `dryRun`.

Conversation ref: ordered № 13,116 (owner "Permission to run and test") ·
reported № 13,117. Session
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.
