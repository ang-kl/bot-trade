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
 *
 * WHY NULL-ACCOUNT ROWS STILL COUNT AGAINST EVERY ACCOUNT, examined 2026-07-30
 * and DELIBERATELY LEFT ALONE. On this desk one unattributable closed trade
 * with no net_pnl blocks new entries on every account for the rest of the FX
 * day, which is a real operational cost and a strong candidate for the owner's
 * "I don't see any trades". The tempting fix is to scope this to
 * `account_id = ?` — and it is wrong. An unattributed unknown MIGHT belong to
 * the account being evaluated, so excluding it would let that account trade
 * against a daily-loss total known to be incomplete. That is precisely the
 * "unknown-and-blocking" rule this module exists to enforce, and the owner's
 * own investigation brief forbids it in as many words: "Do not bypass,
 * suppress, hard-code around, or weaken the PnL veto."
 *
 * So the veto keeps its reach and the OBSERVABILITY changes instead:
 * `unattributedCount` is reported separately, and the reason string names it.
 * A blocked desk should say "one closed trade with no account and no P&L is
 * holding every account" — an actionable sentence — rather than leaving the
 * owner to guess. Fixing the DATA (attributing or backfilling that row) is the
 * cure; loosening the guard is not.
 *
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
    SELECT COUNT(*) AS n,
           MIN(closed_at) AS oldest,
           SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS unattributed
      FROM trades
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
    return { count: -1, oldestClosedAt: null, unattributedCount: 0 }
  }
  return {
    count: row?.n || 0,
    oldestClosedAt: row?.oldest || null,
    // How many of those rows have no account_id at all. Reported so a blocked
    // desk can say WHICH data is holding it, rather than the owner discovering
    // "I don't see any trades" and having to guess.
    unattributedCount: Number(row?.unattributed) || 0,
  }
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
export function unknownPnlBlocks({ count, oldestClosedAt = null, unattributedCount = 0 }, { enabled = DEFAULT_UNKNOWN_PNL_BLOCK, graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN, scope = 'account' } = {}) {
  if (enabled === false) return { block: false }
  if (count === 0) return { block: false }
  if (count < 0) {
    return { block: true, reason: `unknown_daily_pnl (${scope}): the closed-trade P&L lookup failed — the day's loss total cannot be trusted, so no new entries` }
  }
  // Name the unattributed rows explicitly. They are the ones that block EVERY
  // account at once (see the note on unresolvedPnlSince), so if they are the
  // cause, the reason string has to say so — otherwise the owner sees seven
  // accounts stop and no way to tell that one orphan row did it.
  const orphanNote = unattributedCount > 0
    ? `; ${unattributedCount} of them have NO account_id, which is why every account is affected — attribute or backfill that row to clear it`
    : ''
  return {
    block: true,
    reason: `unknown_daily_pnl (${scope}): ${count} closed trade(s) today have no realised P&L after ${graceMin}m`
      + `${oldestClosedAt ? ` (oldest ${oldestClosedAt})` : ''}`
      + ` — the daily-loss total would under-count them as zero, so no new entries until the broker deal history fills them in`
      + orphanNote,
  }
}
