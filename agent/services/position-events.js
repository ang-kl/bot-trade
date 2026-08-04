// ---------------------------------------------------------------------------
// agent/services/position-events.js — P10 tweak-journal timeline
// (docs/cockpit-data-endpoint-spec.md §4).
//
// monitored_positions keeps current flags (be_moved, scaled_out) and the
// LATEST review, not a timeline; action_log is a generic HTTP log;
// decision_log covers decisions upstream of the risk gate. Nothing records
// the sequence of amendments made to a live position after entry — this
// module is that record.
//
// Rules (same discipline as decision-log.js):
//   - recording NEVER throws (a logging failure must not touch trading)
//   - rows carry the account when the caller knows it, NULL otherwise
//   - a retention sweep keeps the table bounded — these are diagnostic,
//     not bookkeeping (trades/monitored_positions remain the durable record)
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const POSITION_EVENTS_RETENTION_DAYS = 90

/**
 * Record one position amendment/lifecycle event.
 * `kind` is one of: sl_moved | tp_moved | scale_out | close | trail_armed
 * | trail_tightened | lot_trimmed | paused | resumed | authority_override
 *
 * `authority_override` is the odd one out: it records an OBSERVATION rather
 * than an amendment. minute-review.js writes it when a lower-authority writer
 * moved a stop the owner placed by hand (§41), and the row's presence is also
 * what stops the same override being reported twice.
 */
export function recordPositionEvent(db, {
  accountId = null,
  positionId = null,
  tradeId = null,
  symbol,
  kind,
  fromValue = null,
  toValue = null,
  rAt = null,
  priceAt = null,
  reason = null,
  source = null,
  detail = null,
}) {
  try {
    const acct = accountId != null
      ? String(accountId)
      : (getState(db, 'ctrader_account_id') || null)
    db.prepare(`
      INSERT INTO position_events (account_id, position_id, trade_id, symbol, kind, from_value, to_value, r_at, price_at, reason, source, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      acct,
      positionId != null ? String(positionId) : null,
      tradeId != null ? Number(tradeId) : null,
      String(symbol),
      String(kind),
      fromValue != null ? Number(fromValue) : null,
      toValue != null ? Number(toValue) : null,
      rAt != null ? Number(rAt) : null,
      priceAt != null ? Number(priceAt) : null,
      reason != null ? String(reason).slice(0, 500) : null,
      source != null ? String(source) : null,
      detail != null ? JSON.stringify(detail).slice(0, 4000) : null,
    )
  } catch { /* the journal must never block trading */ }
}

/** Recent position events, newest first, optional filters. */
export function recentPositionEvents(db, { positionId = null, symbol = null, limit = 100 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 100), 1000)
  return db.prepare(`
    SELECT * FROM position_events
    WHERE (? IS NULL OR position_id = ?) AND (? IS NULL OR symbol = ?)
    ORDER BY id DESC LIMIT ?
  `).all(positionId, positionId, symbol, symbol, n)
}

/** Retention sweep — call from the loop's housekeeping, never fatal. */
export function prunePositionEvents(db, retentionDays = POSITION_EVENTS_RETENTION_DAYS) {
  try {
    return db.prepare(
      `DELETE FROM position_events WHERE at < datetime('now', ?)`
    ).run(`-${Math.max(1, Math.round(retentionDays))} days`).changes
  } catch { return 0 }
}
