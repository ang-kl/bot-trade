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
 * One sweep. Returns { trades, postmortems, orphanPostmortems, keptReferenced }.
 * - trades: only status='closed' rows whose closed_at is past the horizon —
 *   open/working/rejected rows are NEVER touched regardless of age (an old
 *   open row is a reconciliation problem, not garbage).
 * - postmortems: past their own horizon (orphanPostmortems counts the ones
 *   removed with their pruned parent trade — FK-safe, child before parent).
 * - keptReferenced: due trades spared because a monitored_positions row still
 *   references them. See the long note at the exclusion — without it, ONE such
 *   trade made the bulk DELETE raise a foreign-key error and prune nothing.
 * closed_at is REPLACE-normalized the same way as every other cross-format
 * timestamp comparison in this codebase (space- vs T-separated).
 */
export function pruneTradeHistory(db, cfg = null) {
  const c = cfg || loadRetentionConfig(db)
  const out = { trades: 0, postmortems: 0, orphanPostmortems: 0, keptReferenced: 0 }

  const horizon = (days) => {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) return null
    return new Date(Date.now() - d * 86_400_000).toISOString().replace('T', ' ')
  }

  const tCut = horizon(c.tradesDays)
  if (tCut) {
    // A TRADE STILL REFERENCED BY monitored_positions CANNOT BE DELETED, AND
    // TRYING TAKES THE WHOLE SWEEP DOWN WITH IT.
    //
    // db.js:556 sets `PRAGMA foreign_keys = ON`, and
    // monitored_positions.trade_id is `REFERENCES trades(id)` with no ON DELETE
    // clause — so the default NO ACTION applies. This sweep deleted in ONE bulk
    // statement, so a single referenced row made that statement raise
    // "FOREIGN KEY constraint failed" and roll back, taking every
    // unreferenced due trade with it. Measured, not inferred: two due trades,
    // one referenced, and the DELETE removes NEITHER.
    //
    // So the failure mode is not an orphaned row — the FK prevents that. It is
    // that retention silently stops working. monitored_positions rows are kept
    // after they close, so any closed trade that ever had one is a permanent
    // blocker, and on a real database that is most of them. The sweep would
    // throw on every run, for ever, pruning nothing.
    //
    // Excluding referenced trades is the conservative fix: the ledger row is
    // kept for anything the system still holds a position record for, and every
    // other due trade is actually pruned. Deleting or re-pointing the
    // monitored_positions rows instead would be a policy decision about the
    // owner's history, which is not retention's call to make.
    //
    // Status is deliberately NOT part of the exclusion — the FK does not care
    // whether the monitored row is 'active' or 'closed', so neither can this.
    const dueTrades = `SELECT id FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL
         AND REPLACE(closed_at, 'T', ' ') < ?
         AND id NOT IN (
           SELECT trade_id FROM monitored_positions WHERE trade_id IS NOT NULL
         )`
    // Reported so a sweep that prunes less than expected explains itself,
    // instead of looking like a horizon that is set wrong.
    out.keptReferenced = db.prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE status = 'closed' AND closed_at IS NOT NULL
          AND REPLACE(closed_at, 'T', ' ') < ?
          AND id IN (
            SELECT trade_id FROM monitored_positions WHERE trade_id IS NOT NULL
          )`
    ).get(tCut).n
    // Children first — trade_postmortems.trade_id carries an FK to trades,
    // so a pruned trade's postmortem must go in the same pass (an orphaned
    // replay window would explain a trade that no longer exists anyway). Same
    // predicate as the parent delete, so the two cannot diverge and a kept
    // parent never loses its forensics.
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
