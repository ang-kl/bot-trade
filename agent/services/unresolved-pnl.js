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
// AGE-OUT (owner, 03-08-2026: "make unresolvable rows age out instead of
// blocking forever").
//
// The grace window says "wait, the backfill may still fix this". It has no
// upper bound, so a row the backfill never fixes blocks entries for the whole
// FX day, every day, with no path back. Production: `unknown_daily_pnl` was
// 32,115 of 46,380 vetoes in seven days — 69% of everything — off ONE closed
// trade whose broker deal history never filled.
//
// mark-unresolvable.js already writes rows off, but only on positive evidence
// that the broker has no deal history. A row nobody looked at, or that the
// sweep never reached, is left blocking indefinitely. This is the time-based
// backstop for exactly that case: past `unknownPnlMaxAgeMin` the backfill has
// had hours, not minutes, and waiting longer is not caution — it is a halt
// with no release.
//
// 6 hours is deliberately INSIDE the FX day, not a day or more. A threshold of
// 24h would never fire, because the window this query runs over starts at the
// FX day open and is under 24h wide by construction.
//
// What is NOT done: net_pnl stays NULL. Nothing is estimated or invented, so
// the daily-loss sum is still built only from figures the broker gave us. The
// row stops being waited on; it is never counted as zero. Set the knob to 0 or
// null to restore the old block-forever behaviour.
export const DEFAULT_UNKNOWN_PNL_MAX_AGE_MIN = 360

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
export function unresolvedPnlSince(db, dayStartSql, {
  accountId = null,
  graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN,
  maxAgeMin = DEFAULT_UNKNOWN_PNL_MAX_AGE_MIN,
} = {}) {
  const acct = accountId != null ? String(accountId) : null
  const grace = Number.isFinite(Number(graceMin)) && Number(graceMin) >= 0
    ? Number(graceMin)
    : DEFAULT_UNKNOWN_PNL_GRACE_MIN
  // 0, null or junk = no age-out, i.e. the old block-until-resolved behaviour.
  // Anything at or below the grace window is nonsense (it would age a row out
  // before it had even started blocking) and is treated as "off" rather than
  // silently reordering the two windows.
  const maxAge = Number.isFinite(Number(maxAgeMin)) && Number(maxAgeMin) > grace
    ? Number(maxAgeMin)
    : null
  // UNKNOWN vs UNKNOWABLE (owner's decision 2026-07-30, "option 2").
  //
  // `pnl_unresolvable = 1` marks a row the broker has no deal history for and
  // never will — see db.js's column comment and mark-unresolvable.js for the
  // evidence rule. Those rows are EXCLUDED from `n`, the blocking count, and
  // counted separately in `unresolvable` so the reason string can still name
  // them.
  //
  // THIS IS NOT A WEAKENING OF THE VETO, and the distinction matters because the
  // owner's brief forbids weakening it in as many words. The veto exists because
  // a NULL net_pnl makes the daily-loss sum untrustworthy while the backfill
  // might still repair it. Once the close has fallen out of the broker's
  // deal-history window the row can never be repaired, so blocking on it is not
  // caution — it is a permanent halt with no path back. The owner's log showed 77
  // such rows with the backfill parked on its 6-hour rung attempting zero
  // accounts. What is removed here is a stop with no release, not a stop.
  //
  // net_pnl stays NULL on those rows. Nothing is computed, estimated or invented,
  // so the daily-loss sum is still built only from figures the broker gave us —
  // it just no longer waits for figures that are never coming.
  // IS THE COLUMN THERE? A fail-closed veto must never start blocking because of
  // a SCHEMA gap. Referencing pnl_unresolvable unconditionally made every query
  // throw on a database that predates it, and the catch below reads a failed
  // query as "the day's losses are unknown" — so a missing column would have
  // halted trading everywhere. Found by risk.test.js, which builds its own
  // trades table: 53 approvals turned into vetoes. Absent column simply means no
  // row has been written off yet, which is the pre-migration truth.
  let hasUnresolvable = false
  try {
    hasUnresolvable = db.prepare('PRAGMA table_info(trades)').all()
      .some(c => c.name === 'pnl_unresolvable')
  } catch { hasUnresolvable = false }
  const notWrittenOff = hasUnresolvable ? 'AND COALESCE(pnl_unresolvable, 0) = 0' : ''

  // The blocking set is now BOUNDED AT BOTH ENDS: newer than the age-out line
  // (still worth waiting for) and older than the grace line (has had its
  // chance). Without the age-out clause this window has no floor, which is
  // what made the veto permanent.
  const notAgedOut = maxAge == null ? '' : "AND REPLACE(closed_at, 'T', ' ') >= datetime('now', ?)"
  const sql = `
    SELECT COUNT(*) AS n,
           MIN(closed_at) AS oldest,
           SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS unattributed
      FROM trades
    WHERE status = 'closed'
      AND net_pnl IS NULL
      ${notWrittenOff}
      AND REPLACE(closed_at, 'T', ' ') >= ?
      AND REPLACE(closed_at, 'T', ' ') <= datetime('now', ?)
      ${notAgedOut}
      ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
  `
  // Rows we have STOPPED blocking on purely because of age. Counted and named
  // separately from the evidence-based write-offs: "the broker says there is
  // no deal history" and "we waited six hours and gave up" are different
  // statements, and an operator reading a resumed desk should be able to tell
  // which one happened.
  const agedOutSql = `
    SELECT COUNT(*) AS n, MIN(closed_at) AS oldest
      FROM trades
    WHERE status = 'closed'
      AND net_pnl IS NULL
      ${notWrittenOff}
      AND REPLACE(closed_at, 'T', ' ') >= ?
      AND REPLACE(closed_at, 'T', ' ') < datetime('now', ?)
      ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
  `
  // Same window and scope, but the rows we have STOPPED blocking on — reported
  // so "trading resumed" is never silent about what it stopped waiting for.
  const unresolvableSql = `
    SELECT COUNT(*) AS n
      FROM trades
    WHERE status = 'closed'
      AND net_pnl IS NULL
      AND COALESCE(pnl_unresolvable, 0) = 1
      AND REPLACE(closed_at, 'T', ' ') >= ?
      AND REPLACE(closed_at, 'T', ' ') <= datetime('now', ?)
      ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
  `
  // POSITIONAL PARAMS, IN SOURCE ORDER. The age-out clause sits BETWEEN the
  // grace clause and the account clause, so its parameter has to go in the
  // same place — appending it would bind the account id to the date and the
  // date to the account, and the query would silently return nothing (which
  // this module reads as "nothing is blocking"). Same class of bug as the
  // scoped-read miscounts earlier in this workstream.
  const params = [
    dayStartSql,
    `-${grace} minutes`,
    ...(maxAge == null ? [] : [`-${maxAge} minutes`]),
    ...(acct == null ? [] : [acct]),
  ]
  const agedParams = acct == null
    ? [dayStartSql, `-${maxAge} minutes`]
    : [dayStartSql, `-${maxAge} minutes`, acct]
  let row = null
  let unres = null
  let aged = { n: 0, oldest: null }
  try {
    row = db.prepare(sql).get(...params)
    // Only when the column exists — see the note above.
    unres = hasUnresolvable ? db.prepare(unresolvableSql).get(
      ...(acct == null ? [dayStartSql, `-${grace} minutes`] : [dayStartSql, `-${grace} minutes`, acct]),
    ) : { n: 0 }
    if (maxAge != null) aged = db.prepare(agedOutSql).get(...agedParams) || aged
  } catch {
    // A query that cannot run tells us nothing about the day's losses, which
    // is exactly the state this module refuses to read as "zero".
    return { count: -1, oldestClosedAt: null, unattributedCount: 0, unresolvableCount: 0, agedOutCount: 0, agedOutOldest: null }
  }
  return {
    count: row?.n || 0,
    oldestClosedAt: row?.oldest || null,
    // How many of those rows have no account_id at all. Reported so a blocked
    // desk can say WHICH data is holding it, rather than the owner discovering
    // "I don't see any trades" and having to guess.
    unattributedCount: Number(row?.unattributed) || 0,
    // Rows in the same window we have STOPPED blocking on because the broker has
    // no deal history for them and never will. Not part of `count`; surfaced so
    // the decision is visible rather than implied by trading simply resuming.
    unresolvableCount: Number(unres?.n) || 0,
    // Rows that stopped blocking because they got OLD, not because the broker
    // told us anything. Kept distinct from unresolvableCount so a resumed desk
    // can say which of the two happened.
    agedOutCount: Number(aged?.n) || 0,
    agedOutOldest: aged?.oldest || null,
    agedOutAfterMin: maxAge,
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
export function unknownPnlBlocks({ count, oldestClosedAt = null, unattributedCount = 0, unresolvableCount = 0, agedOutCount = 0, agedOutOldest = null, agedOutAfterMin = null }, { enabled = DEFAULT_UNKNOWN_PNL_BLOCK, graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN, scope = 'account' } = {}) {
  // WRITTEN-OFF ROWS ARE NAMED, WHEREVER THE ANSWER LANDS.
  //
  // #513 claimed that excluding unresolvable rows from the blocking count meant
  // "trading resuming is never silent about what it stopped waiting for". That
  // claim was not true as shipped: unresolvableCount was computed, handed to
  // this function, and then dropped on the floor — this signature did not even
  // destructure it. The only place a reason is ever produced is a VETO, so in
  // the one case that matters most (rows written off, veto therefore lifted,
  // trading resumes) nothing was said at all. Found auditing my own change.
  //
  // `note` rides on BOTH outcomes, so a caller can record it whether or not the
  // gate blocked. It is deliberately not part of `reason`: a reason is why
  // something was refused, and this is a fact about what is no longer being
  // waited on.
  const parts = []
  if (Number(unresolvableCount) > 0) {
    parts.push(`${unresolvableCount} closed trade(s) in this window are marked unresolvable — the broker has no deal history for them, so they are no longer waited on and their P&L is permanently unknown, not zero`)
  }
  // AGED OUT is its own sentence, never folded into the write-off one. "The
  // broker says there is no deal history" and "we waited N minutes and gave
  // up" are different facts, and the second one is the weaker claim — it must
  // not borrow the first one's certainty.
  if (Number(agedOutCount) > 0) {
    parts.push(`${agedOutCount} closed trade(s) stopped blocking on AGE alone after ${agedOutAfterMin}m${agedOutOldest ? ` (oldest ${agedOutOldest})` : ''} — the backfill never filled them, so the day's loss total is incomplete by an unknown amount rather than known to be complete`)
  }
  const writtenOff = parts.length ? parts.join('; ') : null
  if (enabled === false) return { block: false, ...(writtenOff ? { note: writtenOff } : {}) }
  if (count === 0) return { block: false, ...(writtenOff ? { note: writtenOff } : {}) }
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
    ...(writtenOff ? { note: writtenOff } : {}),
  }
}
