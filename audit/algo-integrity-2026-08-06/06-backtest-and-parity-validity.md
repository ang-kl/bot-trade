> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 06 — Backtest and parity validity

## Executed

- `node agent/scripts/backtest-parity.mjs` → **exit 0**
- `make -C cpp-exec CXX=g++ test` → **exit 0** (306s), covering `test_backtest`,
  `test_trail_engine`, `test_vpo_strategies`, `test_frames`, `test_auth_error_policy`,
  `test_spot_feed_stop`, `test_engine_telemetry`, `test_telemetry`

H11 (Node/C++ semantic drift) is **partially disproved**: the repo's own parity gate
passes at this SHA.

## The limit of that result

Parity here is **aggregate**, not trade-sequence. Prompt §9 requires *trade-sequence*
parity, exact integer parity and a defined floating tolerance — a suite can agree on
totals while disagreeing on which trades produced them. Not verified.

## BLOCKED — DATA UNAVAILABLE

Entry timing (close / next open / touch / limit), bid-ask and spread treatment,
commission, slippage, swap, gap fills, **same-bar SL/TP ambiguity band** (§9 requires
both pessimistic and optimistic outcomes reported), partial fills and scale-outs, time
caps, cooldowns, concurrent-position handling, currency conversion, rounding.

And every statistical requirement: walk-forward, purged/embargoed validation,
out-of-sample by time, holdout symbols, regime-separated testing, block bootstrap
CIs, Monte Carlo trade resampling, cost stress at 1×/1.5×/2×/adverse-gap, and
parameter-stability surfaces.

**Therefore none of the §9 metrics is reported.** No win rate, payoff ratio,
expectancy, profit factor, drawdown, MAE/MFE, CVaR, loss streak or risk of ruin
appears anywhere in this audit — reporting any of them from in-sample or absent data
is exactly what §2 forbids.
