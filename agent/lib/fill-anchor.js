// ---------------------------------------------------------------------------
// agent/lib/fill-anchor.js — the bracket a trade actually has, and the entry
// drift that would make it a different trade (owner "do both", 03-09-2026).
//
// THE DEFECT. A proposal carries an absolute entry, stop and target, and the
// gate measures R:R on those. The market order then carries the stop and
// target as DISTANCES (relativeStopLoss / relativeTakeProfit), so the broker
// anchors them to the FILL — but the ledger stored the proposal's absolute
// prices, and every later re-assert (target-restore, a stop amend that must
// re-send the target, the keeper's current_tp) pushed the proposal-anchored
// target back onto a fill-anchored position. Measured 02-09-2026:
//
//   NATGAS rsi2  proposal 2.893 / sl 2.87125 / tp 2.9191 (1.20R), fill 2.907
//                → broker stop at fill − 0.022 = 2.885 (as the ACK said),
//                  target restored to 2.9191 → 0.34R against a 1.64R stop
//   AUDUSD rsi2  proposal 0.71275, fill 0.71332 → target at 0.74R
//
// TWO FIXES, PURE HERE, WIRED IN loop.js autoTrade():
//   anchorBracketToFill — the ledger's stop and target are the planned
//     DISTANCES from the fill, matching what the broker holds, so every
//     later write carries the geometry the gate admitted.
//   entryDrift / entryDriftVeto — before the order goes out, the live quote is
//     compared with the proposal's entry; a drift beyond
//     maxEntryDriftFracOfSL × stop distance is a post-approval veto, because
//     the trade that would fill is not the trade that was approved.
// ---------------------------------------------------------------------------

const num = (v) => (v == null || v === '' ? null : Number(v))
const fin = (v) => Number.isFinite(v)

/**
 * Re-anchor a proposal's bracket to the fill, keeping the planned distances.
 * Returns the proposal's own prices when there is no fill or no entry to
 * measure from — never invents a bracket.
 *
 * @param {{side:'BUY'|'SELL'|'long'|'short', proposalEntry:number, fill:number|null,
 *   sl:number|null, tp1:number|null, tp2?:number|null}} p
 * @returns {{sl:number|null, tp1:number|null, tp2:number|null, slDistance:number|null,
 *   tpDistance:number|null, anchored:boolean, shift:number|null}}
 */
export function anchorBracketToFill({ side, proposalEntry, fill, sl, tp1, tp2 = null }) {
  const entry = num(proposalEntry), f = num(fill)
  const s = num(sl), t1 = num(tp1), t2 = num(tp2)
  const long = /^(buy|long)$/i.test(String(side))
  const slDistance = fin(entry) && fin(s) ? Math.abs(entry - s) : null
  const tpDistance = fin(entry) && fin(t1) ? Math.abs(t1 - entry) : null
  const tp2Distance = fin(entry) && fin(t2) ? Math.abs(t2 - entry) : null
  if (!fin(f) || !fin(entry) || f <= 0) {
    return { sl: s, tp1: t1, tp2: t2, slDistance, tpDistance, anchored: false, shift: null }
  }
  const dir = long ? 1 : -1
  return {
    sl: slDistance != null ? f - dir * slDistance : s,
    tp1: tpDistance != null ? f + dir * tpDistance : t1,
    tp2: tp2Distance != null ? f + dir * tp2Distance : t2,
    slDistance,
    tpDistance,
    anchored: true,
    // adverse-positive: how far the fill moved AGAINST the trade from the plan
    shift: dir * (f - entry),
  }
}

/**
 * Adverse-positive drift of the live quote from the proposal's entry, in
 * price and as a fraction of the stop distance. A BUY fills at the ask, a
 * SELL at the bid. Null when there is nothing to measure.
 */
export function entryDrift({ side, proposalEntry, quote, slDistance }) {
  const entry = num(proposalEntry)
  const bid = num(quote?.bid), ask = num(quote?.ask)
  const long = /^(buy|long)$/i.test(String(side))
  const px = long ? ask : bid
  if (!fin(entry) || !fin(px)) return { drift: null, fracOfSL: null, price: fin(px) ? px : null }
  const drift = long ? px - entry : entry - px
  const d = num(slDistance)
  return { drift, fracOfSL: fin(d) && d > 0 ? drift / d : null, price: px }
}

/**
 * The veto reason when the drift exceeds the configured fraction of the stop
 * distance, else null. `maxEntryDriftFracOfSL` ≤ 0 disables the guard. A
 * favourable drift (negative) never vetoes.
 */
export function entryDriftVeto(cfg, { drift, fracOfSL, price }, { symbolDigits = 5 } = {}) {
  const frac = num(cfg?.maxEntryDriftFracOfSL)
  if (!fin(frac) || frac <= 0) return null
  if (!fin(fracOfSL) || fracOfSL <= frac) return null
  const d = Math.max(0, Math.min(8, Math.round(symbolDigits)))
  return `entry_drift: live ${Number(price).toFixed(d)} is ${Number(drift).toFixed(d)} (${(fracOfSL * 100).toFixed(0)}% of SL distance) past the proposal entry — limit ${(frac * 100).toFixed(0)}%`
}
