> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 08 — Risk of ruin and capital safety

## Executed — enforcement verified in source and covered by passing tests

| Control | Where | Both engines? |
|---|---|---|
| Naked-order refusal (no SL) | `exec-engine.js` `validateOrderBracket` | **yes** |
| Targetless refusal (no TP) | same | **yes** |
| Halt kill switch | `validateExecGuard` | **yes** |
| Max order volume | `validateExecGuard` | **yes** |
| Account-mismatch refusal | `withAccount` / `resolveOrderAccount` | **yes** |

The bracket and guard checks mirror `cpp-exec/src/order_guard.cpp` with identical
reason strings, so the JS path cannot be a softer path. This closes the historical
hole where the kill switch only worked under `EXEC_ENGINE=cpp`.

## F-RISK-01 — confirmed cross-side defect

`getCtraderCreds()` never returns `isLive`, so `sameSideAccountIds` reads `undefined`
and selects the **demo** side unconditionally. Proved by execution — see the Result
document §3. Effect: `loss-cap` and `profit-ratchet` sweep demo accounts with live
credentials, and **a second live account would receive neither sweep**. Only one live
account is enabled today, which is the sole reason this has not cost money.

## BLOCKED — DATA UNAVAILABLE

The entire quantitative half. One-day and one-week loss distributions; probability of
10/20/30/50% drawdown; risk of ruin; time to recovery; sensitivity to per-trade risk;
effect of concurrent correlated exposure. Also the §11 stress list: simultaneous
correlated stops, weekend gaps, spread explosion, stale FX conversion, margin
compression, broker rejection of protective stops, restart during exposure, and the
five-position and correlated-cluster worst cases.

**Per §11, the system is NOT called "safe" here.** A stop existing in local state is
not protection; broker-side protection was not verifiable, because
`exec-parity.js` could not reach a broker session.

## OWNER POLICY DECISION — NOT A CORRECTNESS FIX

- `dailyLossPct 0.03` → a USD 16.16 daily cap on 43097342
- `risk_budget = $0.33` against `usd_per_lot = $52.97` — the minimum lot costs more
  than the entire budget, so every entry on that account is refused for insufficient
  equity
- `minRR 1.5` versus measured breakeven payoff (task #185)
