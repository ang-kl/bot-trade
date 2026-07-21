// ---------------------------------------------------------------------------
// agent/services/rsi2-reversion.js — Connors RSI(2) mean reversion.
//
// The high-WIN-RATE strategy (owner chose this family: ~65-70% win, small R:R,
// the edge is ENTRY TIMING and the stop is TAIL INSURANCE, not the edge). Based
// on Larry Connors & Cesar Alvarez, "Short Term Trading Strategies That Work":
// in a longer-term uptrend, a 2-period RSI washout is a high-probability bounce;
// mirror for downtrends. Documented as one of the most robust short-term
// mean-reversion filters in the retail literature.
//
//   long : close > SMA(trend)  AND  RSI(2) < oversold      → buy the washout
//   short: close < SMA(trend)  AND  RSI(2) > 100-oversold  → sell the blow-off
//
// Why this fits the account's mandate:
//  · The regime gate (real ADX/ATR now) blocks it in a TRENDING regime that
//    OPPOSES the signal and in VOLATILE whipsaw — so it fires in ranges and
//    trend-aligned dips, its home turf. STRATEGY_KIND marks it 'meanrev'.
//  · Fixed-R geometry: sl = SL_ATR × ATR (wide enough that ordinary noise
//    around the extreme doesn't clip the bounce — that WIDTH is what buys the
//    high win rate), tp1 = TP_RR × sl distance. rr ≈ TP_RR by construction.
//    At ~68% win, 1.2R pays; the stop is there for the range-breaks-into-trend
//    tail, which is the only thing that turns this style into a blow-up.
//  · Its rr (~1.2) is below the global 1.5 risk floor ON PURPOSE — a small R:R
//    is the whole point of a high-win-rate system — so strategies.js gives this
//    key its own lower floor (STRATEGY_MIN_RR), honoured by the risk gate and
//    the backtest alike.
// ---------------------------------------------------------------------------

import { atr, rsi } from './fib-strategy.js'
import { sma } from './cup-handle.js'
import { parseTimeframe } from '../lib/timeframes.js'

const TREND_PERIOD = 100   // longer-term trend filter (Connors uses 200 on daily)
const RSI_PERIOD = 2
const OVERSOLD = 10        // RSI(2) < 10 long / > 90 short
const DEEP = 5             // RSI(2) < 5 / > 95 → deeper washout, +conviction
const SL_ATR = 1.5         // stop distance in ATRs — wide, so the bounce breathes
const TP_RR = 1.2          // target = TP_RR × stop distance → rr ≈ 1.2 by design
const TP2_RR = 2.2         // runner target for scale-out management
const MIN_BARS = TREND_PERIOD + RSI_PERIOD + 2

const round2 = (x) => Math.round(x * 100) / 100

/**
 * computeRsi2(bars, timeframe, opts) → signal | null
 * Pure OHLC. No internal rr veto — the risk gate / backtest apply the
 * per-strategy R:R floor, so this returns the raw setup.
 */
export function computeRsi2(bars, timeframe) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  const last = bars[bars.length - 1]
  const r = rsi(bars, RSI_PERIOD)
  const trend = sma(bars, TREND_PERIOD)
  const a = atr(bars)
  if (r == null || trend == null || !(a > 0)) return null

  const longSetup = last.c > trend && r < OVERSOLD
  const shortSetup = last.c < trend && r > 100 - OVERSOLD
  if (!longSetup && !shortSetup) return null

  const bias = longSetup ? 'long' : 'short'
  const entry = last.c
  const slDist = SL_ATR * a
  const sl = bias === 'long' ? entry - slDist : entry + slDist
  const tp1 = bias === 'long' ? entry + TP_RR * slDist : entry - TP_RR * slDist
  const tp2 = bias === 'long' ? entry + TP2_RR * slDist : entry - TP2_RR * slDist
  const rr = round2(Math.abs(tp1 - entry) / slDist) // ≈ TP_RR

  // Conviction: base 8 (clears the autotrade bar). +1 for a deeper washout,
  // +1 when price is stretched well past the trend line (a bigger dip to fade).
  let conviction = 8
  if (bias === 'long' ? r < DEEP : r > 100 - DEEP) conviction += 1
  const stretch = Math.abs(entry - trend) / a
  if (stretch >= 1) conviction += 1
  conviction = Math.min(conviction, 10)

  // Mean reversion is a fast trade — give it a handful of bars, then hand the
  // risk budget back. null time cap when the timeframe string is unreadable.
  const tf = parseTimeframe(timeframe)
  const timeCap = tf ? 5 * (tf.ms / 60_000) : null

  return {
    bias,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    rr,
    timeframe,
    time_cap_minutes: timeCap,
    strategy: 'rsi2_reversion',
    thesis: bias === 'long'
      ? `RSI(2) washed out to ${round2(r)} while price holds above its ${TREND_PERIOD}-bar trend — buying a high-probability bounce, ${TP_RR}R target, ${SL_ATR}×ATR stop as tail insurance.`
      : `RSI(2) spiked to ${round2(r)} while price sits below its ${TREND_PERIOD}-bar trend — selling the blow-off back toward the mean, ${TP_RR}R target, ${SL_ATR}×ATR stop as tail insurance.`,
  }
}
