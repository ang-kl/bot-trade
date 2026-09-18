# Strategy target review — 02-09-2026

**Recommendations only.** Nothing in this document or in the report behind it
changes what a strategy proposes or what the gate admits. `HARD_MIN_RR` (3.0),
`STRATEGY_MIN_RR` (`rsi2_reversion: 1.0`), every strategy's take-profit rule
and every position-manager trigger (partial at ~1R, break-even at 0.7R, runner
trail from 2.5R, bank at 4R) are untouched by PR B. A change to any of them is
a separate, owner-approved diff.

## What the review reads

`GET /state/target-review?days=30&account=<id|all>` →
`agent/services/target-review.js`. Read-only; the module imports the gate's
constants, the earned-floor prior and the exit-counterfactual population, and
no strategy module or manager (pinned by `target-review.test.js`).

Three readings per strategy:

1. **Proposed** — the gate's own rounded `checks_json.rr` per distinct
   opportunity over the window (latest decision wins; post-approval refusals
   excluded): median, p25/p75, the share below the 3.0 hard floor, the share
   below the strategy's own floor, `bad_rr` vetoes, approvals, earned-floor
   admits (and how many were prior admits). Reported only at ≥20 opportunities
   with a measured rr.
2. **Prior** — the shrunk win rate `W′` the earned floor already reports
   (`earnedFloorPriorReport`, k = 20, pooled or per account when scoped), and
   from it: `E(rr) = W′·rr − (1 − W′)` at the declared target, at the median
   proposal and at 3.0; `breakEvenRr = (1 − W′)/W′`;
   `rrForMinE = (minE + 1 − W′)/W′`; whether the prior would admit at the
   declared target (`E > minE`, minE 0.1).
3. **Realised** — the exit-counterfactual population (clean bot origins with a
   stored bar window), the same summariser, R quantiles, the share of closes
   that reached the declared R, and the `trail_0.5R` / `trail_1R` / `tp_1R`
   replays on the same trades. Reported only at ≥30 usable closes.

## Declared targets (transcribed from the strategy modules)

| strategy | tp1 | own floor |
|---|---|---|
| rsi2_reversion | 1.2 × stop (tp2 2.2) | 1.0 |
| ema_pullback | 2R (tp2 3R) | 1.5 |
| vwap_trend | 2R | 1.5 |
| fib_confluence | 2R | 1.5 |
| donchian_breakout | range height | 1.5 |
| va_breakout | value-area height | 1.5 |
| fib_618_fade | swing origin | 1.5 |
| vp_value | point of control | 1.5 |
| rsi_meanrev | SMA20 | 1.5 |
| fvg_retrace | impulse extreme (≥1.5R) | 1.5 |
| cup_handle / inv_cup_handle | measured move | 1.5 |

"Own floor" is `minRrFor(strategy, STRATEGY_PREFILTER_RR)` — the lowest ratio
the earned floor may ever admit for that strategy.

## The 19:40 SGT reading (prior side, from production)

Source: `GET /state/earned-floor?prior=1` on the deployed build, sweep at
11:31 UTC, `autopilot_strategy_prior_json`, k = 20, minE 0.1, **pooled** W′.
The proposal and realised columns come from the route this PR adds and are
filled in after it deploys (see "Open" below) — they are not estimated here.

| strategy | declared | W′ (pooled) | E at declared | E at 3.0 | break-even rr | rr for E ≥ 0.1 | prior admits at declared? |
|---|---|---|---|---|---|---|---|
| rsi2_reversion | 1.2 | 48.0% | **+0.056** | +0.92 | 1.08 | 1.29 | **no** (pooled); AUDUSD admit was on ACCT-DEMO-1's scoped W′ 52.5%, E +0.154 |
| ema_pullback | 2 | 32.8% | −0.016 | +0.31 | 2.05 | 2.35 | no |
| vwap_trend | 2 | 39.2% | +0.176 | +0.57 | 1.55 | 1.81 | yes (strategy is disarmed) |
| fib_confluence | 2 | 17.2% | −0.484 | −0.31 | 4.81 | 5.40 | no — negative even at 3.0 |
| donchian_breakout | measured | 26.8% | — | +0.07 | 2.73 | 3.10 | no |
| va_breakout | measured | 25.8% | — | +0.03 | 2.88 | 3.26 | no |
| fib_618_fade | measured | 39.4% | — | +0.58 | 1.54 | 1.79 | — (off) |
| vp_value | measured | 33.5% | — | +0.34 | 1.99 | 2.28 | — |
| rsi_meanrev | measured | 47.1% | — | +0.88 | 1.12 | 1.34 | — |
| fvg_retrace | measured | 31.7% | — | +0.27 | 2.16 | 2.47 | — (off) |
| cup_handle | measured | 16.7% (n=6) | — | −0.33 | 4.99 | 5.59 | no — six backtest trades |
| inv_cup_handle | measured | 0% (n=6) | — | −1.00 | — | — | degenerate prior |

## Reading it

- **rsi2_reversion.** The declared 1.2R target does NOT clear minE on the
  pooled prior: E +0.056 against a 0.1 bar, break-even 1.08R. The first prior
  admit (AUDUSD, 19:12 SGT) went through on the account-scoped W′ of 52.5%
  (E +0.154), which is the reading the gate uses. Two views, the same
  formula, either side of the bar — which is exactly why the recommendation is
  **no change, measure the cohort**: 1.2 is close enough to break-even that
  only the realised closes can settle it. What would change my mind: 30
  rsi2 closes with realised E below 0 at a median R near 1.2, or above 0.1.
- **ema_pullback.** At its own 2R the prior says −0.016: the declared target
  does not pay on the backtest win rate, and 3.0 is where E turns positive.
  **No change**; this is the strategy the 3.0 floor is protecting from its
  own target, and the cohort read should confirm or refute it before anyone
  touches the 2R constant.
- **fib_confluence, cup_handle.** Negative at every ratio under 3.0 and at 3.0
  itself. **The floor is doing its job.** Nothing to widen.
- **donchian_breakout, va_breakout.** Break-even sits at 2.7–2.9R and E at 3.0
  is a hair above zero. A measured-move target below ~3R has no expectancy on
  the prior; the review will show what share of proposals the hard floor
  removes once the route deploys. **No change.**
- **vwap_trend.** The one fixed-2R strategy that pays on the prior (E +0.176),
  and it is disarmed on the owner's order (02-09). The review is the argument
  for re-arming it later, not a change now.
- **rsi_meanrev, vp_value, fib_618_fade, fvg_retrace.** Price-level targets;
  the proposal median is the reading, and there are not yet 20 opportunities
  with a measured rr for any of them in the window. **Insufficient**, said so.

## What the floor removes

`shareBelowHard`, `badRrVetoShare` and `admissibleOnPrior` (proposals with
`ownFloor ≤ rr < 3` whose `E(rr) > minE`) are reported per strategy beside
`earnedFloorAdmits`. This is the count of flow the 3.0 floor turns away that
the prior would have taken — the number the widening decision needs, and one
that did not exist before this PR.

## Open

- Fill the proposal and realised columns from the deployed route (first
  reading after PR B deploys; then daily beside the prior-cohort watch).
- The realised block needs 30 usable closes per strategy; none has that today
  on the clean-origin, bars-present population. `insufficient` is the honest
  reading until then.
- `inv_cup_handle` and `cup_handle` priors rest on six backtest trades each;
  treat their rows as absent.
