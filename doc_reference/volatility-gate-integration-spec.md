# Volatility-Gate Integration Spec — bot-trade

**Repo**: `ang-kl/bot-trade`
**Branch**: TBC (recommend `feature/vol-gate`, cut from current working branch)
**Status**: Draft for Claude Code implementation
**Author**: Adrian Ang

---

## 0. Objective

Insert a single, reusable volatility-classification gate between **signal generation** (any of: Cup-and-Handle, VWAP, Fibonacci, Volume Profile, FVG) and **order execution**. The gate does not generate signals or change directional bias — it only modulates position size, stop-loss distance, and entry confirmation strictness based on the current volatility regime, and logs the regime context to the Trade Lesson Entry schema for post-trade analysis.

This is a **risk-normalisation layer**, not a new alpha source.

---

## 1. Architecture Overview

```
signal_generated (any tool)
        ↓
[Layer 1] vol_regime_classify()      → LOW | NORMAL | HIGH
        ↓
[Layer 2] tool_specific_adjustment() → per-tool size/tolerance/confirmation logic
        ↓
[Layer 3] confluence_reconcile()     → if >1 tool fired, take most-conservative size
        ↓
[Layer 4] Trade Guards (existing)    → validate against exposure caps, max-loss rules
        ↓
[Layer 5] order_execute()            → place order
        ↓
[Layer 6] onTradeClose → Trade Lesson Entry (existing) + vol fields appended
```

**New module**: `vol-gate.js` (co-located with existing signal modules, e.g. alongside `loop.js`)

**Modified files** (verify exact paths/line numbers against current repo state before editing):
- `loop.js` — call `vol-gate.js` before order placement; ensure it does not interact with the known `loop.js:1029` gating bug (orphan/dedup sweep) — these are separate concerns and must not be conflated in the same conditional block.
- `alpha-decay.js` — no changes required unless vol fields are added to the `net_pnl` filter query; confirm `WHERE net_pnl IS NOT NULL` logic is unaffected.
- Trade Lesson Entry schema (wherever currently defined) — append new fields per §4.

---

## 2. Layer 1 — Volatility Regime Classification

**Function**: `classifyVolRegime(pair, timeframe)`

**Inputs**:
- `pair` (string, e.g. `"EURUSD"`)
- `timeframe` (string, e.g. `"1H"`)
- Rolling 252-day ATR(20) history for the pair (pull from existing price-feed store; if not cached, build a rolling ATR cache — do not recompute from scratch per call)

**Logic**:
```
current_atr = ATR(20) on latest closed candle
percentile = percentile_rank(current_atr, atr_252d_history)

if percentile < 20:  regime = "LOW"
elif percentile > 80: regime = "HIGH"
else:                  regime = "NORMAL"

return { regime, current_atr, percentile }
```

**Output**: `{ regime: "LOW"|"NORMAL"|"HIGH", current_atr: float, percentile: float }`

**Notes for Claude Code**:
- Cache the 252-day ATR history per pair; recompute the rolling window daily, not per-signal, to avoid redundant computation load.
- If fewer than 252 days of history exist for a pair (new listing), fall back to available history with a `insufficient_history: true` flag on the output — downstream logic should treat this as NORMAL by default and log the flag.

---

## 3. Layer 2 — Per-Tool Adjustment Functions

Each function takes the Layer 1 output plus tool-specific signal data, and returns a common adjustment object:

```
{
  position_size_ratio: float (0.0–1.0),
  stop_adjustment_pips: float,
  confirmation_required: boolean,
  defer_entry: boolean,
  notes: string
}
```

### 3.1 `adjustCupAndHandle(volRegime, signalData)`
- LOW: size 1.0, no stop adjustment, no extra confirmation.
- NORMAL: size 0.85–0.9, no stop adjustment.
- HIGH: size 0.5–0.7 OR `defer_entry: true` for 1–2 candles; expand stop by `ATR(20) × 0.5`.
- Reference: existing Cup and Handle silence diagnostic — ensure this function does NOT interact with `traceCupHandleSearch`; keep concerns separate (silence diagnostic = detection; vol-gate = execution sizing).

### 3.2 `adjustVWAP(volRegime, vwapBandData)`
- Compute `band_width = vwapBandData.upper - vwapBandData.lower` at ±1σ or ±2σ as configured.
- HIGH regime: require close-confirmation beyond band for 2+ consecutive candles before entry (`confirmation_required: true`); size inversely to `band_width` (wider band → smaller size).
- LOW/NORMAL: single-candle break sufficient.

### 3.3 `adjustFibonacci(volRegime, fibLevelData)`
- Compute `fib_tolerance_zone = fibLevelData.level ± (current_atr × 0.3)`.
- Entry valid only if candle **closes** (not wicks) within zone.
- HIGH regime: widen tolerance zone, but set `confirmation_required: true` pending volume confirmation from §3.4 output (pass Volume Profile result as a secondary input if available in the same signal stack).

