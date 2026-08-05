> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 05 — Data quality and noise

## Scorecard — executed portion

| Defect | Detection rule | Affected | Observed | Economic effect | Fail behaviour | Status |
|---|---|---|---|---|---|---|
| Malformed OHLC (h < l) | invariant runner | all 12 | 0 signals | none | fail-closed | **closed at strategy boundary** |
| NaN / null / Infinity in a bar | invariant runner | all 12 | 0 signals, 0 throws | none | fail-closed | **closed** |
| Zero-range / flat series | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |
| Zero volume | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |
| Duplicate bars | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |
| Out-of-order timestamps | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |
| Price-scale change | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |
| Sub-minimum history | invariant runner | all 12 | 0 signals | none | fail-closed | **closed** |

The obvious degenerate-data channel into a false signal is shut at the strategy
boundary. That is a real and useful result.

## BLOCKED — DATA UNAVAILABLE

Everything about *live* data quality: bid/ask/mid selection, stale-tick detection,
trendbar closure semantics, timezone alignment, session and holiday handling, spread
behaviour, volume semantics, missing/duplicate bars in production, symbol digits and
tick sizes, FX conversion freshness, commission/swap/financing, news calendar,
correlation matrix, market-pulse state, corporate actions and rollover.

Specifically **not** answered: can spread make an R:R appear valid when it is not; can
a stale or outlier tick trigger a stop; can an unfinished candle be classified as
completed; can repeated evaluations appear as many opportunities. Each needs the tick
and bar tables. Queries in `evidence/data-queries.sql`.

**No new noise filter is recommended.** Per §8, a filter may not be proposed on
in-sample improvement, and no out-of-sample evidence was reachable.
