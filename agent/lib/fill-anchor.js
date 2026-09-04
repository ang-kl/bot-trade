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

// ---------------------------------------------------------------------------
// THE FILL THE ANCHOR NEVER SAW (04-09-2026). The C++ sidecar answers a
// market order with the FIRST execution event echoing its clientMsgId —
// ORDER_ACCEPTED — which carries the position id and no deal, so
// `exec.deal.executionPrice` is absent on every cpp-path market fill and the
// anchoring above ran with `anchored: false` since it shipped. Measured:
// 2020.HK rsi2 on ACCT-DEMO-4, proposal 75.79, broker fill 76.21 (0.44R of
// slippage on a 0.96 stop); the ledger kept 75.79, the position manager moved
// the stop to "breakeven" at 76.03 — 0.18 UNDER the real fill — and the trade
// closed at 76.19 for −$118 while the manager believed it had locked +0.25R.
// The broker's own bracket was fill-anchored (stop 75.25), and the protection
// audit reported the mismatch every minute without adopting it.
//
// The fill is on the position the broker already holds: the reconcile read
// (`exec.reconcile(creds)` → `{ position: [...] }`) carries `price` (or
// `tradeData.openPrice`) per positionId. So: when the order answer has no
// price, read the position a bounded number of times and take its price.
// A read that never finds it leaves the proposal entry standing, as before —
// never a guess.
// ---------------------------------------------------------------------------

/**
 * The open price of one position in a reconcile payload, or null.
 * Ids are compared through their integer spelling (the sidecar has returned
 * "234698574.0" before).
 */
export function fillFromReconcile(rec, positionId) {
  const want = normId(positionId)
  if (want == null) return null
  const list = Array.isArray(rec?.position) ? rec.position : Array.isArray(rec) ? rec : []
  for (const p of list) {
    const id = normId(p?.positionId ?? p?.tradeData?.positionId)
    if (id !== want) continue
    const px = num(p?.price ?? p?.tradeData?.openPrice)
    return fin(px) && px > 0 ? px : null
  }
  return null
}

function normId(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(v)
}

/**
 * Confirm a fill price from the position read, retrying a few times because
 * the position can land at the broker a moment after the ORDER_ACCEPTED
 * answer. Returns the price or null; never throws (a failed read is a null).
 *
 * @param {() => Promise<any>} readPositions  e.g. () => exec.reconcile(creds)
 * @param {string|number} positionId
 * @param {{attempts?:number, delayMs?:number, sleep?:(ms:number)=>Promise<void>}} opts
 */
export async function confirmFill(readPositions, positionId, { attempts = 3, delayMs = 700, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (normId(positionId) == null) return null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      const rec = await readPositions()
      const px = fillFromReconcile(rec, positionId)
      if (px != null) return px
    } catch { /* a failed read is a null, retried below */ }
    if (i < attempts - 1) await sleep(delayMs)
  }
  return null
}
