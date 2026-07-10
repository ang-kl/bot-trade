// ---------------------------------------------------------------------------
// agent/services/donchian-breakout.js — Donchian 20-bar range breakout.
// Two-sided: long when the LAST closed bar closes above the highest high of
// the prior 20 bars; short mirrors below the lowest low.
//
// Quality gates (each one kills a known failure mode):
//   - range height >= 2×ATR(14)   — a micro-range "breakout" is just noise
//   - close beyond band <= 1×ATR  — don't chase a move that already ran
//   - breakout volume >= 1.2× the prior-20 average — no conviction, no trade
//
// Trade plan: entry = close · SL = entry −/+ 1.5×ATR ·
// TP1 = entry +/− range height (measured move) · TP2 = entry +/− 1.5×range.
// Only returns a signal when RR >= 1.5 (same bar as every other strategy).
// ---------------------------------------------------------------------------

import { atr } from './fib-strategy.js'

const CHANNEL = 20              // Donchian lookback (prior bars, breakout bar excluded)
const MIN_BARS = 40             // channel + ATR warm-up headroom
const MIN_RANGE_ATR = 2         // range height must be >= 2×ATR
const MAX_OVERSHOOT_ATR = 1     // close at most 1×ATR beyond the band
const VOL_X = 1.2               // breakout volume vs prior-20 average
const SL_ATR = 1.5
const MIN_RR = 1.5

const round2 = (x) => Math.round(x * 100) / 100

/**
 * Same contract as computeFibSignal: null, or a signal object the loop,
 * risk gate and backtest already understand.
 */
export function computeDonchianBreakout(bars, timeframe) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  const last = bars.length - 1
  const close = bars[last].c

  // Prior-20 channel — the breakout bar itself is excluded on purpose.
  let hi = -Infinity; let lo = Infinity; let volSum = 0
  for (let i = last - CHANNEL; i < last; i++) {
    if (bars[i].h > hi) hi = bars[i].h
    if (bars[i].l < lo) lo = bars[i].l
    volSum += bars[i].v || 0
  }
  const range = hi - lo
  const a = atr(bars)
  if (!(a > 0) || range < MIN_RANGE_ATR * a) return null // micro-range noise

  let bias = null
  if (close > hi) bias = 'long'
  else if (close < lo) bias = 'short'
  if (!bias) return null

  // Don't chase: the close may sit at most 1×ATR beyond the band it broke.
  const overshoot = bias === 'long' ? close - hi : lo - close
  if (overshoot > MAX_OVERSHOOT_ATR * a) return null

  // Conviction needs participation: breakout volume vs the prior-20 average.
  const avgVol = volSum / CHANNEL
  const volX = avgVol > 0 ? (bars[last].v || 0) / avgVol : 0
  if (volX < VOL_X) return null

  const dir = bias === 'long' ? 1 : -1
  const entry = close
  const sl = entry - dir * SL_ATR * a
  const tp1 = entry + dir * range        // measured move
  const tp2 = entry + dir * 1.5 * range
  const rr = round2(Math.abs(tp1 - entry) / Math.abs(entry - sl))
  if (rr < MIN_RR) return null

  let conviction = 8
  if (volX >= 1.8) conviction++
  if (range >= 3 * a) conviction++
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
    strategy: 'donchian_breakout',
    thesis: `Price closed ${bias === 'long' ? 'above' : 'below'} the 20-bar range `
      + `on ${volX.toFixed(1)}x volume. Target is one range height `
      + `${bias === 'long' ? 'up' : 'down'}; stop is 1.5 ATR behind entry.`,
  }
}
