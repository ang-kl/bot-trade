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
//
// V3 WEB-1 (8,989-A row 2): THE SECOND RULE WAS NOT WHAT THE CODE DID. A
// caller that named no account was stamped with the SELECTED account
// (getState 'ctrader_account_id'), so every roster-level gate — the armed
// scope pre-filter, the stage-matrix union, the horizon, style, watchlist,
// regime and weekend gates — charged its stops to whichever account the
// dashboard had selected. Measured 25-09 over 24 h: all 9,970 upstream stops
// on 46130058, 0 on every other account, and "Unassigned records stay
// explicitly unattributed" true of nothing. A decision with no named account
// is now stored with NULL, which is what the rule above always said.
// ---------------------------------------------------------------------------

import { accountWhere } from '../lib/account-scope.js'

export const DECISION_RETENTION_DAYS = 90

// WHO A ROW BELONGS TO, for the readers that must not charge one account
// with another's (or everyone's) stop — blocker-report.js.
//
// Written ONLY by account-independent gates (loop.js's signal-level path
// and the pre-analysis filters): every row of these stages is roster-wide,
// including the older rows the fallback stamped with the then-selected
// account. 'regime_block' is gate-skips.js's REGIME_BLOCK_STAGE (a literal
// here: gate-skips imports this module).
export const ROSTER_ONLY_STAGES = Object.freeze(['armed_scope_prefilter', 'cluster_conviction', 'horizon',
  'regime_block', 'style_filter', 'watchlist_override', 'weekend_quiet'])
// stage_matrix has TWO writers: the roster union (no account; NULL now) and
// the per-account gate in the dispatch fan-out. A NULL row is the roster's.
export const ROSTER_STAGES = Object.freeze([...ROSTER_ONLY_STAGES, 'stage_matrix'])
// Stages whose older rows cannot be split: stage_matrix (the roster union's
// fallback row and the account's own gate row are identical) and
// lesson_decay (written from autoTrade with the order's account in scope but
// not passed, so the fallback named the selected account instead). A row of
// these stages written WITH an account now carries detail.attribution =
// 'account'; an unmarked row with an account predates this fix.
export const ATTRIBUTION_MARKED_STAGES = Object.freeze(['lesson_decay', 'stage_matrix'])
export const ACCOUNT_ATTRIBUTION_MARK = 'account'

function markedDetail(stage, accountId, detail) {
  if (accountId == null || !ATTRIBUTION_MARKED_STAGES.includes(String(stage))) return detail
  if (detail == null) return { attribution: ACCOUNT_ATTRIBUTION_MARK }
  if (typeof detail === 'object' && !Array.isArray(detail)) return { ...detail, attribution: ACCOUNT_ATTRIBUTION_MARK }
  return detail
}

/**
 * Record one controller decision. `decision` is 'skip' | 'veto' | 'proceed'
 * ('proceed' rows are for stages whose POSITIVE outcome is worth an audit
 * trail — most callers only record the negative).
 */
export function recordDecision(db, { accountId = null, symbol = null, timeframe = null, strategy = null, stage, decision, reason = null, detail = null, loopId = null }) {
  try {
    // No fallback to the selected account: an unnamed account is NULL.
    const acct = accountId != null ? String(accountId) : null
    const stored = markedDetail(stage, acct, detail)
    db.prepare(`
      INSERT INTO decision_log (account_id, symbol, timeframe, strategy, stage, decision, reason, detail_json, loop_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      acct, symbol, timeframe, strategy, String(stage), String(decision),
      reason != null ? String(reason).slice(0, 500) : null,
      stored != null ? JSON.stringify(stored).slice(0, 4000) : null,
      loopId,
    )
  } catch { /* provenance must never block trading */ }
}

/** Recent decisions, newest first, optional filters. */
export function recentDecisions(db, { symbol = null, stage = null, limit = 100, scope = null } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 100), 1000)
  const acct = accountWhere(scope, 'account_id')
  return db.prepare(`
    SELECT * FROM decision_log
    WHERE (? IS NULL OR symbol = ?) AND (? IS NULL OR stage = ?)${acct.active ? ` AND ${acct.where}` : ''}
    ORDER BY id DESC LIMIT ?
  `).all(symbol, symbol, stage, stage, ...acct.params, n)
}

/** Retention sweep — call from the loop's housekeeping, never fatal. */
export function pruneDecisionLog(db, retentionDays = DECISION_RETENTION_DAYS) {
  try {
    return db.prepare(
      `DELETE FROM decision_log WHERE created_at < datetime('now', ?)`
    ).run(`-${Math.max(1, Math.round(retentionDays))} days`).changes
  } catch { return 0 }
}
