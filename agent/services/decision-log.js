// ---------------------------------------------------------------------------
// agent/services/decision-log.js — 3A decision provenance (multi-account
// plan, non-negotiable requirement).
//
// "Why didn't it trade?" must be answerable from the DB, not from grepping
// stdout. risk_events already records risk-gate vetoes with full checks;
// this module records everything UPSTREAM of the gate — the skips: style
// filters, lesson-decay cool-offs, watchlist overrides, dispatch gates.
//
// Rules:
//   - recording NEVER throws (a logging failure must not touch trading)
//   - rows carry the account when the caller knows it, NULL when the
//     decision is account-independent (market observations)
//   - a retention sweep keeps the table bounded — decisions are diagnostic,
//     not bookkeeping (trades/risk_events remain the durable records)
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DECISION_RETENTION_DAYS = 90

/**
 * Record one controller decision. `decision` is 'skip' | 'veto' | 'proceed'
 * ('proceed' rows are for stages whose POSITIVE outcome is worth an audit
 * trail — most callers only record the negative).
 */
export function recordDecision(db, { accountId = null, symbol = null, timeframe = null, strategy = null, stage, decision, reason = null, detail = null, loopId = null }) {
  try {
    const acct = accountId != null
      ? String(accountId)
      : (getState(db, 'ctrader_account_id') || null)
    db.prepare(`
      INSERT INTO decision_log (account_id, symbol, timeframe, strategy, stage, decision, reason, detail_json, loop_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      acct, symbol, timeframe, strategy, String(stage), String(decision),
      reason != null ? String(reason).slice(0, 500) : null,
      detail != null ? JSON.stringify(detail).slice(0, 4000) : null,
      loopId,
    )
  } catch { /* provenance must never block trading */ }
}

/** Recent decisions, newest first, optional filters. */
export function recentDecisions(db, { symbol = null, stage = null, limit = 100 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 100), 1000)
  return db.prepare(`
    SELECT * FROM decision_log
    WHERE (? IS NULL OR symbol = ?) AND (? IS NULL OR stage = ?)
    ORDER BY id DESC LIMIT ?
  `).all(symbol, symbol, stage, stage, n)
}

/** Retention sweep — call from the loop's housekeeping, never fatal. */
export function pruneDecisionLog(db, retentionDays = DECISION_RETENTION_DAYS) {
  try {
    return db.prepare(
      `DELETE FROM decision_log WHERE created_at < datetime('now', ?)`
    ).run(`-${Math.max(1, Math.round(retentionDays))} days`).changes
  } catch { return 0 }
}
