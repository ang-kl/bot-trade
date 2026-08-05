> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 04 — Mathematics and invariants

## Executed

- **Registry `minBars` parity.** Every one of the 12 computes carries a `minBars`
  stamp identical to the registry's declaration. Zero drift. This is the guard for the
  2026-07-28 bug class where `cup_handle` (210) and `ema_pullback` (450) were fetched
  150 bars, returned null at their length guard before any logic ran, and backtested
  fine — so the autopilot armed them on evidence they could never reproduce live.
- **Length-guard enforcement.** No strategy signalled at `minBars − 1`. The guard is
  real, not decorative.
- **Degenerate-input safety.** No strategy signalled on flat prices, zero-range bars,
  or malformed OHLC; none produced a non-finite entry/stop/target; none threw. A throw
  matters as much as a false signal — the scan's try/catch would render it as "no
  signal", which is the §17 `silent unknown` state.
- **Determinism.** Identical input yields identical output for all 12.

## NOT executed — and the distinction matters

**Look-ahead is NOT proven absent.** The harness's invariance check asserts only
determinism on identical input. Genuine look-ahead detection requires replaying a
prefix and confirming the decision at time *t* is unchanged by bars after *t*, against
real series. Claiming otherwise would be the easy error here.

**BLOCKED — DATA UNAVAILABLE:** independent reference calculations for ATR, RSI, SMA,
EMA, Donchian, VWAP, volume profile, Fibonacci confluence, FVG detection, conviction
scores, Kelly scaling, lot conversion, FX/notional/margin, and market-pulse measures.
The prompt requires a *hand-verifiable fixture or independent implementation*, not a
function compared with itself; building twelve of those is a work item, not an
omission that can be papered over.
