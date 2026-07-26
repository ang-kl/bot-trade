// ---------------------------------------------------------------------------
// agent/services/ema-pullback.js
//
// EMA trend-pullback strategy (two-sided). Trend is defined by EMA20 vs
// EMA50 (20 above 50 = uptrend), optionally confirmed by a stacked EMA200
// (owner, 2026-07-26: EMA89 replaced with EMA200 as the regime filter — a
// slower, more conservative trend confirmation).
// A signal fires when the LAST CLOSED bar dips back to touch or undercut
// EMA20 (low <= ema20 for longs) but then closes back on the trend side of
// EMA20 with the trend still intact (close above EMA50). Mirrored for shorts.
//
// Guards (constraints, not tuning knobs):
// - need >= MIN_BARS so the EMA seed bias has decayed. An SMA-seeded EMA(n)
//   still carries (1 - 2/(n+1))^m of its seed after m recursive updates; at
//   the previous 60-bar minimum EMA50 was ~67% seed, i.e. the "trend" the
//   gate keyed on was largely an artefact of the warm-up window. EMA50 needs
//   ~200 bars to bring its seed weight under 0.5% — but EMA200 needs far
//   more: at 200 bars it STILL carries ~13.5% seed bias (0.99005^200), an
//   order of magnitude worse than what this file already refused to accept
//   for the old EMA89 filter (~1.1% at 200 bars). MIN_BARS is 450 so EMA200
//   reaches that same ~1% standard (0.99005^450 ≈ 0.011) — bumping the
//   period without bumping this would reopen the exact warm-up-bias problem
//   MIN_BARS exists to close, just at a new period.
// - ATR(14) must be available and the pullback depth must be <= 2*ATR:
//   deeper pullbacks are usually trend breaks, not healthy retracements
// - the ENTRY-TO-STOP distance must sit inside [MIN_SL_ATR, MAX_SL_ATR]*ATR.
//   Too tight is widened to the floor; too wide is VETOED, never tightened —
//   pulling a stop inside the structure that justifies it converts a
//   rejected trade into a swept one. See "Why the ceiling vetoes" below.
//
// Levels: entry = close (or EMA20 in pendingSetup mode), sl = min(low, ema50)
// - 0.25*ATR clamped as above (mirror for shorts), tp1 at 2R and tp2 at 3R,
// so rr is a fixed 2.00 - comfortably above the shared 1.5 floor every
// strategy must clear.
//
// Why the ceiling vetoes (2026-07 regression, EMA book -$823 over 2 trades):
// MAX_PULLBACK_ATR bounded the dip below EMA20 but NOTHING bounded the
// EMA20-EMA50 gap, and `min(low, ema50)` always takes the LOWER of the two.
// In a fast trend EMA50 detaches several ATR below EMA20, so R inflates
// without limit. Every downstream rule is expressed in R - beTriggerR 0.7,
// partialTrailR 0.5, runnerTriggerR 2.5 in position-manager.js, and tp1 at
// 2R here - so an inflated R silently disables breakeven, disables the
// trail, and parks TP1 at a distance price will not travel. The position
// then lives until it stops out for a full, correctly-sized loss. Bounding R
// is therefore a trade-management fix, not just a sizing one.
//
// NO LLM calls - pure OHLC arithmetic, same spirit as fib-strategy.js.
// ---------------------------------------------------------------------------

import { atr, rsi } from './fib-strategy.js'

const MIN_BARS = 450          // see the EMA200 seed-decay note above
const ATR_PERIOD = 14
const MAX_PULLBACK_ATR = 2    // pullback deeper than 2*ATR = broken leg
const SL_ATR_BUFFER = 0.25    // stop sits a quarter-ATR beyond structure
const MIN_SL_ATR = 0.8        // floor: a sub-noise stop is widened to here
const MAX_SL_ATR = 3.0        // ceiling: wider than this -> no trade
const MIN_RR = 1.5            // shared floor across all strategies
const TREND_EMA_PERIOD = 200  // regime filter; EMA20 > EMA50 > EMA200 = stacked
const SLOPE_LOOKBACK = 5
const SWING_LOOKBACK = 10     // bars of swing extreme used by pendingSetup

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

/** Lowest low / highest high over the last `n` bars (inclusive of the last). */
export function swingLow(bars, n) {
  let v = Infinity
  for (let i = Math.max(0, bars.length - n); i < bars.length; i++) v = Math.min(v, bars[i].l)
  return v
}
export function swingHigh(bars, n) {
  let v = -Infinity
  for (let i = Math.max(0, bars.length - n); i < bars.length; i++) v = Math.max(v, bars[i].h)
  return v
}

/**
 * Clamp the entry-to-stop distance into the ATR band.
 *
 * Asymmetric by design:
 *   below the floor   -> widen (moving a stop AWAY from structure is safe)
 *   above the ceiling -> return null (moving a stop TOWARD structure is not)
 *
 * @returns {{ sl:number, dist:number, widened:boolean } | null}
 */
export function clampStop({ entry, rawSl, dir, atrValue, minSlAtr, maxSlAtr }) {
  const rawDist = Math.abs(entry - rawSl)
  if (!(rawDist > 0) || !(atrValue > 0)) return null
  if (rawDist > maxSlAtr * atrValue) return null // too wide -> veto, do not tighten
  const dist = Math.max(rawDist, minSlAtr * atrValue)
  return { sl: entry - dir * dist, dist, widened: dist > rawDist }
}

/**
 * compute(bars, timeframe, opts) -> null or the shared signal shape.
 * Only the last CLOSED bar can trigger - no lookahead, no repainting.
 *
 * opts:
 *   pendingSetup   {boolean} park a resting order at EMA20 instead of taking
 *                  the close. Mirrors computeFibSignal's pendingSetup flag.
 *   requireStack   {boolean} require EMA20 > EMA50 > EMA200 (default true)
 *   minSlAtr / maxSlAtr {number} override the stop band
 *   timeCapBars    {number|null} bars of patience -> time_cap_minutes
 *   timeframeMinutes {number|null} minutes per bar, for the time cap
 */
