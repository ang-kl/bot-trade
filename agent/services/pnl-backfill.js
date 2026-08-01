// ---------------------------------------------------------------------------
// agent/services/pnl-backfill.js — fill broker-true realized P&L onto CLOSED
// trades that the reconciler could only mark closed.
//
// Why this exists (the single most damaging bug the audit found): when the BOT
// closes a position it stamps net_pnl from the close deal (loop.js). But when
// a position is closed by the BROKER's own resting SL/TP — the normal exit for
// a stop-out — the reconciler marks the trade 'closed' with net_pnl LEFT NULL
// (reconciler.js). Until now the ONLY thing that filled those NULLs was the
// on-demand POST /actions/broker-history route, called ONLY from the Desk page.
//
// So every automated brake that keys on realized P&L was blind to broker
// stop-outs unless a human had the dashboard open:
//   · daily-loss veto / equity stop   — SUM(net_pnl) skips NULLs → under-count
//   · consecutive-loss cooldown        — (net_pnl||0)<0 → a stop-out reads as 0
//   · performance breaker / auto-disarm — WHERE net_pnl IS NOT NULL → excluded
//   · Kelly negative-expectancy veto    — censored sample
// The exact trades most likely to close at the broker (losers hitting the
// resting SL) were exactly the ones the safety system could not see. For an
// autonomous agent, its own risk gates must not depend on a browser being open.
//
// This module does the same deal-history backfill the route does, but as a
// plain server-side function the loop calls right after reconcile — so the
// brakes see reality every cycle. It fills ONLY rows still NULL (never
// overwrites a bot-computed net_pnl, which is already broker-true).
// ---------------------------------------------------------------------------

import { normPosId } from '../lib/pos-id.js'

const WEEK_MS = 7 * 24 * 3_600_000

/**
 * Should this loop cycle run the P&L backfill? Any reconcile path that can
 * close a trade with net_pnl left NULL must be able to trigger it — not just
 * closedDetected (the broker-detected-close loop). The orphan sweep and
 * dedup sweep (reconciler.js) also close trades with net_pnl left NULL but
 * used to never populate closedDetected, so a trade closed ONLY via those
 * two paths could never trigger this backfill and sat permanently excluded
 * from Edge Health (alpha-decay.js's `net_pnl IS NOT NULL` read) — a silent
 * gap, not a transient one. Pure/testable; backfillClosedPnl itself still
 * self-gates on its own COUNT(*) check, so this only widens WHEN it's
 * called, never what it does once called.
 * @param {{closedDetected?:Array, orphansClosed?:Array, dupsClosed?:Array}} result
 */
export function shouldRunPnlBackfill(result) {
  return (result?.closedDetected || []).length > 0
    || (result?.orphansClosed || []).length > 0
    || (result?.dupsClosed || []).length > 0
}

/**
 * Backfill net_pnl / gross_pnl for closed trades that have none, from the
 * broker's deal history. Realised money fields live on each closing deal's
 * closePositionDetail, scaled by moneyDigits — identical maths to
 * POST /actions/broker-history so the loop and the dashboard agree.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{host,clientId,clientSecret,accessToken,accountId}} creds
 * @param {{ days?: number, now?: number, getDeals?: Function }} [opts]
 *   getDeals is injectable for tests; defaults to the real ws client.
 * @returns {Promise<{ backfilled: number, closingDeals: number, scanned: number }>}
 */
