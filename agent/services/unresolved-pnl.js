// ---------------------------------------------------------------------------
// agent/services/unresolved-pnl.js — P1 / AUDIT F-L6-06.
//
// THE DEFECT. Both daily-loss caps sum `net_pnl` over today's closed trades:
//
//     SELECT COALESCE(SUM(net_pnl), 0) …            risk.js:538
//     SELECT COALESCE(SUM(net_pnl), 0) …            global-guards.js:73
//
// SQLite's SUM SKIPS NULLs, and COALESCE turns an all-NULL sum into 0. Three of
// the seven closure paths leave `net_pnl` NULL — including the reconciler's
// broker-side close (reconciler.js:285), which is the NORMAL exit for a
// stop-out. So a day made of stop-outs sums to zero, presents as flat, and
// neither the portfolio cap nor the per-account cap ever trips. The brake was
// not merely inaccurate; for the losses most likely to occur it was OFF.
//
// `pnl-backfill.js` repairs those rows from broker deal history, but it is
// gated on three conditions (its own :44-48, :66, :119) and any of them
// failing leaves the row NULL indefinitely.
//
// THE RULE (owner-approved as P1, gate D10: "unknown-and-blocking"). A closed
// trade with no realised P&L is not worth zero — it is UNKNOWN, and the sum it
// belongs to cannot be trusted. A money ceiling must fail towards stopping,
// the same convention loadGlobalGuards already uses for an unreadable config
// (global-guards.js:44).
//
// THE GRACE WINDOW, and why it is not optional. The backfill runs after a
// reconcile that closed something, so a freshly-closed trade is EXPECTED to sit
// with a NULL net_pnl for a cycle or two. Blocking on those would halt trading
// permanently on a normal day. Only rows OLDER than the grace count — long
// enough that the backfill should have resolved them, short enough that a real
// blind spot stops the account within one loop or two.
//
// Both knobs are configurable and both fail towards blocking:
//   risk_config_json.blockOnUnknownPnl    (default true)
//   risk_config_json.unknownPnlGraceMin   (default 15)
// and the same two names under global_guards_json for the portfolio layer.
// ---------------------------------------------------------------------------

export const DEFAULT_UNKNOWN_PNL_BLOCK = true
export const DEFAULT_UNKNOWN_PNL_GRACE_MIN = 15

/**
 * Closed trades in the window whose realised P&L is still unknown, older than
 * the grace period — i.e. the rows that make a daily-loss sum untrustworthy.
 *
 * Scoped exactly like the caller's own sum: `accountId` null means portfolio
 * (every account), a value means that account plus legacy NULL-account rows.
 * The same REPLACE(closed_at,'T',' ') normalisation the caps use is applied
 * here, for the reason documented at risk.js:525-534 — mixing the two
 * timestamp formats silently excluded every production-closed trade once
 * before.
 *
 * @returns {{count:number, oldestClosedAt:string|null}}
 */
export function unresolvedPnlSince(db, dayStartSql, { accountId = null, graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN } = {}) {
  const acct = accountId != null ? String(accountId) : null
  const grace = Number.isFinite(Number(graceMin)) && Number(graceMin) >= 0
    ? Number(graceMin)
    : DEFAULT_UNKNOWN_PNL_GRACE_MIN
  const sql = `
    SELECT COUNT(*) AS n, MIN(closed_at) AS oldest FROM trades
    WHERE status = 'closed'
      AND net_pnl IS NULL
      AND REPLACE(closed_at, 'T', ' ') >= ?
      AND REPLACE(closed_at, 'T', ' ') <= datetime('now', ?)
      ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
  `
  const params = acct == null
    ? [dayStartSql, `-${grace} minutes`]
    : [dayStartSql, `-${grace} minutes`, acct]
  let row = null
  try {
    row = db.prepare(sql).get(...params)
  } catch {
    // A query that cannot run tells us nothing about the day's losses, which
    // is exactly the state this module refuses to read as "zero".
    return { count: -1, oldestClosedAt: null }
  }
  return { count: row?.n || 0, oldestClosedAt: row?.oldest || null }
}

/**
 * Should new entries be blocked because the day's realised P&L cannot be
 * trusted? Pure decision — hand it the count from unresolvedPnlSince.
 *
 * A negative count means the lookup itself failed; that is treated as
 * blocking too, for the same fail-safe reason.
 *
 * @returns {{block:boolean, reason?:string}}
 */
export function unknownPnlBlocks({ count, oldestClosedAt = null }, { enabled = DEFAULT_UNKNOWN_PNL_BLOCK, graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN, scope = 'account' } = {}) {
  if (enabled === false) return { block: false }
  if (count === 0) return { block: false }
  if (count < 0) {
    return { block: true, reason: `unknown_daily_pnl (${scope}): the closed-trade P&L lookup failed — the day's loss total cannot be trusted, so no new entries` }
  }
  return {
    block: true,
    reason: `unknown_daily_pnl (${scope}): ${count} closed trade(s) today have no realised P&L after ${graceMin}m`
      + `${oldestClosedAt ? ` (oldest ${oldestClosedAt})` : ''}`
      + ` — the daily-loss total would under-count them as zero, so no new entries until the broker deal history fills them in`,
  }
}
