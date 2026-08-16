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

// ---------------------------------------------------------------------------
// GAP-PRONE EXTENSION (owner, 2026-08-16: "gap-prone list only")
//
// The profit-only rule above was right about the general case and wrong about
// a specific one. Its stated reasoning — "selling a loser into a thin
// pre-close market locks the loss at the worst prices" — assumes the
// alternative is a loss of roughly the size you already see. Measured over the
// 35 non-burn-in trades closed since 2026-08-04, it is not:
//
//   JPYX   -7.93R      GER40  -1.50R      US30   -2.68R
//   (close_reason: "stopped beyond the SL — gap/slippage through the stop")
//
// Losses average -1.41R against a -1.00R plan, and that 41% overrun is the
// larger half of the realised-R:R gap (winners come in at +1.48R against a
// 2.00R plan). A gap jumps OVER a broker-side stop, so no stop placement
// fixes it — the only protection is being flat. Locking -1.0R in a thin
// market beats -7.93R after the gap.
//
// So for symbols ON the gap-prone list, the sign test is dropped: the
// position is flattened whether it is up or down. Everything OFF the list
// keeps the existing profit-only behaviour exactly. That split is the owner's
// call, taken so FX majors keep running through ordinary closures.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { nextCloseInfo } from './symbol-hours.js'

/**
 * Symbols whose reopen gap has actually cost more than 1R, plus the classes
 * they belong to. Index CFDs, single-stock CFDs and the synthetic currency
 * indices all price off a cash market that stops trading; FX majors and crypto
 * do not, which is why they are absent.
 *
 * Deliberately an EXPLICIT list rather than a pattern: a regex that quietly
 * grows to cover new symbols would change risk behaviour without anyone
 * deciding to, and this list flattens losers.
 */
export const DEFAULT_GAP_PRONE = Object.freeze([
  // measured offenders
  'JPYX', 'GER40', 'US30',
  // index CFDs (same cash-market closure shape)
  'JPN225', 'NAS100', 'US2000', 'SPX500', 'UK100', 'FRA40', 'AUS200', 'HK50',
  // synthetic currency indices
  'EURX', 'USDX', 'GBPX',
])

/** Gap-prone list + window, from `weekend_bank_gap_json`. Corrupt → defaults. */
export function loadGapProneConfig(db) {
  const dflt = { on: true, symbols: [...DEFAULT_GAP_PRONE] }
  try {
    const p = JSON.parse(getState(db, 'weekend_bank_gap_json') || 'null')
    if (p && typeof p === 'object') {
      return {
        on: p.on !== false,
        symbols: Array.isArray(p.symbols) && p.symbols.length
          ? p.symbols.map(s => String(s).toUpperCase())
          : dflt.symbols,
      }
    }
  } catch { /* corrupt — defaults */ }
  return dflt
}

/** Is this symbol on the list? Exact, case-insensitive; no prefix matching. */
export function isGapProne(symbol, cfg) {
  if (!cfg?.on) return false
  return (cfg.symbols || []).includes(String(symbol || '').toUpperCase())
}

/**
 * Pure decision: bank this position now?
 *
 * `gapProne` drops the profit test and nothing else — the window and the
 * minimum-closure test still apply, so this never fires on an ordinary
 * overnight break or outside the pre-close window.
 */
export function shouldBank({ open, closesInSec, closureSec, side, entry, price, windowMin = 75, minClosureHrs = 12, minMovePct = 0, gapProne = false }) {
  if (open !== true) return false
  if (!Number.isFinite(closesInSec) || closesInSec > windowMin * 60) return false
  if (!Number.isFinite(closureSec) || closureSec < minClosureHrs * 3600) return false
  if (!(entry > 0) || !(price > 0)) return false
  // Gap-prone: flatten regardless of sign. The exposure being closed is the
  // gap itself, which does not care which way the position is currently.
  if (gapProne) return true
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
  const gapCfg = loadGapProneConfig(db)
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
      const gapProne = isGapProne(symbol, gapCfg)
      if (!shouldBank({ open: true, closesInSec: info.closes_in_sec, closureSec: info.closure_sec, side, entry: p.price, price, windowMin, minClosureHrs, gapProne })) continue

      await closePosition(creds, { positionId: parseInt(p.positionId), volume: td.volume })
      setState(db, key, JSON.stringify({ until: Date.now() + (info.closes_in_sec + info.closure_sec) * 1000 }))
      const movePct = Math.round(((price - p.price) * (side === 'SELL' ? -1 : 1) / p.price) * 10000) / 100
      banked.push({ symbol, positionId: p.positionId, side, movePct, gapProne })
      try {
        const { sendMessage } = await import('./telegram.js')
        const hrs = Math.round(info.closure_sec / 3600)
        // The gap-prone message says WHY a losing position was closed, because
        // "the bot closed my loser" with no reason is the report that gets
        // read as a malfunction.
        await sendMessage(gapProne
          ? `🚪 GAP GUARD: closed ${symbol} ${side} (position ${p.positionId}) at ${price} — ${movePct >= 0 ? '+' : ''}${movePct}% — before a ${hrs}h closure. ${symbol} is on the gap-prone list, so it is flattened either way: a reopen gap jumps OVER the stop, and measured gaps on these symbols have cost up to 7.9R against a 1R plan.`
          : `💰 WEEKEND BANK: closed ${symbol} ${side} (position ${p.positionId}) at ${price} — +${movePct}% move banked before the market closes for ${hrs}h. Holding profit through a long closure risks the reopen gap.`)
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
