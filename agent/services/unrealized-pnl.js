// ---------------------------------------------------------------------------
// agent/services/unrealized-pnl.js — floating P&L without asking the broker.
//
// WHY. The per-position loss cap's only source of floating P&L was cTrader's
// GET_POSITION_UNREALIZED_PNL_REQ (payloadType 2187, ctrader-ws.js:671), and
// production refuses it on every single pass:
//
//   [wsGetUnrealizedPnl] retry 1/2 — cTrader error: CANT_ROUTE_REQUEST
//   [wsGetUnrealizedPnl] retry 2/2 — cTrader error: CANT_ROUTE_REQUEST
//
// On the same host, token and account, app auth succeeds, account auth
// succeeds, the reconciler succeeds per account, and the guardian holds a spot
// stream across 185 symbols. One request type, permanently unroutable. So the
// cap had no numbers, could not act, and a USDZAR position ran to −$2,186
// against an $800 cap while 83 sixty-second checks passed.
//
// It never needed that call. Floating P&L is (current − entry) × size, and
// both terms are already in hand: the reconciler returns entry price and
// volume, and the guardian is already streaming the price.
//
// THE MONEY CONVERSION IS NOT REIMPLEMENTED HERE. `usdLossPerLot` in
// lib/contracts.js already turns a price distance into USD for USD-quoted
// instruments, USD-BASE pairs (divide by price — without it a JPY-quoted
// distance overstates ~150×) and crosses (via the live rates map). It is what
// the risk sizer uses to decide lot sizes, so it is the most exercised money
// maths in the repo. A second implementation here would be a second answer to
// one question, and the two would drift.
//
// WHAT THIS IS NOT. It excludes swap and commission, which the broker's own
// figure would include. For a cap measured in tens or hundreds of dollars that
// is immaterial, and it is stated rather than hidden: `approximate: true` rides
// on every row. Where the broker figure IS available it should still win — the
// caller prefers it and falls back to this.
// ---------------------------------------------------------------------------

import { usdLossPerLot, contractSize } from '../lib/contracts.js'

/**
 * Floating P&L in USD for one position.
 *
 * @param {{symbol:string, side:string, entryPrice:number, lots:number}} pos
 * @param {number} currentPrice
 * @param {Record<string, number>|null} rates  quote-currency → USD, for crosses
 * @returns {number|null} signed USD, or null when it cannot be computed
 */
export function unrealizedUsd(pos, currentPrice, rates = null) {
  if (!pos?.symbol) return null
  const entry = Number(pos.entryPrice)
  const price = Number(currentPrice)
  const lots = Number(pos.lots)
  if (!(entry > 0) || !(price > 0) || !(lots > 0)) return null

  const long = /^(BUY|LONG|1)$/i.test(String(pos.side ?? ''))
  const short = /^(SELL|SHORT|-1|2)$/i.test(String(pos.side ?? ''))
  // An unrecognised side is not a coin flip. Returning null costs one
  // uncovered position; guessing wrong inverts the sign and could close a
  // WINNER for breaching a loss cap.
  if (!long && !short) return null

  const move = long ? price - entry : entry - price
  // usdLossPerLot takes a MAGNITUDE and returns a positive USD amount, so the
  // direction is reapplied here. Passing the signed distance would make a
  // profit and a loss of the same size indistinguishable.
  const perLot = usdLossPerLot(pos.symbol, Math.abs(move), price, rates)
  if (!Number.isFinite(perLot)) return null
  return (move < 0 ? -1 : 1) * perLot * lots
}

/**
 * Derive a positionId → { net, approximate } map in the shape
 * `wsGetUnrealizedPnl` returns, so callers can swap sources without changing
 * how they read the result.
 *
 * A position with no fresh price is OMITTED rather than defaulted to zero.
 * Zero would read as "flat, nothing to see" to every downstream check — the
 * precise failure this module exists to end.
 *
 * @param {Array} positions      broker positions (reconcile shape)
 * @param {(symbolId:number)=>number|null} priceOf  live mid, null when stale
 * @param {{rates?:object, symbolOf?:(id:number)=>string|null}} opts
 */
export function deriveUnrealizedMap(positions, priceOf, { rates = null, symbolOf = null } = {}) {
  const out = {}
  let covered = 0
  let missingPrice = 0
  for (const bp of positions || []) {
    const pid = bp?.positionId != null ? String(bp.positionId) : null
    if (!pid) continue
    const td = bp.tradeData || {}
    const symbol = symbolOf ? symbolOf(td.symbolId) : (td.symbolName || null)
    if (!symbol) { missingPrice++; continue }
    const price = priceOf ? priceOf(td.symbolId) : null
    if (!(price > 0)) { missingPrice++; continue }

    // Broker `volume` is in units; lots = units / contractSize. The reconciler
    // documents this conversion (reconciler.js:13) and getting it wrong scales
    // every P&L by the contract size — 100x on metals, 10000x on NATGAS.
    const perLot = contractSize(symbol) || 1
    const lots = Number(td.volume) / 100 / perLot
    const net = unrealizedUsd(
      { symbol, side: td.tradeSide, entryPrice: bp.price ?? td.openPrice, lots },
      price, rates,
    )
    if (net == null) { missingPrice++; continue }
    out[pid] = { net, gross: net, approximate: true }
    covered++
  }
  return { map: out, covered, missingPrice }
}
