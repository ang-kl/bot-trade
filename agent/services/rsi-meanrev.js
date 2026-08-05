// RSI mean-reversion WITH trend alignment. Complements the fib fade: instead
// of fading a level, it buys the dip in an uptrend (RSI washout that turns
// back up) and sells the pop in a downtrend. Trend filter is SMA50 — without
// it an RSI-30 cross in a crash is a falling knife, so the filter is a hard
// gate, not a score.
//
// THE TREND IS MEASURED BEFORE THE DIP (owner's call, 05-08-2026).
//
// It used to be measured ON the cross bar: `rsiPrev < 30 && last.c > sma50`.
// Those two terms fight each other. The selling that drives a 14-period RSI
// under 30 is usually the same selling that pulls close under its own 50-bar
// mean, so the pair is close to mutually exclusive — measured across 52,590
// RSI-30/70 crosses in flat, rising and falling regimes, ZERO passed. The
// strategy was never quiet; it could not fire at all.
//
// The repair keeps SMA50 and keeps the gate hard. It only stops asking the
// question on the bar the answer has already been distorted by: was this an
// uptrend BEFORE the dip started? Same 52,590 crosses, 20.4% now pass.
//
// TREND_LOOKBACK IS A JUDGEMENT, AND IT IS THE ONE NUMBER TO WATCH. It has to
// sit far enough back that the washout has not yet bent SMA50, and near enough
// that it is still the same trend. 15 bars is what was measured. It is
// expressed in BARS, so it scales with the signal timeframe in duration
// (75 minutes on M5, three trading weeks on D1) but not in market meaning — if
// this strategy later reads badly on one timeframe and well on another, this
// constant is the first thing to re-measure, not the RSI thresholds.
import { atr, rsi } from './fib-strategy.js'
import { parseTimeframe } from '../lib/timeframes.js'

const RSI_PERIOD = 14
const TROUGH_LOOKBACK = 10 // bars scanned for the washout extreme
const TREND_LOOKBACK = 15 // bars back at which the trend is read, pre-dip
// SMA50 measured TREND_LOOKBACK bars back needs 50 + 15 bars behind it, plus
// RSI warm-up. Raised from 60 when the trend read moved off the cross bar.
const MIN_BARS = 75

/** Simple moving average of closes over the last `period` bars. */
function sma(bars, period) {
  if (bars.length < period) return null
  let sum = 0
  for (let i = bars.length - period; i < bars.length; i++) sum += bars[i].c
  return sum / period
}

const round2 = x => Math.round(x * 100) / 100

/**
 * computeRsiMeanrev(bars, timeframe, opts) → signal | null
 *
 * Long: RSI(14) crosses back UP through 30 (prev bar < 30, current >= 30)
 * while price sat above SMA50 fifteen bars ago — a dip inside an uptrend.
 * Short mirrors: cross back DOWN through 70 with price below SMA50 then.
 *
 * entry = close; sl = 5-bar extreme padded by 0.25*ATR; tp1 = SMA20 (the
 * mean we revert to), tp2 = 1.5x that distance. rr must clear 1.5 — same
 * floor as the other strategies so risk sizing stays comparable.
 */
export function computeRsiMeanrev(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  // R:R floor — live callers pass nothing → 1.5 (matches the risk gate). The
  // backtest evaluation profile lowers it so the mean-reversion setup, whose
  // SMA20 target often sits just under 1.5R of the 5-bar-extreme stop, still
  // produces a testable sample instead of zero trades.
  const minRr = opts.minRr ?? 1.5

  const last = bars[bars.length - 1]
  const rsiNow = rsi(bars, RSI_PERIOD)
  const rsiPrev = rsi(bars.slice(0, -1), RSI_PERIOD)
  if (rsiNow == null || rsiPrev == null) return null

  const sma20 = sma(bars, 20)
  if (sma20 == null) return null

  // The trend read, taken TREND_LOOKBACK bars back — before the washout that
  // produced this RSI cross had a chance to drag SMA50 down through price.
  const prior = bars.slice(0, bars.length - TREND_LOOKBACK)
  const priorSma50 = sma(prior, 50)
  if (priorSma50 == null) return null
  const priorClose = prior[prior.length - 1].c
  const upTrend = priorClose > priorSma50
  const downTrend = priorClose < priorSma50

  const longCross = rsiPrev < 30 && rsiNow >= 30 && upTrend
  const shortCross = rsiPrev > 70 && rsiNow <= 70 && downTrend
  if (!longCross && !shortCross) return null

  const bias = longCross ? 'long' : 'short'
  const entry = last.c
  const a = atr(bars)

  // Stop beyond the 5-bar extreme with an ATR pad, so ordinary noise around
  // the washout low/high doesn't clip the trade before the mean-revert runs.
  const window5 = bars.slice(-5)
  let sl
  if (bias === 'long') {
    sl = Math.min(...window5.map(b => b.l)) - 0.25 * a
  } else {
    sl = Math.max(...window5.map(b => b.h)) + 0.25 * a
  }

  // tp1 is the mean itself; if price already bounced past SMA20 there is no
  // reversion left to capture, so the target must sit on the profit side.
  const tp1 = sma20
  if (bias === 'long' && tp1 <= entry) return null
  if (bias === 'short' && tp1 >= entry) return null

  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const rr = round2(Math.abs(tp1 - entry) / risk)
  if (rr < minRr) return null

  // tp2 must sit BEYOND tp1 on the profit side — position management scales
  // out at tp1 and runs the rest toward tp2. SMA50 is the WRONG level for it:
  // in a dip-inside-an-uptrend it can sit on either side of entry, so it is
  // not a target at all. Stretch target instead: 1.5x the reversion distance
  // past entry.
  const tp2 = entry + (bias === 'long' ? 1 : -1) * 1.5 * Math.abs(tp1 - entry)

  // Conviction: 8 base. +1 for a deeper washout (RSI extreme past 25/75 in
  // the recent window), +1 when the reversal bar closes with force (top
  // third of its range for longs, bottom third for shorts). Cap 10.
  let conviction = 8
  let extreme = rsiPrev
  for (let i = 1; i <= TROUGH_LOOKBACK; i++) {
    const r = rsi(bars.slice(0, bars.length - i), RSI_PERIOD)
    if (r == null) break
    extreme = bias === 'long' ? Math.min(extreme, r) : Math.max(extreme, r)
  }
  if (bias === 'long' ? extreme < 25 : extreme > 75) conviction += 1
  const range = last.h - last.l
  if (range > 0) {
    const pos = (last.c - last.l) / range
    if (bias === 'long' ? pos >= 2 / 3 : pos <= 1 / 3) conviction += 1
  }
  conviction = Math.min(conviction, 10)

  // Mean-reversion is a fast trade: give it 4 bars of the signal timeframe,
  // then hand back the risk budget. null when the tf string is unreadable.
  const tf = parseTimeframe(timeframe)
  const timeCap = tf ? 4 * (tf.ms / 60_000) : null

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
    strategy: 'rsi_meanrev',
    thesis: bias === 'long'
      ? `RSI washed out below 30 and turned back up, and ${TREND_LOOKBACK} bars before the dip price was already above its 50-bar average — buying the dip back to the 20-bar mean (RSI ${round2(rsiPrev)} → ${round2(rsiNow)}).`
      : `RSI ran hot above 70 and turned back down, and ${TREND_LOOKBACK} bars before the pop price was already below its 50-bar average — selling the pop back to the 20-bar mean (RSI ${round2(rsiPrev)} → ${round2(rsiNow)}).`,
  }
}
