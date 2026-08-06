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
import { checkTradeConsistency, realisedRR } from './trade-consistency.js'
import { DEFAULT_UNKNOWN_PNL_GRACE_MIN } from './unresolved-pnl.js'

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
  // ROWS TO REPAIR ARE A SECOND REASON TO FETCH.
  //
  // Caught by this file's own test run: the gate below used to skip the broker
  // round-trip whenever no closed trade was missing P&L — and every one of the
  // 56 self-contradicting rows HAS its P&L. That is the whole point of them:
  // the money is right and the price is wrong. So the exit repair would have
  // shipped and never once fired in production, which is worse than not
  // shipping it. A row worth repairing now counts as work to do.
  const mismatch = (() => {
    try {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE status = 'closed' AND pnl_price_mismatch = 1 ${gapScopeSql}`
      ).get(...scopeParams)?.n || 0
    } catch { return 0 }
  })()

  if ((!gap || gap.n === 0) && mismatch === 0) {
    return { backfilled: 0, attributed: 0, exitsRepaired: 0, closingDeals: 0, scanned: 0, gap: 0, liveGap: 0, blockingGap: 0 }
  }

  // THE LIVE GAP — rows still worth retrying for, which is NOT the same set.
  //
  // MEASURED 04-08-2026, production. `unknown_daily_pnl` was 34,818 of 56,304
  // vetoes over seven days, 62% of everything, and the age-out and
  // exhausted-attempts write-offs that were supposed to have fixed it were
  // both working. The rows actually blocking were FRESH — 17 trades closed
  // within the previous 78 minutes, well inside the 6-hour age-out and well
  // under the 6-attempt cap. They were blocking simply because their P&L had
  // not arrived yet, for over an hour.
  //
  // WHY IT HAD NOT ARRIVED: three rows on 46130058 (GBPJPY, GBPCNH and
  // 0066.HK — the same three named in unresolved-pnl.js) sit at 42 failed
  // attempts and will never fill. `noteBackfillAttempt` calls a pass "stuck"
  // when `gap > 0 && backfilled === 0`, and `gap` counted those three. So on
  // any pass that happened to fill nothing new, three dead rows ratcheted the
  // account one rung up a [0, 5m, 15m, 1h, 6h] ladder — and, since they can
  // never fill, nothing ever reset it. /state/unresolvable-plan reports
  // 46130058 and 47790949 both at the TOP rung.
  //
  // The consequence is the veto: an account parked on the 6-hour rung does
  // not fetch deal history, so every trade that closes waits up to six hours
  // for its P&L while a 15-minute grace window blocks every new entry. Three
  // rows nobody could fix stopped an account from trading, indefinitely, by
  // way of a retry ladder that was never meant to be about them.
  //
  // So pacing is decided on the rows a retry could still HELP: not written
  // off, and not past the attempt cap. The dead rows stay in `gap` — they are
  // still a real hole in the ledger and the veto still reports them — they
  // just stop voting on how often we ask the broker.
  const liveGap = (() => {
    try {
      const cols = db.prepare('PRAGMA table_info(trades)').all()
      const hasUnresolvable = cols.some(c => c.name === 'pnl_unresolvable')
      const hasAttempts = cols.some(c => c.name === 'pnl_attempts')
      const clauses = []
      const args = [...scopeParams]
      if (hasUnresolvable) clauses.push('AND COALESCE(pnl_unresolvable, 0) = 0')
      if (hasAttempts) { clauses.push('AND COALESCE(pnl_attempts, 0) < ?'); args.push(LIVE_GAP_MAX_ATTEMPTS) }
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql} ${clauses.join(' ')}`
      ).get(...args)
      return row?.n ?? gap.n
    } catch {
      // A schema without the columns behaves exactly as before: every missing
      // row counts. Same fail-safe reasoning as unresolved-pnl.js.
      return gap.n
    }
  })()

  // THE BLOCKING GAP — live rows that are ALREADY vetoing entries.
  //
  // MEASURED 06-08-2026 22:38 UTC, production: 194 vetoes in the last 200
  // decisions, every one `unknown_daily_pnl`, off ONE trade closed 22:09:46 —
  // twenty-nine minutes old, far inside the 6-hour age-out and far under the
  // 6-attempt cap. Nothing was written off, nothing was stale. The row was
  // simply young, and its deal history had not arrived.
  //
  // WHY THAT BLOCKED FOR LONGER THAN IT SHOULD HAVE. The veto engages at the
  // grace window (15m). The retry ladder is [0, 5m, 15m, 1h, 6h] and steps up
  // on any pass where a live row did not fill — and a fresh row whose deal
  // history has not published yet is exactly that. Three non-filling passes
  // take about twenty minutes of wall clock and land the account on the
  // ONE-HOUR rung; a fourth lands it on six hours. So the repair backs off at
  // the very moment the block engages, and the desk waits hours for a figure
  // a retry at 15 minutes would probably have collected.
  //
  // #574's `liveGap` fixed DEAD rows polluting the pacing. It cannot help
  // here: these rows are live, they legitimately count as outstanding, and
  // they legitimately ratchet the ladder. The missing idea is that a row which
  // is *currently blocking the desk* must pace the repair at least as often as
  // it blocks.
  //
  // So this counts the rows past the grace window — the ones actually costing
  // trades right now — and noteBackfillAttempt caps the backoff at the grace
  // window while any exist. Nothing about the VETO changes: same threshold,
  // same scope, same fail-closed semantics, and net_pnl still comes only from
  // broker deal history. What changes is how often we ask.
  const blockingGap = (() => {
    try {
      const grace = Number.isFinite(Number(opts.graceMin)) && Number(opts.graceMin) >= 0
        ? Number(opts.graceMin)
        : DEFAULT_UNKNOWN_PNL_GRACE_MIN
      const cols = db.prepare('PRAGMA table_info(trades)').all()
      const clauses = []
      const args = [...scopeParams]
      if (cols.some(c => c.name === 'pnl_unresolvable')) clauses.push('AND COALESCE(pnl_unresolvable, 0) = 0')
      if (cols.some(c => c.name === 'pnl_attempts')) { clauses.push('AND COALESCE(pnl_attempts, 0) < ?'); args.push(LIVE_GAP_MAX_ATTEMPTS) }
      // Same REPLACE(closed_at,'T',' ') normalisation the veto and the caps
      // use — mixing the two timestamp formats silently excluded every
      // production-closed trade once before (risk.js:525-534).
      clauses.push(`AND REPLACE(closed_at, 'T', ' ') <= datetime('now', ?)`)
      args.push(`-${grace} minutes`)
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql} ${clauses.join(' ')}`
      ).get(...args)
      return row?.n ?? 0
    } catch {
      // Unknown means "do not claim the desk is blocked", which leaves pacing
      // exactly as it was. This is the one place where fail-safe points at the
      // OLD behaviour rather than at blocking: capping the backoff is a repair
      // accelerator, and accelerating on a failed count would be guessing.
      return 0
    }
  })()

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
    const agg = byPosition.get(positionId) || { net: 0, gross: 0, swap: 0, commission: 0, pxVol: 0, vol: 0 }
    agg.net += net
    agg.gross += gross
    // THE EXIT PRICE THE LEDGER NEVER RECORDED (go-live Phase 0, P0-1).
    // The deal carries the price the close actually executed at. Weighted by
    // volume so a scaled-out close resolves to one honest average rather than
    // whichever partial happened to be last. 56 of 190 decidable closed rows
    // carry an exit_price that contradicts their own P&L; this is the only
    // source that can settle them.
    {
      const px = Number(d.executionPrice)
      const vol = Number(d.volume ?? d.filledVolume ?? 0)
      if (Number.isFinite(px) && px > 0 && Number.isFinite(vol) && vol > 0) {
        agg.pxVol += px * vol
        agg.vol += vol
      }
    }
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
  // EXIT-PRICE REPAIR. Deliberately separate from the P&L fill above, and
  // deliberately narrow: it touches ONLY rows the consistency check has
  // already flagged as disagreeing with themselves. A row whose exit price is
  // merely absent is left alone — absence is honest, and inventing a price for
  // it would turn a known unknown into a plausible wrong answer.
  const repairExit = db.prepare(
    `UPDATE trades
        SET exit_price = ?
      WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
        AND status = 'closed' AND pnl_price_mismatch = 1 ${scopeSql}`
  )
  let backfilled = 0
  let attributed = 0
  let exitsRepaired = 0
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
      // Volume-weighted exit, only for rows already flagged as contradicting
      // themselves. Re-stamp realised R and clear the flag from the repaired
      // row rather than assuming the repair worked — if the deal price still
      // disagrees with the money, that is a finding, not a success.
      if (agg.vol > 0) {
        const vwap = agg.pxVol / agg.vol
        const rep = repairExit.run(vwap, positionId, ...scopeParams)
        if (rep.changes) {
          exitsRepaired += rep.changes
          try {
            const rows = db.prepare(
              `SELECT id, side, entry_price, exit_price, sl_price, net_pnl FROM trades
                WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) AND status = 'closed'`
            ).all(positionId)
            for (const row of rows) {
              const c2 = checkTradeConsistency(row)
              db.prepare(`UPDATE trades SET realised_rr = ?, pnl_price_mismatch = ? WHERE id = ?`)
                .run(realisedRR(row), c2.decidable && !c2.ok ? 1 : 0, row.id)
            }
          } catch { /* the audit columns must never fail a backfill */ }
        }
      }
    }
  })
  tx([...byPosition])

  // §70.9: STAMP THE ATTEMPT ON EVERY ROW WE JUST LOOKED AT.
  //
  // Until now the only record that the repair had tried lived in a per-ACCOUNT
  // Map in this module's memory, which a restart erased — and this service
  // redeploys on every push. So "we tried repeatedly and never filled it", the
  // evidence mark-unresolvable.js demands before writing a row off, kept
  // resetting to zero, and a permanently unfillable row went on blocking the
  // desk with nothing able to say how hard anyone had tried.
  //
  // Per TRADE, not per account, because that is the granularity the decision
  // is made at. Rows that just filled are excluded — their net_pnl is no
  // longer NULL, so the UPDATE below cannot reach them.
  noteTradeAttempts(db, { accountId: acct, at: new Date(now).toISOString() })

  return { backfilled, attributed, exitsRepaired, closingDeals, scanned: deals.length, gap: gap.n, liveGap, blockingGap }
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

/**
 * Attempts past which a row stops voting on the retry cadence.
 *
 * Deliberately the same number as unresolved-pnl.js's
 * DEFAULT_UNKNOWN_PNL_MIN_ATTEMPTS: the row that has stopped blocking the
 * gate because the repair gave up on it is exactly the row that should stop
 * pacing the repair. Two different numbers here would mean a row that no
 * longer blocks entries can still slow the fetch that unblocks everything
 * else — which is the bug, wearing a smaller hat.
 */
export const LIVE_GAP_MAX_ATTEMPTS = 6
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
export function noteBackfillAttempt(accountId, result, now = Date.now(), opts = {}) {
  const id = String(accountId)
  const filled = (result?.backfilled || 0) > 0
  // LIVE gap, not total gap — see backfillClosedPnl. A row the repair has
  // already given up on must not keep an account climbing this ladder, or a
  // handful of permanently-dead rows park it on the six-hour rung forever and
  // every FRESH close then waits six hours for a figure that would have
  // arrived in one cycle. Falls back to `gap` for a caller that predates the
  // field, so old behaviour is preserved rather than silently loosened.
  const outstanding = result?.liveGap ?? result?.gap ?? 0
  const stuck = !filled && outstanding > 0
  if (!stuck) { attempts.delete(id); return { n: 0, nextAt: now } }
  const prev = attempts.get(id)?.n || 0
  const n = Math.min(prev + 1, BACKOFF_MS.length - 1)
  // A BLOCKED DESK IS RETRIED AT THE RATE IT IS BLOCKED.
  //
  // The rung still climbs — this does not reset or slow the ladder, and an
  // account with nothing blocking backs off exactly as before. What it refuses
  // is the specific perversity measured on 06-08: the veto engages at the
  // grace window (15m) while the repair that would clear it has already backed
  // off to an hour, then six. The desk then waits hours for a figure the next
  // retry would probably have collected, and every minute of that is trades
  // not taken.
  //
  // Capping at the grace window is the tightest bound that is still honest:
  // retrying faster than the veto blocks would be asking the broker for deal
  // history that, by the veto's own definition, is not yet late.
  //
  // NOT A WEAKENING. This changes how often we ASK, never what we accept.
  // net_pnl still comes only from broker deal history; the veto's threshold,
  // scope and fail-closed semantics are untouched. The only thing that can
  // happen sooner is the truth arriving.
  const blocking = Number(result?.blockingGap) || 0
  const graceMs = (Number.isFinite(Number(opts.graceMin)) && Number(opts.graceMin) >= 0
    ? Number(opts.graceMin)
    : DEFAULT_UNKNOWN_PNL_GRACE_MIN) * 60_000
  const delay = blocking > 0 ? Math.min(BACKOFF_MS[n], graceMs) : BACKOFF_MS[n]
  const next = { n, nextAt: now + delay }
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


/**
 * Record that the repair looked at every still-unresolved closed trade in
 * scope and could not fill it. Never throws — bookkeeping must not break a
 * best-effort repair.
 *
 * Scope note: NULL-account rows are stamped by every account's pass, matching
 * the gap check above. An orphan row's close may live in ANY account's deal
 * history, so every pass genuinely did try it.
 */
export function noteTradeAttempts(db, { accountId = null, at = new Date().toISOString() } = {}) {
  try {
    const scope = accountId == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'
    const args = accountId == null ? [at] : [at, String(accountId)]
    return db.prepare(`
      UPDATE trades
         SET pnl_attempts = COALESCE(pnl_attempts, 0) + 1,
             pnl_last_attempt_at = ?
       WHERE status = 'closed' AND net_pnl IS NULL ${scope}
    `).run(...args).changes
  } catch { return 0 }
}

/**
 * Closed trades the repair has tried at least `minAttempts` times and still
 * cannot fill. This is the DURABLE form of the evidence mark-unresolvable.js
 * wants — "we tried and gave up" as a fact on the row rather than a counter in
 * a process that restarts.
 *
 * It deliberately says nothing about WHY. A row here has been looked at
 * repeatedly and never filled; whether the broker has no deal history or the
 * fetch kept failing is a separate question, and conflating them is how a
 * transient outage would get a trade written off permanently.
 */
export function exhaustedTradeIds(db, { minAttempts = 6, accountId = null, limit = 200 } = {}) {
  try {
    const scope = accountId == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'
    const args = accountId == null
      ? [Math.max(1, minAttempts), Math.max(1, Math.min(1000, limit))]
      : [Math.max(1, minAttempts), String(accountId), Math.max(1, Math.min(1000, limit))]
    return db.prepare(`
      SELECT id, symbol, account_id, closed_at, pnl_attempts, pnl_last_attempt_at
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NULL
         AND COALESCE(pnl_attempts, 0) >= ?
         AND COALESCE(pnl_unresolvable, 0) = 0
         ${scope}
       ORDER BY pnl_attempts DESC, id ASC LIMIT ?
    `).all(...args)
  } catch { return [] }
}

/**
 * One number for "is the money ledger complete?", with enough shape to act on.
 * Read-only; the loop beats a heartbeat from it so a repair that STOPS is
 * visible as a stalled controller rather than only as a daily-loss veto
 * firing hours later — the same "silence is not health" lesson as §43.
 */
export function pnlReconciliationState(db, { accountId = null } = {}) {
  try {
    const scope = accountId == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'
    const args = accountId == null ? [] : [String(accountId)]
    const row = db.prepare(`
      SELECT COUNT(*) AS unresolved,
             MIN(closed_at) AS oldest,
             MAX(COALESCE(pnl_attempts, 0)) AS maxAttempts,
             SUM(CASE WHEN COALESCE(pnl_attempts, 0) = 0 THEN 1 ELSE 0 END) AS neverTried
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NULL
         AND COALESCE(pnl_unresolvable, 0) = 0 ${scope}
    `).get(...args) || {}
    return {
      unresolved: Number(row.unresolved) || 0,
      oldestClosedAt: row.oldest || null,
      maxAttempts: Number(row.maxAttempts) || 0,
      // A row nobody has tried is a DIFFERENT problem from one tried twenty
      // times: the first says the repair is not reaching it, the second says
      // the broker has nothing to give. Reporting one number for both is how
      // the earlier "deal history had no matching close" log blamed coverage
      // for what was an account-scoping bug.
      neverTried: Number(row.neverTried) || 0,
    }
  } catch {
    return { unresolved: -1, oldestClosedAt: null, maxAttempts: 0, neverTried: 0, error: true }
  }
}
