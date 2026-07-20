// ---------------------------------------------------------------------------
// agent/services/vp-value.js — Volume-Profile value-area rotation (owner: "VP
// and VWAP build"). A standalone STRATEGY: build the volume profile, and when
// price reaches the edge of the value area (VAL/VAH) and shows a reaction bar
// back inside it, fade the edge expecting rotation back toward the Point of
// Control. Mean-reversion-kind, so the regime gate keeps it out of trends and
// whipsaws where value-area edges get run over.
//
// Returns the standard strategy signal object. SL sits just beyond the value-
// area edge (where the rotation thesis is wrong); TP1 is the POC (the profile's
// centre of gravity), TP2 the opposite value-area edge.
// ---------------------------------------------------------------------------

import { atr } from './fib-strategy.js'
import { volumeProfile } from '../lib/indicators.js'

const MIN_BARS = 40
const ATR_PERIOD = 14
const EDGE_TOLERANCE_ATR = 0.5  // "at" the edge = within this many ATR
const SL_ATR_BUFFER = 0.5
const MIN_RR = 1.5

const round2 = (v) => Math.round(v * 100) / 100

export function computeVpValue(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null

  const vp = volumeProfile(bars, { type: opts.vpType || 'composite', buckets: 24 })
  const { pocPrice, vahPrice, valPrice } = vp
  if (pocPrice == null || vahPrice == null || valPrice == null) return null
  if (!(vahPrice > valPrice)) return null // degenerate/flat profile

  const bar = bars[bars.length - 1]
  const tol = EDGE_TOLERANCE_ATR * a

  let bias = null
  let edge = null
  // At the value-area LOW and closed back UP into the area → long toward POC.
  if (Math.abs(bar.l - valPrice) <= tol && bar.c > valPrice && bar.c < pocPrice) {
    bias = 'long'; edge = valPrice
  // At the value-area HIGH and closed back DOWN into the area → short toward POC.
  } else if (Math.abs(bar.h - vahPrice) <= tol && bar.c < vahPrice && bar.c > pocPrice) {
    bias = 'short'; edge = vahPrice
  }
  if (!bias) return null

  const entry = bar.c
  const dir = bias === 'long' ? 1 : -1
  const sl = bias === 'long' ? edge - SL_ATR_BUFFER * a : edge + SL_ATR_BUFFER * a
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const tp1 = pocPrice                        // rotation to the centre of gravity
  const tp2 = bias === 'long' ? vahPrice : valPrice // full rotation to the far edge
  // TP1 must actually be in the profit direction and clear of entry.
  if (dir * (tp1 - entry) <= 0) return null
  const rr = round2(Math.abs(tp1 - entry) / risk)
  if (rr < MIN_RR) return null

  // Conviction: 8 base, +1 when the reaction bar closed decisively inside
  // (>0.3 ATR past the edge), +1 when the POC is a meaty distance away
  // (worth the rotation).
  let conviction = 8
  if (Math.abs(bar.c - edge) > 0.3 * a) conviction += 1
  if (Math.abs(pocPrice - entry) > 1.5 * a) conviction += 1
  conviction = Math.min(conviction, 10)

  return {
    bias, entry, sl, tp1, tp2, conviction, rr, timeframe,
    time_cap_minutes: null,
    strategy: 'vp_value',
    thesis: bias === 'long'
      ? `Price tested the value-area low (${round2(valPrice)}) on the ${timeframe} volume profile and closed back inside — fading the edge for a rotation up to the POC (${round2(pocPrice)}), stop below the VAL.`
      : `Price tested the value-area high (${round2(vahPrice)}) on the ${timeframe} volume profile and closed back inside — fading the edge for a rotation down to the POC (${round2(pocPrice)}), stop above the VAH.`,
  }
}