### 3.4 `adjustVolumeProfile(volRegime, volumeData)`
- Compute `relative_volume_ratio = volumeData.current_volume / volumeData.avg_volume_20d_same_time`.
- **Key risk flag**: if `volRegime === "HIGH"` AND `relative_volume_ratio < 0.7` → set `vol_volume_divergence_flag: true`, `defer_entry: true` (this is the highest-risk combination — fast price movement with thin participation).
- If HIGH vol + HIGH relative volume (≥1.0): treat as confirmed institutional participation, size 0.9–1.0.

### 3.5 `adjustFVG(volRegime, fvgData)`
- Requires `fvgData.origin_vol_regime` — tag this **at gap creation time**, not at fill-check time. If this field is missing on an existing FVG record, treat as `NORMAL` with an `origin_regime_unknown: true` flag.
- If `origin_vol_regime === "HIGH"`: `fill_target_pct: 50`, size 0.6–0.7.
- If `origin_vol_regime` is NORMAL/LOW: `fill_target_pct: 100`, standard size.
- If current `volRegime === "HIGH"` while `origin_vol_regime` was LOW/NORMAL: widen stop to account for overshoot risk (flag as `origin_current_divergence: true`).

---

## 4. Layer 3 — Confluence Reconciliation

**Function**: `reconcileConfluence(adjustmentResults[])`

**Logic**:
```
if adjustmentResults.length === 1:
    return adjustmentResults[0]

if any result has defer_entry === true:
    return { defer_entry: true, reason: "one or more tools flagged defer" }

final_size = min(all position_size_ratio values)   // most conservative, not multiplicative
final_stop = max(all stop_adjustment_pips values)   // widest protective stop
final_confirmation = any(confirmation_required === true)

if tools disagree materially (e.g. one says defer, another says proceed at full size):
    flag for manual Trade Guard review rather than auto-resolving
```

**Critical constraint**: do NOT multiply size ratios across tools (e.g. 0.7 × 0.6 × 0.8 → do not compound to near-zero). Use `min()`.

---

## 5. Trade Lesson Entry Schema — New Fields

Append to existing flat key-value schema (controller-agnostic, per current convention):

```
entry_vol_regime: "LOW" | "NORMAL" | "HIGH"
entry_vol_percentile: float
position_size_ratio_applied: float
stop_loss_expanded_pips: float
confirmation_candles_required: integer | null
vol_volume_divergence_flag: boolean
fvg_origin_vol_regime: "LOW" | "NORMAL" | "HIGH" | null
fvg_fill_target_pct: 50 | 100 | null
confluence_tool_count: integer
confluence_conflict_flagged: boolean
trade_outcome_vol_adjusted: "WIN" | "LOSS" | "WHIPSAW" | null   // populate on close via onTradeClose
```

Wire population of `trade_outcome_vol_adjusted` into the existing `onTradeClose` handler alongside current Trade Guard fields — do not create a second handler.

---

## 6. Implementation Order (recommended sequence for Claude Code)

1. Build `vol-gate.js` with `classifyVolRegime()` only. Unit test against known historical ATR data for 2–3 pairs before proceeding.
2. Add the five `adjustX()` functions individually, each with isolated unit tests against synthetic signal data (do not wire into `loop.js` yet).
3. Add `reconcileConfluence()` with unit tests covering: single-tool, multi-tool agreement, multi-tool conflict.
4. Extend Trade Lesson Entry schema (additive only — do not rename or remove existing fields).
5. Wire into `loop.js` at the pre-order-placement point. Confirm this insertion point is downstream of the existing `loop.js:1029` orphan/dedup sweep fix (once that fix is confirmed live) to avoid compounding bugs.
6. Run isolated historical backtest (reuse existing Cup and Handle backtest harness) with vol-gate ON vs OFF, same symbol list, same date range. Compare: win rate by regime, max drawdown, Sharpe.
7. Deploy to Railway in a disabled/log-only mode first (compute and log adjustments, but do not alter actual order size/stops) for a defined observation window before enabling live sizing effects.

---

## 7. Open Decisions Requiring Sign-Off Before Full Build

- [ ] Percentile thresholds: confirm 20th/80th as LOW/HIGH cutoffs, or adjust per pair class (majors vs. exotics may warrant different thresholds given the volatility bands established separately).
- [ ] HIGH-vol Cup-and-Handle response: hard-code size-down (e.g. 0.6) vs. defer-entry — or make configurable per pair.
- [ ] Confluence conflict handling: auto-flag to Trade Guard for manual review (as specified) vs. hard block the trade entirely.
- [ ] Log-only observation window duration before enabling live sizing effects (recommend minimum 2 weeks / 50+ signals, but confirm against your risk tolerance).

---

## 8. Testing & Validation Checklist

- [ ] Unit tests: each `adjustX()` function, isolated
- [ ] Unit tests: `reconcileConfluence()` — single tool, multi-tool agree, multi-tool conflict
- [ ] Integration test: full pipeline from signal → vol-gate → Trade Guard → mock order placement
- [ ] Backtest comparison: vol-gate ON vs OFF (win rate, max DD, Sharpe by regime)
- [ ] Live log-only run: confirm classification and adjustment values are sane (no NaN, no extreme outliers) before enabling live effects
- [ ] Confirm `net_pnl IS NOT NULL` filter in `alpha-decay.js` is unaffected by new schema fields