export function computeEmaPullback(bars, timeframe, opts = {}) {
  const {
    pendingSetup = false,
    requireStack = true,
    minSlAtr = MIN_SL_ATR,
    maxSlAtr = MAX_SL_ATR,
    timeCapBars = null,
    timeframeMinutes = null,
  } = opts

  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  const ema20s = emaSeries(bars, 20)
  const ema50s = emaSeries(bars, 50)
  const trendEmaSeries = emaSeries(bars, TREND_EMA_PERIOD)
  const i = bars.length - 1
  const bar = bars[i]
  const ema20 = ema20s[i]
  const ema50 = ema50s[i]
  const trendEma = trendEmaSeries[i]
  if (ema20 == null || ema50 == null) return null
  if (requireStack && trendEma == null) return null

  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null // ATR must be available - flat data is untradeable

  const upTrend = ema20 > ema50 && (!requireStack || ema50 > trendEma)
  const downTrend = ema20 < ema50 && (!requireStack || ema50 < trendEma)

  let bias = null
  if (pendingSetup) {
    // Pre-touch: the trend is intact and price sits on the trend side of
    // EMA20, so we park the order AT EMA20 and let the dip come to us.
    // No pullback-depth guard - the pullback has not happened yet.
    if (upTrend && bar.c > ema20) bias = 'long'
    else if (downTrend && bar.c < ema20) bias = 'short'
  } else if (upTrend && bar.l <= ema20 && bar.c > ema20 && bar.c > ema50) {
    // uptrend: bar dipped into EMA20 but closed back above it, trend intact
    if (ema20 - bar.l > MAX_PULLBACK_ATR * a) return null // too deep
    bias = 'long'
  } else if (downTrend && bar.h >= ema20 && bar.c < ema20 && bar.c < ema50) {
    // downtrend mirror: bar poked up into EMA20 but closed back below
    if (bar.h - ema20 > MAX_PULLBACK_ATR * a) return null // too deep
    bias = 'short'
  }
  if (!bias) return null

  const dir = bias === 'long' ? 1 : -1
  const entry = pendingSetup ? ema20 : bar.c

  // Structural stop = the level that INVALIDATES THIS PULLBACK, i.e. the dip
  // low itself. EMA50 is a TREND-invalidation level, an order of magnitude
  // further away; anchoring the stop to it (the old `min(low, ema50)`) meant
  // the stop was always the wider of the two and R tracked EMA separation
  // rather than the setup. EMA50 now gates the trend and nothing else.
  // In pending mode no dip has printed yet, so the swing extreme of the last
  // SWING_LOOKBACK bars stands in for it.
  const lo = pendingSetup ? swingLow(bars, SWING_LOOKBACK) : bar.l
  const hi = pendingSetup ? swingHigh(bars, SWING_LOOKBACK) : bar.h
  const rawSl = bias === 'long'
    ? lo - SL_ATR_BUFFER * a
    : hi + SL_ATR_BUFFER * a

  const clamped = clampStop({ entry, rawSl, dir, atrValue: a, minSlAtr, maxSlAtr })
  if (!clamped) return null // stop wider than the ceiling - stand aside

  const { sl, dist: risk, widened } = clamped
  const tp1 = entry + dir * 2 * risk
  const tp2 = entry + dir * 3 * risk

  const rr = round2(Math.abs(tp1 - entry) / risk) // fixed 2.00 by design
  if (rr < MIN_RR) return null

  // Conviction: 8 base, +1 when EMA20 is sloping with the trend over the
  // last 5 bars, +1 when RSI sits in the 40-60 band (a healthy pullback,
  // not an exhaustion move). Capped at 10. Pending setups stay at the 8
  // base, matching computeFibSignal - nothing has reacted yet to score.
  let conviction = 8
  if (!pendingSetup) {
    const ema20Prev = ema20s[i - SLOPE_LOOKBACK]
    if (ema20Prev != null && dir * (ema20 - ema20Prev) > 0) conviction += 1
    const r = rsi(bars, 14)
    if (r != null && r >= 40 && r <= 60) conviction += 1
    conviction = Math.min(conviction, 10)
  }

  const stackNote = requireStack ? ` with EMA${TREND_EMA_PERIOD} stacked beyond` : ''
  const direction = bias === 'long' ? 'Uptrend' : 'Downtrend'
  const thesis = pendingSetup
    ? `${direction} on ${timeframe} (EMA20 ${bias === 'long' ? 'above' : 'below'} EMA50${stackNote}). Resting order parked at the EMA20 line, stop beyond the 10-bar swing, targets at 2R and 3R.`
    : bias === 'long'
      ? `Uptrend on ${timeframe} (EMA20 above EMA50${stackNote}). Price dipped to the EMA20 line and closed back above it - buying the pullback, stop below the dip, targets at 2R and 3R.`
      : `Downtrend on ${timeframe} (EMA20 below EMA50${stackNote}). Price bounced up to the EMA20 line and closed back below it - selling the pullback, stop above the bounce, targets at 2R and 3R.`

  return {
    bias,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    rr,
    timeframe,
    time_cap_minutes:
      timeCapBars != null && timeframeMinutes != null
        ? timeCapBars * timeframeMinutes
        : null,
    strategy: 'ema_pullback',
    // Telemetry for the awareness layer - why this stop is where it is.
    sl_atr_mult: round2(risk / a),
    sl_widened_to_floor: widened,
    stack_confirmed: requireStack,
    thesis,
  }
}