export async function backfillClosedPnl(db, creds, opts = {}) {
  // ACCOUNT SCOPE (2026-07-29). This used to count the gap across EVERY
  // account while fetching deal history for exactly ONE — whichever account
  // happened to be selected. On the M4 soak that meant seven closed trades on
  // 46130058 were counted as a gap, the deal list was requested for 43097342,
  // nothing matched, and the loop logged "deal history had no matching close
  // (check broker deal-history coverage)" every cycle. The coverage was fine.
  // It was asking the wrong account.
  //
  // That is not just a reporting miss. This module's whole purpose (see the
  // header) is that the daily-loss veto, equity stop, loss-streak cooldown,
  // performance breaker and Kelly veto all key on realised P&L — so on every
  // account except the selected one, all of those brakes were blind to
  // broker-side stop-outs. The caller now passes an accountId and iterates.
  //
  // `includeNull` mirrors reconciler.js: rows predating account stamping
  // belong to the SELECTED account, because that was the only account trading
  // when they were written. A non-selected pass must not claim them.
  const selected = (() => {
    try { return db.prepare(`SELECT value FROM agent_state WHERE key = 'ctrader_account_id'`).get()?.value || null }
    catch { return null }
  })()
  const acct = opts.accountId != null ? String(opts.accountId) : selected
  const includeNull = acct == null || acct === selected
  const scopeSql = acct == null
    ? ''
    : includeNull ? 'AND (account_id = ? OR account_id IS NULL)' : 'AND account_id = ?'
  const scopeParams = acct == null ? [] : [acct]

  // Nothing to do unless some closed trade ON THIS ACCOUNT is actually
  // missing its P&L. This cheap check gates the broker round-trip so we don't
  // hit the deal API when every closed trade is already accounted for.
  // The gap check ALWAYS counts NULL-account rows too: an orphan row's close
  // may live in ANY account's deal history, so every account's pass must be
  // willing to fetch while one exists — that is what lets attribute-on-match
  // below ever run. (The strict scope stays on the UPDATE; only the "should
  // we bother fetching" question widens.)
  const gapScopeSql = acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'
  const gap = db.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql}`
  ).get(...scopeParams)
  // `gap` travels back out so the caller can tell "nothing was missing" from
  // "something was missing and the broker had no matching close". Those two
  // look identical from backfilled === 0 alone, and only the second one
  // should cost a retry.
  if (!gap || gap.n === 0) return { backfilled: 0, attributed: 0, closingDeals: 0, scanned: 0, gap: 0 }

  const days = Math.min(190, Math.max(1, Number(opts.days) || 14))
  const now = opts.now ?? Date.now()
  const from = now - days * 24 * 3_600_000

  let getDeals = opts.getDeals
  if (!getDeals) {
    const { wsGetDeals } = await import('../lib/ctrader-ws.js')
    const { host, clientId, clientSecret, accessToken, accountId } = creds
    getDeals = (t0, t1) => wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1)
  }

  const deals = []
  for (let t0 = from; t0 < now; t0 += WEEK_MS) {
    const chunk = await getDeals(t0, Math.min(t0 + WEEK_MS, now))
    deals.push(...((chunk && chunk.deal) || []))
  }

  // Only deals that CLOSE (part of) a position carry realised P&L. Aggregate
  // per position so a scaled-out close (several partial deals) sums to one
  // net figure, exactly as the route does.
  const byPosition = new Map()
  let closingDeals = 0
  for (const d of deals) {
    const cpd = d.closePositionDetail
    if (!cpd) continue
    const positionId = normPosId(d.positionId)
    if (!positionId) continue
    closingDeals++
    const scale = Math.pow(10, cpd.moneyDigits ?? 2)
    const m = (v) => (v == null ? 0 : v / scale)
    const gross = m(cpd.grossProfit)
    const net = gross + m(cpd.swap) + m(cpd.commission)
    const agg = byPosition.get(positionId) || { net: 0, gross: 0, swap: 0, commission: 0 }
    agg.net += net
    agg.gross += gross
    // Forensics: keep the cost components separate too (Performance Ledger
    // shows cost-per-strategy; folding them into net loses that).
    agg.swap += m(cpd.swap)
    agg.commission += m(cpd.commission)
    byPosition.set(positionId, agg)
  }

  // Fill ONLY the gaps: a closed trade whose net_pnl is still NULL. Never
  // touch a row the bot already stamped — that value is already broker-true,
  // and overwriting it with an aggregate could double-count partial closes.
  // Scoped on the way in AND on the way out: a position id is unique at the
  // broker, but writing without the account clause would let one account's
  // deal list fill another account's row if ids ever collided across accounts.
  // CAST both sides: rows written before the pos-id repair migration can
  // still carry float-formatted ids ("234698574.0") — plain equality against
  // the broker's "234698574" never matched, which is exactly how 52 closed
  // trades sat NULL on production (2026-08-02). Deal position ids are always
  // numeric, so a non-numeric stored id (CAST → 0) can never false-match.
  const upd = db.prepare(
    `UPDATE trades
        SET net_pnl = ?, gross_pnl = COALESCE(gross_pnl, ?),
            swap = COALESCE(swap, ?), commission = COALESCE(commission, ?)
      WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
        AND status = 'closed' AND net_pnl IS NULL ${scopeSql}`
  )
  // ATTRIBUTE-ON-MATCH (2026-07-31). A closed trade with account_id NULL is
  // the single worst row in the system: unresolved-pnl.js blocks EVERY
  // account on it, and mark-unresolvable.js can never write it off because
  // its candidate query filters on `account_id IN (…)`. The veto's own reason
  // string tells the owner to "attribute or backfill that row" — this is
  // where that becomes possible without a database session.
  //
  // The claim is broker truth, not a guess: a position id appearing in THIS
  // account's deal history with a closePositionDetail means the broker
  // executed that close on this account, so the row gains its P&L and its
  // account in one write. Position ids are unique at the broker, so a
  // cross-account collision cannot occur. Without this, a non-selected pass
  // (whose scope has no NULL arm) could never touch these rows at all.
  const claim = db.prepare(
    `UPDATE trades
        SET account_id = ?,
            net_pnl = ?, gross_pnl = COALESCE(gross_pnl, ?),
            swap = COALESCE(swap, ?), commission = COALESCE(commission, ?)
      WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
        AND status = 'closed' AND net_pnl IS NULL
        AND account_id IS NULL`
  )
  let backfilled = 0
  let attributed = 0
  const tx = db.transaction((entries) => {
    for (const [positionId, agg] of entries) {
      const money = [
        Math.round(agg.net * 100) / 100,
        Math.round(agg.gross * 100) / 100,
        Math.round((agg.swap || 0) * 100) / 100,
        Math.round((agg.commission || 0) * 100) / 100,
      ]
      const r = upd.run(...money, positionId, ...scopeParams)
      backfilled += r.changes
      // Only when the scoped update did not already take the row — the
      // selected-account pass covers NULL rows itself via includeNull.
      if (acct != null && r.changes === 0) {
        const c = claim.run(String(acct), ...money, positionId)
        attributed += c.changes
        backfilled += c.changes
      }
    }
  })
  tx([...byPosition])

  return { backfilled, attributed, closingDeals, scanned: deals.length, gap: gap.n }
}

// ---------------------------------------------------------------------------
// ATTEMPT PACING (2026-07-29).
//
// The backfill used to run ONLY on a cycle where the reconciler reported a
// close (shouldRunPnlBackfill). That trigger cannot see most closes: the
// reconcile that feeds it runs once, for the SELECTED account (loop.js), so a
// position closing on any other account never sets it. Measured on the M4
// soak — Cocoa closed at 12:14:30Z on 46130058 while 43097342 was selected,
// and not one of the eight closed trades gained a net_pnl.
//
// So the gate is inverted: attempt whenever a GAP EXISTS, which is a question
// about our own database and cannot be wrong about which account it is
// asking. A detected close still short-circuits the pacing below, so a fresh
// stop-out is filled on the same cycle rather than waiting on a backoff.
//
// The pacing exists because a gap can be PERMANENT: a trade whose closing
// deal falls outside the deal-history window will never fill, and without
// pacing that one row would buy a deal-list fetch per account every five
// minutes forever. Exponential backoff, reset the moment anything fills.
//
// State is in-memory on purpose. A redeploy clears it, which means a fresh
// process retries immediately — the right bias: after a restart we would
// rather pay one fetch than stay quiet about money the brakes need.
// ---------------------------------------------------------------------------
const BACKOFF_MS = [0, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000]
const attempts = new Map() // accountId → { n, nextAt }

/** Is this account due for a backfill attempt? */
export function dueForBackfill(accountId, now = Date.now()) {
  const a = attempts.get(String(accountId))
  return !a || now >= a.nextAt
}

/**
 * Record what an attempt achieved, and pace the next one.
 *
 * Anything filled, or no gap at all, resets the ladder — the account is
 * healthy. A gap that did not fill is the only case that costs a step.
 */
export function noteBackfillAttempt(accountId, result, now = Date.now()) {
  const id = String(accountId)
  const filled = (result?.backfilled || 0) > 0
  const stuck = !filled && (result?.gap || 0) > 0
  if (!stuck) { attempts.delete(id); return { n: 0, nextAt: now } }
  const prev = attempts.get(id)?.n || 0
  const n = Math.min(prev + 1, BACKOFF_MS.length - 1)
  const next = { n, nextAt: now + BACKOFF_MS[n] }
  attempts.set(id, next)
  return next
}

/** Test/ops hook — forget all pacing state. */
export function resetBackfillPacing() { attempts.clear() }

/**
 * Accounts this process has driven to the TOP backoff rung — i.e. the backfill
 * has tried repeatedly and never filled anything.
 *
 * This is the "we tried and gave up" half of the evidence
 * services/mark-unresolvable.js requires before it will call a row's P&L
 * unknowable. Exported rather than inferred, because the alternative is guessing
 * from a log line, and a wrong "we gave up" would stop the veto blocking a row
 * that could still have been repaired.
 *
 * In-memory, like the ladder itself: a redeploy clears it, and the right bias
 * after a restart is to retry rather than write anything off.
 */
export function exhaustedAccounts() {
  const top = BACKOFF_MS.length - 1
  return [...attempts.entries()].filter(([, a]) => a.n >= top).map(([id]) => id)
}
