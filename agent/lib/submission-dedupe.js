// ---------------------------------------------------------------------------
// agent/lib/submission-dedupe.js — the "did we already send this?" reads that
// autoTrade runs before every market order.
//
// WHY A MODULE (03-09-2026). The ambiguous-submission read compared
// risk_events.created_at — an ISO string with a 'T' ("2026-09-03T08:54:36.700Z")
// — against SQLite's datetime('now', '-20 minutes') — "2026-09-03 09:35:00",
// a SPACE where the 'T' is. As strings, 'T' (0x54) sorts after ' ' (0x20), so
// every same-day ISO row compared GREATER than the bound and the "20-minute"
// window ran until midnight UTC. Measured: BTCUSD on two demo accounts was
// refused as duplicate_submission_ambiguous at 09:55Z against an ambiguous
// row from 08:54Z, 61 minutes earlier. A window that says 20 minutes and
// holds for 15 hours is failure mode #3 with the sign flipped: the guard
// fires when it should not, and nothing in its text says so.
//
// The bound is now built in the SAME format as the column (ISO, 'T', 'Z').
// ---------------------------------------------------------------------------

/** ISO-8601 'YYYY-MM-DDTHH:MM:SSZ' for `minutesAgo` before now — the same shape risk_events.created_at is written in. */
export function isoBoundMinutesAgo(minutesAgo, nowMs = Date.now()) {
  return new Date(nowMs - Number(minutesAgo) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The most recent AMBIGUOUS submission (order_ambiguous:… risk event) for
 * this symbol/side on this account inside the window, or null. Rows whose
 * created_at carries a space instead of the 'T' (a hand-written fixture or a
 * legacy writer) are compared the same way by normalising the column.
 */
export function recentAmbiguousSubmission(db, { symbol, side, accountId, windowMin, nowMs = Date.now() }) {
  const bound = isoBoundMinutesAgo(windowMin, nowMs)
  return db.prepare(`
    SELECT id, created_at FROM risk_events
    WHERE symbol = ? AND side = ? AND approved = 0
      AND veto_reason LIKE 'order_ambiguous:%'
      AND replace(created_at, ' ', 'T') >= ?
      AND (account_id = ? OR account_id IS NULL)
    ORDER BY id DESC LIMIT 1
  `).get(symbol, side, bound, accountId == null ? null : String(accountId)) || null
}
