// ---------------------------------------------------------------------------
// agent/services/weekend-loss-flag.js — flag losing positions before a long
// market closure. Sibling of weekend-bank.js (which banks PROFITABLE
// positions ahead of the same window) — this one deliberately does NOT
// close anything. weekend-bank.js's own header explains why losers are left
// alone: "selling a loser into a thin pre-close market locks the loss at the
// worst prices." That reasoning still holds here; the gap this file closes
// is visibility, not action — today a losing position rides through a
// weekend/holiday gap with no owner-facing signal at all unless
// weekend-watch.js's hourly LLM pass happens to flag a news-driven thesis
// break. This is a hard, mechanical, P&L-based flag that fires regardless of
// news: audit trail (action_log) + a Telegram alert, same channels
// weekend-bank.js already uses, so the owner can decide manually (hold,
// tighten, or close by hand) before the close.
//
// Toggle: agent_state `weekend_loss_flag` ('true' default; 'false'
// disables). One-shot per position per closure via a state marker, same
// self-clearing convention as weekend-bank.js's `wb_done_*`.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { nextCloseInfo } from './symbol-hours.js'

/**
 * Pure: turn raw `wl_flagged_*` agent_state rows ({key, value}) into the
 * UI's flag list. Keeps only unexpired markers that carry the display
 * fields (pre-enrichment markers stored `{until}` only — filtered out
 * harmlessly). Exported for the /state/weekend-loss-flags route and tests.
 */
export function parseWeekendFlags(rows, now = Date.now()) {
  const flags = []
  for (const r of rows || []) {
    try {
      const m = JSON.parse(r.value)
      if (!m || !(m.until > now) || !m.symbol) continue
      flags.push({
        positionId: String(r.key).replace('wl_flagged_', ''),
        symbol: m.symbol, side: m.side, entry: m.entry, price: m.price,
        movePct: m.movePct, closureHrs: m.closureHrs ?? null, flaggedAt: m.flaggedAt ?? null,
      })
    } catch { /* unreadable marker — skip */ }
  }
  return flags
}

/** Pure decision: flag this losing position now? */
export function shouldFlag({ open, closesInSec, closureSec, side, entry, price, windowMin = 75, minClosureHrs = 12, maxMovePct = 0 }) {
  if (open !== true) return false
  if (!Number.isFinite(closesInSec) || closesInSec > windowMin * 60) return false
  if (!Number.isFinite(closureSec) || closureSec < minClosureHrs * 3600) return false
  if (!(entry > 0) || !(price > 0)) return false
  const dir = String(side).toUpperCase() === 'SELL' ? -1 : 1
  const movePct = ((price - entry) * dir / entry) * 100
  return movePct < maxMovePct
}

/**
 * Sweep broker positions ahead of a long closure and flag (never close) any
 * position currently losing. `positions` are the raw reconcile rows (with
 * symbolName attached) — same array runWeekendBank consumes, reused here so
 * this doesn't cost an extra broker round-trip.
 */
export async function runWeekendLossFlag(db, creds, positions, { windowMin = 75, minClosureHrs = 12 } = {}) {
  if ((getState(db, 'weekend_loss_flag') || 'true') === 'false') return { skipped: 'off', flagged: [] }
  const flagged = []
  const { wsGetSpotOnce } = await import('../lib/ctrader-ws.js')

  for (const p of positions || []) {
    const td = p.tradeData || {}
    const symbol = String(p.symbolName || '').toUpperCase()
    if (!symbol || !td.symbolId || !p.positionId) continue

    const info = nextCloseInfo(db, symbol)
    if (info.open !== true || !Number.isFinite(info.closes_in_sec) || !Number.isFinite(info.closure_sec)) continue
    if (info.closes_in_sec > windowMin * 60 || info.closure_sec < minClosureHrs * 3600) continue

    // One-shot per position per closure — mirrors weekend-bank.js's marker
    // exactly: it self-clears once the closure has passed.
    const key = `wl_flagged_${p.positionId}`
    try {
      const prev = JSON.parse(getState(db, key) || 'null')
      if (prev && Date.now() < prev.until) continue
    } catch { /* fresh */ }

    let price = null
    try {
      const q = await wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      const side = td.tradeSide === 2 || td.tradeSide === 'SELL' ? 'SELL' : 'BUY'
      price = side === 'SELL' ? q?.ask : q?.bid
      if (!shouldFlag({ open: true, closesInSec: info.closes_in_sec, closureSec: info.closure_sec, side, entry: p.price, price, windowMin, minClosureHrs })) continue

      const movePct = Math.round(((price - p.price) * (side === 'SELL' ? -1 : 1) / p.price) * 10000) / 100
      // Marker doubles as the UI's data source (GET /state/weekend-loss-flags
      // reads these until they self-expire) — store the display fields, not
      // just the one-shot expiry.
      setState(db, key, JSON.stringify({
        until: Date.now() + (info.closes_in_sec + info.closure_sec) * 1000,
        symbol, side, entry: p.price, price, movePct,
        closureHrs: Math.round(info.closure_sec / 3600),
        flaggedAt: new Date().toISOString(),
      }))
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'WEEKEND_LOSS_FLAG', '/weekend-loss-flag',
          JSON.stringify({ symbol, positionId: p.positionId, side, entry: p.price, price, movePct, closesInSec: info.closes_in_sec, closureSec: info.closure_sec }).slice(0, 2000),
        )
      } catch { /* action_log appears after first boot */ }
      flagged.push({ symbol, positionId: p.positionId, side, movePct })
      try {
        const { sendMessage } = await import('./telegram.js')
        await sendMessage(`⚠️ WEEKEND LOSS: ${symbol} ${side} (position ${p.positionId}) is down ${movePct}% at ${price} ahead of a ${Math.round(info.closure_sec / 3600)}h closure — left open per policy (selling a loser into a thin pre-close market locks in the worst price). Review manually before the market shuts.`)
      } catch { /* non-fatal */ }
    } catch (err) {
      // A failed flag attempt must still be visible — same "loud on
      // failure" convention as weekend-bank.js.
      try {
        const { sendMessage } = await import('./telegram.js')
        await sendMessage(`⚠️ WEEKEND LOSS FLAG FAILED: could not evaluate ${symbol} position ${p.positionId} ahead of the long closure — ${err.message}.`)
      } catch { /* non-fatal */ }
    }
  }
  return { flagged }
}
