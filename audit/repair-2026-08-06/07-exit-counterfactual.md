# 07 — Offline exit counterfactual

Phase 7 of the Verified Defect Repair programme. Harness shipped in #680 at
`cf2dbf9e01e3ede657a8d3c0b1c6d0d0f1849784`.

## Status: `NOT RUN — SAMPLE DOES NOT YET EXIST`

This document exists so the gap is recorded rather than implied by an absent
file. Phase 7 asks for expectancy, mean and median R, win rate, drawdown, tail
loss, giveback, holding time and confidence intervals across eight replay
policies. **None of those numbers appear below, because none has been
measured.**

## Why it cannot be run today

The replay is only evidence if the trades it replays are clean-origin — that
is, trades whose origin and strategy provenance were recorded at entry rather
than inferred afterwards. Clean-origin rows began to exist when **#673 merged
on 2026-08-06**. Before that, closed trades are `legacy_unattributed`, and
#673's own rule is that unattributed history is labelled, not fabricated.

The harness enforces this itself: `cleanOnly` defaults to true, and
`--all-origins` prints a label saying its output is **not** evidence of
strategy edge.

## Measured, so that the state is not merely asserted

Run at this SHA against the repository's local `agent.db` — **a development
database, not production**:

```
node agent/scripts/exit-counterfactual.mjs --json
```

```json
{ "verdict": "INSUFFICIENT", "days": 30, "cleanOnly": true,
  "minSample": 30, "considered": 0, "eligible": 0,
  "skipped": { "not_clean_origin": 0, "no_bars": 0, "no_levels": 0 } }
```

Zero considered, zero eligible, verdict `INSUFFICIENT`. The harness runs and
refuses, which is the correct behaviour for an empty sample.

## What the harness does

Replays `trade_postmortems.bars_json` — the stored replay window, as
`[[t,o,h,l,c,v], ...]` — bar by bar under eight policies:

1. as traded (current policy)
2. no time cap
3. no profit keeper
4. no Node ratchet
5. no C++ trail
6. original stop/target only
7. each component individually
8. cost and slippage stress

Replaying real bars rather than approximating from `mfe_r` / `mae_r` is the
difference between a counterfactual and a guess, and is why waiting was
preferred to estimating.

## The refusal built into it

A bar records a high and a low but **not the order in which they occurred**.
When both the stop and the target fall inside the same bar, the outcome is
genuinely undetermined. Those replays are counted as `ambiguous` rather than
resolved by a tie-break — an assumption there would silently flatter or damn
whichever policy it favoured.

## The inference this is meant to test

The Calculated-Risk / Defensive-Drift audit found:

- ~60% of postmortems classify `time_cap`;
- median hold ≈ 31 minutes;
- `burn-in.js:237` sets the target at 1.6× the stop.

A 30-minute cap and a 1.6R target are in tension *if* price needs longer than
the cap to travel 1.6R. **That is an inference, not a measurement.** It is
precisely what Phase 7 exists to settle, and it should not be acted on until it
is settled.

## How to run it when the sample exists

Not before roughly **2026-08-13** (≈7 days of clean-origin closes):

```
node agent/scripts/exit-counterfactual.mjs --days 14
node agent/scripts/exit-counterfactual.mjs --days 14 --json   # for the record
```

Read-only. There is no `--apply`, because there is nothing to apply: it
measures, it does not change a rule.

## Policy boundary

Per the prompt: **do not recommend an exit-policy change from average return
alone.** Any recommendation must carry drawdown, tails and exposure duration.
No live exit setting was changed by this phase, and none should be changed on
the strength of an unrun harness.
