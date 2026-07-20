// ---------------------------------------------------------------------------
// agent/services/vwap-trend.js — VWAP trend-pullback entry (owner: "VP and
// VWAP build"). A standalone STRATEGY, not the confluence filter of the same
// name: when price is trending above/below its anchored VWAP and pulls back
// to the VWAP line, enter in the trend direction with the stop beyond the
// pullback. Trend-kind, so the regime gate keeps it out of quiet chop.
//
// Mirrors the shape of ema-pullback (VWAP replaces EMA20 as the dynamic
// support/resistance line), and returns the standard strategy signal object.
// ---------------------------------------------------------------------------

import { atr } from './fib-strategy.js'
import { vwapSeries } from '../lib/indicators.js'

const MIN_BARS = 30
const ATR_PERIOD = 14
const SL_ATR_BUFFER = 0.5
const MAX_PULLBACK_ATR = 1.5   // a pullback deeper than this isn't a pullback
const SLOPE_LOOKBACK = 10       // VWAP must be sloping with the trend
const MIN_RR = 1.5

const round2 = (v) => Math.round(v * 100) / 100

export function computeVwapTrend(bars, timeframe /*, opts = {} */) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  // Anchor VWAP at the window start (a session-length proxy on intraday
  // timeframes; the whole window on higher ones).
  const vw = vwapSeries(bars, 0)
  const i = bars.length - 1
  const bar = bars[i]
  const v = vw[i]
  const vPrev = vw[i - SLOPE_LOOKBACK]
  if (v == null || vPrev == null) return null

  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null

  let bias = null
  // Uptrend: price above a RISING VWAP; this bar dipped to/through VWAP but
  // closed back above it — a pullback that held.
  if (bar.c > v && v > vPrev && bar.l <= v) {
    if (v - bar.l > MAX_PULLBACK_ATR * a) return null // too deep — trend may be breaking
    bias = 'long'
  } else if (bar.c < v && v < vPrev && bar.h >= v) {
    if (bar.h - v > MAX_PULLBACK_ATR * a) return null
    bias = 'short'
  }
  if (!bias) return null

  const entry = bar.c
  const dir = bias === 'long' ? 1 : -1
  const sl = bias === 'long' ? bar.l - SL_ATR_BUFFER * a : bar.h + SL_ATR_BUFFER * a
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const tp1 = entry + dir * 2 * risk
  const tp2 = entry + dir * 3 * risk
  const rr = round2(Math.abs(tp1 - entry) / risk)
  if (rr < MIN_RR) return null

  // Conviction: 8 base, +1 for a steeper VWAP slope, +1 for a shallow (clean)
  // pullback that barely tagged the line.
  let conviction = 8
  const slopePct = Math.abs(v - vPrev) / (a || 1)
  if (slopePct > 0.5) conviction += 1
  const tagDepth = bias === 'long' ? (v - bar.l) : (bar.h - v)
  if (tagDepth < 0.5 * a) conviction += 1
  conviction = Math.min(conviction, 10)

  return {
    bias, entry, sl, tp1, tp2, conviction, rr, timeframe,
    time_cap_minutes: null,
    strategy: 'vwap_trend',
    thesis: bias === 'long'
      ? `Uptrend on ${timeframe} above a rising VWAP. Price pulled back to the VWAP line and closed above it — buying the pullback, stop below the dip, targets 2R/3R.`
      : `Downtrend on ${timeframe} below a falling VWAP. Price bounced to the VWAP line and closed below it — selling the pullback, stop above the bounce, targets 2R/3R.`,
  }
}
