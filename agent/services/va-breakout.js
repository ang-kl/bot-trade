// ---------------------------------------------------------------------------
// agent/services/va-breakout.js — Value-Area breakout (owner spec, 2026-07-26).
//
// The owner's method, verbatim in structure:
//
//   "Monitor the previous day's VAH and VAL. If the current day opens within
//    the Value Area, wait for a confirmed breakout above or below it. A
//    candle close below the VAL confirms that sellers are in control … a
//    close above the VAH highlights bullish dominance. Once the breakout
//    direction is confirmed, look for a pullback to the breakout level to
//    enter. Place your stop loss below/under the range."
//
// So this strategy fires on the PULLBACK, not the breakout candle: the
// sequence is open-inside-VA → a bar CLOSES beyond the edge (confirmation) →
// price returns to the broken level (entry) while remaining on the breakout
// side of it. Three distinct facts, checked in order, each with the bar that
// carries it.
//
// It complements vp-value rather than replacing it: vp-value FADES the edge
// inside a balanced session (rotation to the POC); this one trades the edge
// GIVING WAY after an inside open. The `structure` field from volume-structure
// is what keeps them out of each other's regime — this strategy only exists
// when the session opened 'ranging'.
//
// The owner's continuation cases (open above VAH = bullish, VAH becomes
// support; open below VAL = bearish) are also handled: an open OUTSIDE value
// with a pullback to the boundary is the same entry geometry with the
// confirmation already given by the open itself.
//
// TARGETS. TP1 is one value-area height beyond the broken edge — the measured
// move of the range, same convention as donchian's. TP2 is 1.5×. The stop
// goes beyond the OPPOSITE side of the pullback structure: for a fresh
// breakout that is back inside the value area past the VPOC — the level where
// "sellers are in control" (or buyers) has been falsified — bounded to
// SL_MAX_ATR so a wide value area cannot demand an oversized stop.
//
// FVG stops from the owner's note are still NOT implemented here — but the
// reason originally given was wrong and is corrected (2026-07-29). This
// codebase DOES have fair-value-gap detection, and did when that was written:
// `findFvgZones` (lib/indicators.js, with fill marking) and `findFVGs`
// (fib-strategy.js). What was missing was a strategy built on them, which now
// exists as services/fvg-strategy.js.
//
// So the honest statement is narrower: this strategy's stop still sits at the
// value-area edge, because moving it to a gap boundary would change where
// va_breakout is proven wrong, and that is a strategy change wanting its own
// backtest — not a detector gap. Recorded as future work on those terms.
// ---------------------------------------------------------------------------

import { atr } from './fib-strategy.js'
import { volumeStructure, inLowVolumeNode } from '../lib/volume-structure.js'

const MIN_BARS = 60            // needs at least two sessions of bars in practice
const ATR_PERIOD = 14
const CONFIRM_LOOKBACK = 12    // how far back the confirming close may sit
const PULLBACK_TOL_ATR = 0.35  // "at the level" for the pullback entry
const SL_ATR_BUFFER = 0.5
const SL_MAX_ATR = 2.5         // stop distance cap — a huge VA must not size a huge stop
const MIN_RR = 1.5

const round2 = (v) => Math.round(v * 100) / 100

/**
 * Same contract as every other strategy: bars + timeframe in, signal | null.
 * `opts.structure` lets tests (and the C++ feeder later) inject a prepared
 * volume structure; normally it is derived from the bars.
 */
