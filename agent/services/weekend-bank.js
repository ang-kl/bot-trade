// ---------------------------------------------------------------------------
// agent/services/weekend-bank.js — bank profits before a long market closure.
//
// Owner (2026-07-20, after a losing Monday open): "You should close to take
// profit even if I didn't set it well — I was sleeping." Positions held
// through the weekend under WEEKEND:HOLD gapped at the Sydney open and
// floating profit (NatGas +$280) became losses that no stop could catch —
// a gap jumps OVER broker-side SL/TP.
//
// Rule: inside the final window before a symbol's close (default 75 min),
// when the coming closure is LONG (default ≥ 12h — weekends and holidays,
// not the ordinary overnight break), close any position on that symbol that
// is in profit, banking the move instead of gifting it to the gap. Losing
// positions are left alone (the hold rule still applies — selling a loser
// into a thin pre-close market locks the loss at the worst prices).
//
// Applies to EVERY position on the selected account — bot AND owner-placed:
// the owner's manual trades deserve the same protection. Toggle:
// agent_state `weekend_bank` ('true' default; 'false' disables). One-shot
// per position per closure via a state marker.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { nextCloseInfo } from './symbol-hours.js'

/** Pure decision: bank this position now? */
export function shouldBank({ open, closesInSec, closureSec, side, entry, price, windowMin = 75, minClosureHrs = 12, minMovePct = 0 }) {
  if (open !== true) return false
  if (!Number.isFinite(closesInSec) || closesInSec > windowMin * 60) return false
  if (!Number.isFinite(closureSec) || closureSec < minClosureHrs * 3600) return false
  if (!(entry > 0) || !(price > 0)) return false
  const dir = String(side).toUpperCase() === 'SELL' ? -1 : 1
  const movePct = ((price - entry) * dir / entry) * 100
  return movePct > minMovePct
}

/**
 * Sweep broker positions ahead of a long closure. `positions` are the raw
 * reconcile rows (with symbolName attached); prices come from live spot
 * quotes at the CLOSING side (BUY closes at bid, SELL at ask).
 */
export async function runWeekendBank(db, creds, positions, { windowMin = 75, minClosureHrs = 12 } = {}) {
  if ((getState(db, 'weekend_bank') || 'true') === 'false') return { skipped: 'off', banked: [] }
  const banked = []
  const { closePosition } = await import('../lib/exec-engine.js')
  const { wsGetSpotOnce } = await import('../lib/ctrader-ws.js')

  for (const p of positions || []) {
    const td = p.tradeData || {}
    const symbol = String(p.symbolName || '').toUpperCase()
    if (!symbol || !td.symbolId || !p.positionId) continue

    const info = nextCloseInfo(db, symbol)
    if (info.open !== true || !Number.isFinite(info.closes_in_sec) || !Number.isFinite(info.closure_sec)) continue
    if (info.closes_in_sec > windowMin * 60 || info.closure_sec < minClosureHrs * 3600) continue

    // One-shot per position per closure — the marker clears once the market
    // has reopened (closure passed), so next weekend re-arms automatically.
    const key = `wb_done_${p.positionId}`
    try {
      const prev = JSON.parse(getState(db, key) || 'null')
      if (prev && Date.now() < prev.until) continue
    } catch { /* fresh */ }

    let price = null
    try {
      const q = await wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      const side = td.tradeSide === 2 || td.tradeSide === 'SELL' ? 'SELL' : 'BUY'
      price = side === 'SELL' ? q?.ask : q?.bid // the price a close would get
      if (!shouldBank({ open: true, closesInSec: info.closes_in_sec, closureSec: info.closure_sec, side, entry: p.price, price, windowMin, minClosureHrs })) continue

      await closePosition(creds, { positionId: parseInt(p.positionId), volume: td.volume })
      setState(db, key, JSON.stringify({ until: Date.now() + (info.closes_in_sec + info.closure_sec) * 1000 }))
      const movePct = Math.round(((price - p.price) * (side === 'SELL' ? -1 : 1) / p.price) * 10000) / 100
      banked.push({ symbol, positionId: p.positionId, side, movePct })
      try {
        const { sendMessage } = await import('./telegram.js')
        await sendMessage(`💰 WEEKEND BANK: closed ${symbol} ${side} (position ${p.positionId}) at ${price} — +${movePct}% move banked before the market closes for ${Math.round(info.closure_sec / 3600)}h. Holding profit through a long closure risks the reopen gap.`)
      } catch { /* non-fatal */ }
    } catch (err) {
      // A failed close must be LOUD — the whole point is acting while the
      // owner sleeps.
      try {
        const { sendMessage } = await import('./telegram.js')
        await sendMessage(`⚠️ WEEKEND BANK FAILED: could not close ${symbol} position ${p.positionId} before the long closure — ${err.message}. Check cTrader.`)
      } catch { /* non-fatal */ }
    }
  }
  return { banked }
}
