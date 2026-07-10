// ---------------------------------------------------------------------------
// agent/services/ema-pullback.js
//
// EMA trend-pullback strategy (two-sided). Trend is defined by EMA20 vs
// EMA50 (20 above 50 = uptrend). A signal fires when the LAST CLOSED bar
// dips back to touch or undercut EMA20 (low <= ema20 for longs) but then
// closes back on the trend side of EMA20 with the trend still intact
// (close above EMA50). Mirrored for shorts.
//
// Guards (constraints, not tuning knobs):
// - need >= 60 bars so EMA50 has warmed up past its startup bias
// - ATR(14) must be available and the pullback depth must be <= 2*ATR:
//   deeper pullbacks are usually trend breaks, not healthy retracements
//
// Levels: entry = close, sl = min(low, ema50) - 0.25*ATR (mirror for
// shorts), tp1 at 2R and tp2 at 3R, so rr is a fixed 2.00 — comfortably
// above the shared 1.5 floor every strategy must clear.
//
// NO LLM calls — pure OHLC arithmetic, same spirit as fib-strategy.js.
// ---------------------------------------------------------------------------

import { atr, rsi } from './fib-strategy.js'

const MIN_BARS = 60
const ATR_PERIOD = 14
const MAX_PULLBACK_ATR = 2    // pullback deeper than 2*ATR = broken leg
const SL_ATR_BUFFER = 0.25    // stop sits a quarter-ATR beyond structure
const MIN_RR = 1.5            // shared floor across all strategies

/**
 * Exponential moving average series over closes. Seeded with an SMA of the
 * first `period` closes (standard warm-up), then the recursive EMA formula.
 * Returns an array aligned with `bars` (nulls before warm-up completes).
 */
export function emaSeries(bars, period) {
  const out = new Array(bars.length).fill(null)
  if (bars.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += bars[i].c
  let ema = sum / period
  out[period - 1] = ema
  const k = 2 / (period + 1)
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].c * k + ema * (1 - k)
    out[i] = ema
  }
  return out
}

const round2 = x => Math.round(x * 100) / 100

/**
 * compute(bars, timeframe, opts) → null or the shared signal shape.
 * Only the last CLOSED bar can trigger — no lookahead, no repainting.
 */
export function computeEmaPullback(bars, timeframe /*, opts = {} */) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  const ema20s = emaSeries(bars, 20)
  const ema50s = emaSeries(bars, 50)
  const i = bars.length - 1
  const bar = bars[i]
  const ema20 = ema20s[i]
  const ema50 = ema50s[i]
  if (ema20 == null || ema50 == null) return null

  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null // ATR must be available — flat data is untradeable

  let bias = null
  if (ema20 > ema50 && bar.l <= ema20 && bar.c > ema20 && bar.c > ema50) {
    // uptrend: bar dipped into EMA20 but closed back above it, trend intact
    if (ema20 - bar.l > MAX_PULLBACK_ATR * a) return null // too deep
    bias = 'long'
  } else if (ema20 < ema50 && bar.h >= ema20 && bar.c < ema20 && bar.c < ema50) {
    // downtrend mirror: bar poked up into EMA20 but closed back below
    if (bar.h - ema20 > MAX_PULLBACK_ATR * a) return null // too deep
    bias = 'short'
  }
  if (!bias) return null

  const entry = bar.c
  const sl = bias === 'long'
    ? Math.min(bar.l, ema50) - SL_ATR_BUFFER * a
    : Math.max(bar.h, ema50) + SL_ATR_BUFFER * a
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const dir = bias === 'long' ? 1 : -1
  const tp1 = entry + dir * 2 * risk
  const tp2 = entry + dir * 3 * risk

  const rr = round2(Math.abs(tp1 - entry) / risk) // fixed 2.00 by design
  if (rr < MIN_RR) return null

  // Conviction: 8 base, +1 when EMA20 is sloping with the trend over the
  // last 5 bars, +1 when RSI sits in the 40-60 band (a healthy pullback,
  // not an exhaustion move). Capped at 10.
  let conviction = 8
  const ema20Prev = ema20s[i - 5]
  if (ema20Prev != null && dir * (ema20 - ema20Prev) > 0) conviction += 1
  const r = rsi(bars, 14)
  if (r != null && r >= 40 && r <= 60) conviction += 1
  conviction = Math.min(conviction, 10)

  return {
    bias,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    rr,
    timeframe,
    time_cap_minutes: null,
    strategy: 'ema_pullback',
    thesis: bias === 'long'
      ? `Uptrend on ${timeframe} (EMA20 above EMA50). Price dipped to the EMA20 line and closed back above it — buying the pullback, stop below the dip and EMA50, targets at 2R and 3R.`
      : `Downtrend on ${timeframe} (EMA20 below EMA50). Price bounced up to the EMA20 line and closed back below it — selling the pullback, stop above the bounce and EMA50, targets at 2R and 3R.`,
  }
}