export function computeVaBreakout(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null

  const vs = opts.structure ?? volumeStructure(bars)
  if (!vs) return null
  const { prev, structure } = vs
  const last = bars.length - 1
  const bar = bars[last]

  // Which edge is in play, and is the confirmation there?
  //
  //  ranging open  → need a CLOSED bar beyond VAH (long) or VAL (short)
  //                  within the current session (the owner's breakout case).
  //  bullish open  → VAH is support; the open itself is the confirmation.
  //  bearish open  → VAL is resistance; likewise.
  let bias = null
  let level = null
  if (structure === 'ranging') {
    const confirmed = findConfirmedBreak(bars, vs)
    if (!confirmed) return null
    bias = confirmed.bias
    level = confirmed.level
  } else if (structure === 'bullish') {
    bias = 'long'; level = prev.vah
  } else if (structure === 'bearish') {
    bias = 'short'; level = prev.val
  }
  if (!bias) return null

  const dir = bias === 'long' ? 1 : -1

  // THE PULLBACK. Price must have RETURNED to the broken level — within
  // tolerance — while the bar still closes on the breakout side of it. A bar
  // that closes back through the level is a failed breakout, which is the
  // rejection case the owner's VAH note describes ("high probability of
  // returning back to the VPOC") — that trade belongs to vp-value, not here.
  const touch = bias === 'long' ? bar.l : bar.h
  if (Math.abs(touch - level) > PULLBACK_TOL_ATR * a) return null
  if (dir * (bar.c - level) <= 0) return null

  // LVN check, per the owner's "rejection wick near the LVN" note, inverted
  // as a caution: an entry INSIDE one of yesterday's low-volume nodes is a
  // price the market has already shown it does not want to trade at — the
  // pullback is likely to keep travelling through it. Refuse rather than
  // guess; the LVN band's edges are where interest resumes.
  if (inLowVolumeNode(bar.c, vs.lvns)) return null

  const entry = bar.c

  // STOP: beyond the VPOC (the falsification level for "one side is in
  // control"), buffered — but never further than SL_MAX_ATR, and never
  // nearer than the plain ATR buffer beyond the broken level itself.
  let slDist = dir * (entry - prev.vpoc) + SL_ATR_BUFFER * a
  const slMin = Math.abs(entry - level) + SL_ATR_BUFFER * a
  slDist = Math.max(slDist, slMin)
  slDist = Math.min(slDist, SL_MAX_ATR * a)
  if (!(slDist > 0)) return null
  const sl = entry - dir * slDist

  // TARGETS: measured move of the value area beyond the broken edge.
  const tp1 = level + dir * prev.height
  const tp2 = level + dir * 1.5 * prev.height
  if (dir * (tp1 - entry) <= 0) return null

  const rr = round2(Math.abs(tp1 - entry) / slDist)
  if (rr < MIN_RR) return null

  // Conviction: 8 base; +1 when the VPOC has been migrating in the trade's
  // direction across recent sessions (the owner's institutional-repositioning
  // read); +1 when the session opened already outside value (continuation,
  // the stronger structure).
  let conviction = 8
  const mig = vs.migration
  if (mig && mig.direction === (bias === 'long' ? 'up' : 'down')) conviction++
  if (structure !== 'ranging') conviction++
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
    strategy: 'va_breakout',
    thesis: structure === 'ranging'
      ? `Opened inside yesterday's value area, then a bar closed ${bias === 'long' ? 'above the VAH' : 'below the VAL'} `
        + `(${round2(level)}) and price has pulled back to the level while holding ${bias === 'long' ? 'above' : 'below'} it. `
        + `Target is one value-area height ${bias === 'long' ? 'up' : 'down'}; stop beyond the VPOC (${round2(prev.vpoc)}).`
      : `Opened ${structure === 'bullish' ? 'above yesterday’s VAH' : 'below yesterday’s VAL'} (${round2(level)}) — `
        + `${structure} continuation. Pullback to the level is the entry; the level is now ${vs.role}. `
        + `Target one value-area height on; stop beyond the VPOC (${round2(prev.vpoc)}).`,
  }
}

/**
 * The confirming close for a ranging open: the most recent bar within
 * CONFIRM_LOOKBACK that CLOSED beyond either edge of yesterday's value area,
 * looking only at bars of the CURRENT session (a close beyond the edge
 * yesterday confirmed nothing about today's open).
 *
 * The confirming bar must not be the live bar itself — "a candle close"
 * means a completed candle, and the current bar's close is still moving.
 */
function findConfirmedBreak(bars, vs) {
  const { prev, openMs, sessionBars } = vs
  const last = bars.length - 1
  const firstSessionIdx = bars.length - sessionBars
  const from = Math.max(firstSessionIdx, last - CONFIRM_LOOKBACK)
  for (let i = last - 1; i >= from; i--) {
    if (bars[i].t < openMs) break
    if (bars[i].c > prev.vah) return { bias: 'long', level: prev.vah }
    if (bars[i].c < prev.val) return { bias: 'short', level: prev.val }
  }
  return null
}
