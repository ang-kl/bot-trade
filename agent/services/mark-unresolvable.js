// ---------------------------------------------------------------------------
// agent/services/mark-unresolvable.js — "the broker has no record of this close
// and never will", recorded as a finding with evidence.
//
// Owner's decision, 2026-07-30: "option 2" — distinguish UNKNOWN P&L (keep
// blocking; the backfill may still repair it) from UNKNOWABLE (stop blocking,
// loudly), rather than computing a net_pnl to get past the veto.
//
// WHY THIS EXISTS. services/unresolved-pnl.js blocks new entries while a closed
// trade has no realised P&L, because a daily-loss sum with a NULL in it is not
// trustworthy. That is correct and is not weakened here. What it lacked was an
// END: pnl-backfill can only repair a row while the close is still inside the
// broker's deal-history window, and once it falls out the row can never fill.
// The owner's production log showed the result — 77 stuck rows, the backfill
// parked on its 6-hour backoff rung attempting zero accounts, and a fail-closed
// veto with no path back. A brake with no release is not a brake, it is a stop.
//
// WHAT IS AND IS NOT INVENTED. net_pnl stays NULL. No P&L is computed, estimated
// or copied from anywhere, so every daily-loss total is still built only from
// figures the broker gave us. The single claim this module makes is a NEGATIVE
// one — "the deal history does not contain this close" — and it only makes that
// claim when both of the following hold:
//
//   1. AGE. The close is older than `horizonDays` (default 7). A recent close
//      that has not filled yet is UNKNOWN, not unknowable, and must keep
//      blocking — that is the whole point of the veto.
//   2. THE BACKFILL HAS ACTUALLY TRIED AND GIVEN UP. Caller passes
//      `exhaustedAccounts`: the accounts pnl-backfill has driven to its top
//      backoff rung. A row on an account the backfill has never attempted is
//      not evidence of anything.
//
// Both are required. Age alone would mark a row unresolvable during an outage
// that merely delayed the backfill; exhaustion alone would mark a fresh close
// unresolvable because an unrelated old row had pushed the account's ladder up.
//
// EVERY MARKING IS AUDITED, and the reason is stored on the row, because this is
// the one place where the system stops waiting for money data — that must never
// be something discovered later from a P&L that silently started adding up.
// ---------------------------------------------------------------------------

export const DEFAULT_UNRESOLVABLE_HORIZON_DAYS = 7

/**
 * Rows that QUALIFY as unknowable, with the evidence, without writing anything.
 *
 * Read-only on purpose: the owner should be able to see exactly which rows would
 * be marked, how old, on which account, before anything changes.
 */
export function findUnresolvableCandidates(db, {
  horizonDays = DEFAULT_UNRESOLVABLE_HORIZON_DAYS,
  exhaustedAccounts = [],
} = {}) {
  const days = Number.isFinite(Number(horizonDays)) && Number(horizonDays) > 0
    ? Number(horizonDays)
    : DEFAULT_UNRESOLVABLE_HORIZON_DAYS
  const accts = [...new Set((exhaustedAccounts || []).map(String).filter(Boolean))]
  if (accts.length === 0) return []
  const placeholders = accts.map(() => '?').join(',')
  return db.prepare(`
    SELECT id, symbol, side, account_id, closed_at, ctrader_position_id, exit_price
      FROM trades
     WHERE status = 'closed'
       AND net_pnl IS NULL
       AND COALESCE(pnl_unresolvable, 0) = 0
       AND closed_at IS NOT NULL
       AND REPLACE(closed_at, 'T', ' ') < datetime('now', ?)
       AND account_id IN (${placeholders})
     ORDER BY closed_at
  `).all(`-${days} days`, ...accts)
}

/**
 * Mark one row unknowable. Returns false if it no longer qualifies (already
 * marked, or the backfill filled it in the meantime — a race worth losing in
 * that direction).
 */
export function markUnresolvable(db, tradeId, reason) {
  const r = db.prepare(`
    UPDATE trades
       SET pnl_unresolvable = 1,
           pnl_unresolvable_reason = ?,
           pnl_unresolvable_at = datetime('now')
     WHERE id = ?
       AND status = 'closed'
       AND net_pnl IS NULL
       AND COALESCE(pnl_unresolvable, 0) = 0
  `).run(String(reason || 'no broker deal history for this close'), tradeId)
  return r.changes > 0
}

/**
 * One pass. `dryRun` (the default) reports the plan and writes nothing.
 *
 * @param {string[]} opts.exhaustedAccounts accounts pnl-backfill has driven to
 *   its top backoff rung — the "we tried and gave up" half of the evidence.
 */
export function sweepUnresolvable(db, {
  horizonDays = DEFAULT_UNRESOLVABLE_HORIZON_DAYS,
  exhaustedAccounts = [],
  dryRun = true,
} = {}) {
  const candidates = findUnresolvableCandidates(db, { horizonDays, exhaustedAccounts })
  if (dryRun) {
    return {
      dryRun: true,
      found: candidates.length,
      horizonDays,
      exhaustedAccounts: [...new Set((exhaustedAccounts || []).map(String))],
      plan: candidates.map(c => ({
        id: c.id, symbol: c.symbol, accountId: c.account_id, closedAt: c.closed_at,
        // Surfaced because it is the ONE field that would let a later pass
        // compute a real figure instead. Its absence is why this row is being
        // written off rather than repaired.
        hasExitPrice: c.exit_price != null,
      })),
    }
  }
  const marked = []
  for (const c of candidates) {
    const reason = `no broker deal history for this close: closed ${c.closed_at}, older than the ${horizonDays}-day deal-history horizon, and pnl-backfill has exhausted its retries on account ${c.account_id}`
    if (markUnresolvable(db, c.id, reason)) {
      marked.push({ id: c.id, symbol: c.symbol, accountId: c.account_id, closedAt: c.closed_at })
    }
  }
  if (marked.length > 0) {
    try {
      db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
        .run('PNL_UNRESOLVABLE', '/unresolvable', JSON.stringify({
          marked: marked.length,
          horizonDays,
          accounts: [...new Set(marked.map(m => m.accountId))],
          ids: marked.map(m => m.id).slice(0, 100),
          note: "owner 2026-07-30 'option 2' — these rows stop blocking new entries; net_pnl stays NULL, nothing was computed",
        }).slice(0, 2000))
    } catch { /* audit best-effort */ }
  }
  return { dryRun: false, found: candidates.length, marked: marked.length, rows: marked, horizonDays }
}
