// ---------------------------------------------------------------------------
// agent/services/pnl-watch.js — Telegram warnings when an open trade drifts.
//
// Owner audit (2026-07-20): every existing alert fires when the bot ACTS
// (SL moved, partial taken, position closed). Nothing warned when a trade
// merely drifted into meaningful profit or loss. This watch fills that gap:
//
// - Uses BROKER-truth net unrealized P&L (wsGetUnrealizedPnl) measured as a
//   % of the account balance — the risk-relevant read.
// - Alerts when a position crosses ±step% (default 1% of balance), then
//   stays quiet until the NEXT full step in the same direction (2%, 3%, …).
//   Crossing back through zero re-arms the first step. No 5-minute spam.
// - Toggle: `pnl_alert_pct` state (0 disables; default 1).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { getAccountBalance } from './risk.js'

/** Pure: which alert step (signed int) does this P&L sit at? 0 = inside ±1 step. */
export function stepOf(pnl, balance, stepPct) {
  if (!(balance > 0) || !(stepPct > 0) || !Number.isFinite(pnl)) return 0
  const pct = (pnl / balance) * 100
  return Math.trunc(pct / stepPct)
}

/** Pure: alert now? Only when moving to a step FURTHER from zero than last alerted. */
export function shouldAlertStep(step, lastStep) {
  if (step === 0) return false
  const prev = Number.isFinite(lastStep) ? lastStep : 0
  if (Math.sign(step) !== Math.sign(prev)) return true    // flipped side of zero
  return Math.abs(step) > Math.abs(prev)                  // deeper in the same direction
}

/** Sweep open positions; alert on new threshold crossings. */
export async function runPnlWatch(db, creds, deps = {}) {
  const stepPct = getState(db, 'pnl_alert_pct') == null ? 1 : Number(getState(db, 'pnl_alert_pct'))
  if (!(stepPct > 0) || !creds?.ready) return { checked: 0, alerts: 0 }
  const accountId = creds?.accountId == null ? null : String(creds.accountId)
  if (!accountId) return { checked: 0, alerts: 0, reason: 'account_required' }
  const balance = getAccountBalance(db, accountId)
  if (!(balance > 0)) return { checked: 0, alerts: 0 }

  const wsGetUnrealizedPnl = deps.wsGetUnrealizedPnl ?? (await import('../lib/ctrader-ws.js')).wsGetUnrealizedPnl
  const pnlMap = await wsGetUnrealizedPnl(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)

  // positionId → symbol/side from the bot's ledger (bot + adopted positions).
  // ctrader_position_id lives on `trades`, NOT monitored_positions — join
  // through trade_id. (Querying it off monitored_positions raised
  // "no such column: ctrader_position_id" and silently killed the watch.)
  const rows = db.prepare(
    `SELECT t.ctrader_position_id AS pid, m.symbol AS symbol, m.side AS side
       FROM monitored_positions m
       JOIN trades t ON t.id = m.trade_id
      WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL
        AND (t.account_id = ? OR m.account_id = ?)
        AND (t.account_id IS NULL OR t.account_id = ?)
        AND (m.account_id IS NULL OR m.account_id = ?)`
  ).all(accountId, accountId, accountId, accountId)
  // An ambiguous duplicate is not a second position or permission to guess
  // which symbol/side belongs to the broker's result.
  const multiplicity = new Map()
  for (const r of rows) multiplicity.set(String(r.pid), (multiplicity.get(String(r.pid)) ?? 0) + 1)
  const positions = rows.filter(r => multiplicity.get(String(r.pid)) === 1)

  let alerts = 0
  for (const r of positions) {
    const net = pnlMap[String(r.pid)]?.net
    if (net == null) continue
    const step = stepOf(net, balance, stepPct)
    const key = `acct:${accountId}:pnl_step_${r.pid}`
    const lastStep = Number(getState(db, key))
    // Track direction changes even below threshold so a round trip
    // +2% → −2% alerts on both sides.
    if (step === 0 && lastStep !== 0) setState(db, key, '0')
    if (!shouldAlertStep(step, lastStep)) continue
    setState(db, key, String(step))
    alerts++
    try {
      const sendMessage = deps.sendMessage ?? (await import('./telegram.js')).sendMessage
      const pct = ((net / balance) * 100).toFixed(2)
      await sendMessage(
        net >= 0
          ? `📈 Account …${accountId.slice(-4)}: ${r.symbol} ${String(r.side || '').toUpperCase()} is +$${Math.abs(net).toFixed(2)} (+${pct}% of balance). Next update at ${(Math.abs(step) + 1) * stepPct}%.`
          : `📉 Account …${accountId.slice(-4)}: ${r.symbol} ${String(r.side || '').toUpperCase()} is −$${Math.abs(net).toFixed(2)} (${pct}% of balance). Next update at −${(Math.abs(step) + 1) * stepPct}%.`
      )
    } catch { /* non-fatal */ }
  }
  return { checked: positions.length, alerts }
}
