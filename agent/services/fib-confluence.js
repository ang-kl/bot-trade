// ---------------------------------------------------------------------------
// agent/services/fib-confluence.js — multiple-Fibonacci confluence strategy.
//
// Implements the owner's spec directly: identify several swing points, build a
// Fib retracement GRID from every valid swing pair (not just the latest), and
// trade where the CURRENT price sits inside a cluster of levels from multiple
// grids/ratios — a "high-probability confluence zone".
//
//   1. Swings  → findSwings() (strict N-left/N-right pivots, repaint-safe).
//   2. Grids   → for each recent (swingHigh, swingLow) pair, compute the
//                retracement levels for RATIOS. An up-leg (low→high) yields
//                SUPPORT levels below the high; a down-leg (high→low) yields
//                RESISTANCE levels above the low.
//   3. Confluence → count distinct levels within an ATR-scaled band of price.
//                ≥ MIN_CONFLUENCE of one type = a zone; bias = bounce off
//                support (long) / rejection off resistance (short).
//   4. Execute → entry at price, stop beyond the zone, targets 2R/3R;
//                conviction scales with how many levels stack up.
//
// A STANDALONE strategy alongside fib_618_fade (which stays a single-level
// fade) — nothing about the existing strategy changes.
// ---------------------------------------------------------------------------

import { atr, findSwings } from './fib-strategy.js'

const RATIOS = [0.382, 0.5, 0.618, 0.786]
const MIN_BARS = 40
const ATR_PERIOD = 14
const MAX_SWINGS = 4        // recent swings per side used to build grids
const BAND_ATR = 0.5        // confluence band half-width, in ATR
const MIN_CONFLUENCE = 3    // distinct levels stacking to call it a zone
const SL_ATR_BUFFER = 0.5
const MIN_RR = 1.5

const round = (v) => Math.round(v * 100) / 100

export function computeFibConfluence(bars, timeframe /*, opts = {} */) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null

  const { highs, lows } = findSwings(bars)
  if (!highs.length || !lows.length) return null
  const recentHighs = highs.slice(-MAX_SWINGS)
  const recentLows = lows.slice(-MAX_SWINGS)

  // Build retracement levels from every valid swing pair (the grids).
  const levels = [] // { price, type: 'support'|'resistance', ratio }
  for (const h of recentHighs) {
    for (const l of recentLows) {
      const range = h.price - l.price
      if (!(range > 0)) continue
      if (h.idx > l.idx) {
        // up-leg (low → high): retracement pullbacks are SUPPORT below the high
        for (const r of RATIOS) levels.push({ price: h.price - r * range, type: 'support', ratio: r })
      } else if (l.idx > h.idx) {
        // down-leg (high → low): retracement pullbacks are RESISTANCE above the low
        for (const r of RATIOS) levels.push({ price: l.price + r * range, type: 'resistance', ratio: r })
      }
    }
  }
  if (!levels.length) return null

  const bar = bars[bars.length - 1]
  const price = bar.c
  const band = BAND_ATR * a
  const near = levels.filter(lv => Math.abs(lv.price - price) <= band)
  if (near.length < MIN_CONFLUENCE) return null

  const supports = near.filter(lv => lv.type === 'support')
  const resistances = near.filter(lv => lv.type === 'resistance')

  // Bias from the dominant clustered side: at a support stack → buy the bounce;
  // at a resistance stack → sell the rejection. Ties go to neither (skip).
  let bias = null, cluster = null
  if (supports.length >= MIN_CONFLUENCE && supports.length >= resistances.length) { bias = 'long'; cluster = supports }
  else if (resistances.length >= MIN_CONFLUENCE && resistances.length > supports.length) { bias = 'short'; cluster = resistances }
  if (!bias) return null

  const prices = cluster.map(lv => lv.price)
  const zoneLo = Math.min(...prices)
  const zoneHi = Math.max(...prices)

  const entry = price
  const dir = bias === 'long' ? 1 : -1
  const sl = bias === 'long' ? zoneLo - SL_ATR_BUFFER * a : zoneHi + SL_ATR_BUFFER * a
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const tp1 = entry + dir * 2 * risk
  const tp2 = entry + dir * 3 * risk
  const rr = round(Math.abs(tp1 - entry) / risk)
  if (rr < MIN_RR) return null

  // Conviction scales with how many levels stack (3 → 7 … cap 10).
  const conviction = Math.max(6, Math.min(10, 6 + (cluster.length - MIN_CONFLUENCE) + 1))
  const ratios = [...new Set(cluster.map(c => c.ratio))].sort((x, y) => x - y).join('/')

  return {
    bias, entry, sl, tp1, tp2, conviction, rr, timeframe,
    time_cap_minutes: null,
    strategy: 'fib_confluence',
    thesis: `${cluster.length}-level Fibonacci confluence ${bias === 'long' ? 'support' : 'resistance'} on ${timeframe} at ${round(entry)} (ratios ${ratios} across multiple swing-pair grids). ${bias === 'long' ? 'Buying the bounce' : 'Selling the rejection'} off the stacked zone, stop beyond it, targets 2R/3R.`,
  }
}
