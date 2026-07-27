// ---------------------------------------------------------------------------
// agent/services/retention.js — long-horizon retention sweep for the two
// tables the 8-hourly housekeeping block deliberately never touched: trades
// and trade_postmortems (hardening batch 6c). Everything else the loop
// prunes is diagnostic exhaust (scans, signals, risk_events, …); trades are
// the P&L LEDGER, so the default here is measured in years, the sweep only
// ever removes CLOSED trades, and the whole thing can be disabled by
// setting a horizon to null.
//
// Config lives in agent_state `retention_json`:
//   { tradesDays: 730, postmortemsDays: 730 }
// A null (or non-positive) horizon disables that table's sweep entirely.
// A pruned trade takes its postmortem with it in the same pass (FK-safe
// child-first delete; reported as orphanPostmortems).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DEFAULT_RETENTION = {
  tradesDays: 730,       // ~2 years of closed-trade ledger
  postmortemsDays: 730,  // keep the forensics as long as the trades
}

export function loadRetentionConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'retention_json') || 'null')
    return { ...DEFAULT_RETENTION, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_RETENTION }
  }
}

/**
 * One sweep. Returns { trades, postmortems, orphanPostmortems }.
 * - trades: only status='closed' rows whose closed_at is past the horizon —
 *   open/working/rejected rows are NEVER touched regardless of age (an old
 *   open row is a reconciliation problem, not garbage).
 * - postmortems: past their own horizon (orphanPostmortems counts the ones
 *   removed with their pruned parent trade — FK-safe, child before parent).
 * closed_at is REPLACE-normalized the same way as every other cross-format
 * timestamp comparison in this codebase (space- vs T-separated).
 */
export function pruneTradeHistory(db, cfg = null) {
  const c = cfg || loadRetentionConfig(db)
  const out = { trades: 0, postmortems: 0, orphanPostmortems: 0 }

  const horizon = (days) => {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) return null
    return new Date(Date.now() - d * 86_400_000).toISOString().replace('T', ' ')
  }

  const tCut = horizon(c.tradesDays)
  if (tCut) {
    // Children first — trade_postmortems.trade_id carries an FK to trades,
    // so a pruned trade's postmortem must go in the same pass (an orphaned
    // replay window would explain a trade that no longer exists anyway).
    const dueTrades = `SELECT id FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL
         AND REPLACE(closed_at, 'T', ' ') < ?`
    out.orphanPostmortems = db.prepare(
      `DELETE FROM trade_postmortems WHERE trade_id IN (${dueTrades})`
    ).run(tCut).changes
    out.trades = db.prepare(
      `DELETE FROM trades WHERE id IN (${dueTrades})`
    ).run(tCut).changes
  }

  const pCut = horizon(c.postmortemsDays)
  if (pCut) {
    out.postmortems = db.prepare(
      `DELETE FROM trade_postmortems WHERE REPLACE(created_at, 'T', ' ') < ?`
    ).run(pCut).changes
  }
  return out
}
