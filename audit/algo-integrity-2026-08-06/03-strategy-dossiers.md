> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 03 — Strategy dossiers

Full per-case results (12 strategies × 24 series): `evidence/strategy-invariants.json`.

| # | Strategy | Default | minBars | Pending | Module live | 19 adversarial series | Positive control | Edge |
|---|---|---|---|---|---|---|---|---|
| 1 | `fib_618_fade` | **off** | 14 | yes | yes | clean | repo | UNPROVEN |
| 2 | `cup_handle` | on | 210 | no | yes | clean | repo | UNPROVEN |
| 3 | `inv_cup_handle` | on | 210 | no | yes | clean | repo | UNPROVEN |
| 4 | `ema_pullback` | on | 450 | no | yes | clean | repo | UNPROVEN |
| 5 | `donchian_breakout` | on | 40 | no | yes | clean | harness + repo | UNPROVEN |
| 6 | `rsi_meanrev` | on | 75 | no | yes | clean | repo | UNPROVEN |
| 7 | `vwap_trend` | on | 30 | no | yes | clean | repo | UNPROVEN |
| 8 | `vp_value` | on | 40 | no | yes | clean | repo | UNPROVEN |
| 9 | `rsi2_reversion` | on | 104 | no | yes | clean | harness + repo | UNPROVEN |
| 10 | `fib_confluence` | on | 40 | no | yes | clean | repo | UNPROVEN |
| 11 | `va_breakout` | on | 60 | no | yes | clean | repo | UNPROVEN |
| 12 | `fvg_retrace` | **off** | 60 | no | yes | clean | repo | UNPROVEN |

"clean" = returned `null` on all nineteen adversarial series and threw on none.

**Series:** insufficient history · one bar · minBars−1 · exactly minBars · flat ·
monotonic rise · monotonic fall · zero-range · sawtooth · duplicated bars ·
out-of-order timestamps · missing interval · NaN close · null low · infinite high ·
impossible OHLC · zero volume · giant wick · price-scale change. Plus five positive
controls.

**Harness validity limit, stated because it changes how the table reads.** The
synthetic positive controls fired for only 2 of 12 strategies; the other ten reject
the generic series on their own quality gates. For those ten, "returned null on
everything" is by itself vacuous — a dead function scores identically. The result
holds on two other legs: the null-placeholder identity check (source text + function
name), and the repo's own suite, which carries a genuine non-null assertion for all
twelve and passed green at this SHA.

**BLOCKED — DATA UNAVAILABLE:** economic hypothesis validation, holding-horizon
measurement, regime suitability, sample size and edge evidence. All require closed
trades.

`fib_confluence` is the thinnest-covered armed strategy — one test file, one non-null
assertion — and is also the guard the owner measured at 1,039 vetoes.
