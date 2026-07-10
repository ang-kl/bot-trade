# C++ backtest sidecar (fib strategy)

Plain-words reference for the fib backtest port that lives in `cpp-exec/`.

## Why

- The strategy autopilot runs roughly **700 backtests per night**.
- That is money-math in a hot loop. It belongs in the **compiled engine**,
  not in Node. The C++ sidecar already holds the execution path; the
  backtest now sits beside it.
- Result: same numbers, much less wall-clock time per nightly sweep.

## What moved to C++

- **computeFibSignal** — swings (FRACTAL_WIDTH=2), ATR(14), 61.8% zone
  (tolerance 0.05), min leg 3x ATR, SL buffer 0.02, TP2 extension 0.272.
- **runFibBacktest** — both entry modes: `close` and `touch` (pending
  orders with fill / cancel / expiry). Cooldown 240 min, MIN_RR 1.5,
  WARMUP_BARS 30, minConviction default 8, cost 0.02% per side.
- **Exit rules** — SL checked before TP on the same bar; gaps fill at
  the open, not at the level. Time cap mirrors `timeCapFor` exactly;
  the caller passes tfMinutes and the timeframe label in.
- **computeStats** — only the fields the verdict gates read:
  trades, wins, losses, winRatePct, profitFactor, totalProfitPct,
  maxDrawdownPct.
- **walkForward** — K=4 segments, returns
  `{segments, active, positive, worstMddPct}` (per-segment max drawdown
  is kept because `verdictFor` reads wfWorstMddPct).

Source of truth for the port: `agent/services/fib-strategy.js` and
`agent/scripts/backtest-fib.js`. The C++ mirrors their expression order
line by line.

## What deliberately did NOT move

- **Other strategies** — only `fib_618_fade` uses the sidecar. Everything
  else stays on the JS path.
- **Tail stats** — sharpe, sortino, CVaR, bootstrap. The verdict gates do
  not use them, so v1 skips them. **JS remains source of truth** for
  those numbers.

## The parity promise

- Integer things are **exact**: trade counts, wins/losses, and the full
  trade sequence (entryT, exitT, reason) must match JS byte-for-byte.
- Floats (pnlPct, stats) match within **1e-9**.
- A parity harness feeds the same bars to both engines and compares.
  It is enforced in CI whenever the compiled binary exists on the
  runner; if the binary is absent the check is skipped, never faked.

## Fallback story

- `agent/lib/exec-engine.js` exports `backtestRemote(payload)`.
  In cpp mode it POSTs to the sidecar; in js mode it returns null.
- `agent/services/strategy-autopilot.js` tries the sidecar first for
  the fib strategy. On null, non-2xx, or any throw it **falls back to
  the existing JS backtest** — behaviour identical, only slower.
- So an unreachable or crashed sidecar never changes results; the
  nightly sweep just takes longer.

## How to call it

**CLI (offline verification, no env vars):**

```
./cpp-exec --backtest < payload.json > result.json
```

stdin: one JSON object
`{bars:[[t,o,h,l,c,v],...], timeframe, tfMinutes, capMinutes|null,
entryMode, minConviction}`.
stdout: `{trades, stats, wf}`. Exit code 0 on success.

**HTTP (production path):**

`POST /backtest` on the existing sidecar server. Bearer token required
(same auth as the other endpoints). Same payload and response as the
CLI. Payloads over 5 MB are rejected.

## Files

- `cpp-exec/src/backtest.hpp` / `backtest.cpp` — namespace `bt`, the port.
- `cpp-exec/src/tests/` — unit + parity tests, one binary per test file.
- `agent/lib/exec-engine.js` — `backtestRemote`.
- `agent/services/strategy-autopilot.js` — sidecar-first wiring for fib.
