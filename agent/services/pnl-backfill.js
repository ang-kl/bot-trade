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
import { stampRealisedAudit } from './trade-consistency.js'
import { DEFAULT_UNKNOWN_PNL_GRACE_MIN } from './unresolved-pnl.js'
import { pageDeals } from '../lib/deal-paging.js'
import { verifiedPositionHistory, lifecycleBalance, FALSE_CLOSE_TOLERANCE_MS } from '../lib/position-deal-history.js'

// One tolerance, shared with the receipt linker (broker-history-import.js).
export { FALSE_CLOSE_TOLERANCE_MS }


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

/** Code on the local identity refusal: deterministic, never a transport failure. */
export const POSITION_LEDGER_IDENTITY = 'POSITION_LEDGER_IDENTITY'

function identityRefusal(message, count, rows) {
  return Object.assign(new Error(message), { code: POSITION_LEDGER_IDENTITY, count, rows })
}

// Ledger timestamps come in both 'YYYY-MM-DD HH:MM:SS' (UTC) and ISO forms.
const ledgerMs = v => {
  if (v == null || v === '') return NaN
  const raw = String(v).replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`)
}

/**
 * Why ONE ledger row may not take its broker position's whole P&L, or null
 * when it may, plus the row's opening time for the post-read check. The
 * position's money must land on exactly one row, and only on a reason, never
 * on the order rows happened to be reached in:
 *   - nothing else on the position may already carry money (double count);
 *   - nothing else may still claim the position. An open or in-flight row
 *     does. So does another unpriced close, UNLESS its whole lifetime ended at
 *     or before this row opened: then it is an earlier, superseded record of
 *     the same position (#372 closed 08-03 by a false "stale reconcile", #774
 *     re-adopted it 08-05; the broker closed it 09-09). Overlapping rows are
 *     true duplicates and are refused both ways — whether a row is written
 *     off does not decide it, or the first write-off would pick the winner.
 * The read then must show every closing deal at or after this row opened
 * (backfillClosedPnl), or the money may belong to the earlier record.
 * Which duplicate is the "real" one stays an operator's decision; this only
 * refuses to guess.
 */
function rowScopeRefusal(db, acct, positionId, positionScopeSql, tradeId, count) {
  if (count > 6) return { refusal: `${count} ledger rows share the position` }
  // Same identity rows as the count (V3 B1): rejected and cancelled rows hold
  // no position, and leaving them in let LIMIT 7 cut off a live claimant.
  const peers = db.prepare(`SELECT id, status, net_pnl, opened_at, closed_at, COALESCE(pnl_unresolvable, 0) AS written_off
    FROM trades WHERE account_id = ? ${positionScopeSql} AND status NOT IN ('rejected','cancelled') ORDER BY id LIMIT 7`).all(acct, positionId)
  const target = peers.find(r => Number(r.id) === tradeId)
  if (!target) {
    const own = db.prepare(`SELECT status FROM trades WHERE id = ? AND account_id = ? ${positionScopeSql}`).get(tradeId, acct, positionId)
    return { refusal: own ? `row #${tradeId} is ${own.status}` : `row #${tradeId} is not on this account and position` }
  }
  if (target.status !== 'closed') return { refusal: `row #${tradeId} is ${target.status}` }
  if (target.net_pnl != null) return { refusal: `row #${tradeId} already carries P&L` }
  const openedMs = ledgerMs(target.opened_at)
  if (!Number.isFinite(openedMs)) return { refusal: `row #${tradeId} has no readable opening time` }
  const others = peers.filter(r => r !== target)
  const booked = others.filter(r => r.net_pnl != null)
  if (booked.length) return { refusal: `position P&L already booked on ${booked.map(r => `#${r.id}`).join(',')}` }
  const claimants = others.filter(r => !['rejected', 'cancelled'].includes(r.status)
    && !(r.status === 'closed' && ledgerMs(r.closed_at) <= openedMs))
  if (claimants.length) {
    return { refusal: `other claimant(s) ${claimants.map(r => `#${r.id}:${r.status}${Number(r.written_off) === 1 ? '(written off)' : ''}`).join(',')}` }
  }
  // What is left beside the target: earlier closed records, unpriced, whose
  // whole lifetime ended at or before the target opened. The false-close rule
  // (falseCloseVerdict) decides from the broker's lifecycle whether they were
  // false closes of the position the target then held.
  return { refusal: null, openedMs, target, superseded: others }
}

/**
 * THE FALSE-CLOSE RULE (V3 B1, PR-1(d) with the checker's correction). With
 * the position's complete, balanced broker lifecycle in hand, an unpriced
 * closed row whose recorded close precedes the lifecycle's FINAL closing deal
 * (the one at which closed volume reaches opened volume) by more than the
 * tolerance was a false close: the broker still held the position. Compared
 * with the final deal, not the first: a partial close before the false close
 * would otherwise hide it.
 *
 * Applies only when the target row's own lifetime holds the final close (it
 * opened no later than the final deal and closed no earlier than it), so the
 * lifecycle is the target's to record; then every superseded peer must be a
 * proven false close, or nothing is decided. Returns null when the rule does
 * not apply, else `{ finalCloseMs, falseCloses: [{id, closedMs}] }`.
 * Pure over the rows given.
 */
export function falseCloseVerdict({ target, superseded = [], finalCloseMs }) {
  if (!target || !Number.isFinite(finalCloseMs)) return null
  const tol = FALSE_CLOSE_TOLERANCE_MS
  const opened = ledgerMs(target.opened_at), closed = ledgerMs(target.closed_at)
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null
  if (opened > finalCloseMs + tol || closed < finalCloseMs - tol) return null
  const falseCloses = []
  for (const r of superseded) {
    const closedMs = ledgerMs(r.closed_at)
    if (r.status !== 'closed' || r.net_pnl != null || !Number.isFinite(closedMs) || closedMs >= finalCloseMs - tol) return null
    falseCloses.push({ id: Number(r.id), closedMs })
  }
  return { finalCloseMs, falseCloses }
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
  // ACCT-DEMO-2 were counted as a gap, the deal list was requested for ACCT-DEMO-1,
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
  const strictAccount = opts.strictAccount === true
  const positionId = opts.positionId == null ? null : String(opts.positionId)
  if (positionId != null && (!strictAccount || !/^[1-9]\d*$/.test(positionId) || typeof opts.getPositionDeals !== 'function')) {
    throw new Error('strict position history reader required')
  }
  if (strictAccount && (!/^[1-9]\d*$/.test(acct || '') || String(creds.accountId) !== acct)) {
    throw new Error('backfill account identity required')
  }
  // ROW-SCOPED SETTLEMENT (V3 I1, LIFECYCLE-SPEC R3). `tradeId` narrows every
  // write below to ONE ledger row. It exists only for a position the ledger
  // holds more than once (production 25-09: #372/#774 AVY.US and #373/#775
  // GEV.US on …3489), and only on the strict per-position reader.
  const tradeId = opts.tradeId == null ? null : Number(opts.tradeId)
  if (tradeId != null && (positionId == null || !Number.isSafeInteger(tradeId) || tradeId <= 0)) {
    throw new Error('row-scoped backfill requires a position history reader and a trade id')
  }
  const includeNull = !strictAccount && (acct == null || acct === selected)
  const accountScopeSql = acct == null
    ? ''
    : includeNull ? 'AND (account_id = ? OR account_id IS NULL)' : 'AND account_id = ?'
  const positionScopeSql = positionId == null ? '' : 'AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)'
  const rowScopeSql = tradeId == null ? '' : 'AND id = ?'
  const scopeSql = `${accountScopeSql} ${positionScopeSql} ${rowScopeSql}`
  const scopeParams = [...(acct == null ? [] : [acct]), ...(positionId == null ? [] : [positionId]), ...(tradeId == null ? [] : [tradeId])]
  let rowOpenedMs = null, rowScope = null, filledRow = null
  if (positionId != null) {
    // IDENTITY ROWS ARE THE ONES THAT CAN HOLD THE POSITION (V3 B1, PR-1(c)).
    // A 'rejected' or 'cancelled' row is not a record of a position the
    // broker held — 214 of production's 327 rejected rows are superseded twins
    // of a closed row — and counting it refused the closed row for ever.
    const rows = db.prepare(`SELECT id,status,symbol,opened_at,closed_at FROM trades WHERE account_id = ? ${positionScopeSql}
      AND status NOT IN ('rejected','cancelled') ORDER BY id LIMIT 6`).all(acct, positionId)
    const count = db.prepare(`SELECT COUNT(*) n FROM trades WHERE account_id = ? ${positionScopeSql}
      AND status NOT IN ('rejected','cancelled')`).get(acct, positionId)?.n ?? rows.length
    if (tradeId == null && (count !== 1 || rows[0]?.status !== 'closed')) {
      // Bounded identity detail is safe operational evidence: it contains only
      // local trade IDs/status/timestamps already in the ledger, never broker
      // credentials or prices. Production 24-09-2026 exposed two old positions
      // that were repeatedly reached but could not explain why identity proof
      // failed. Keep the refusal; make its exact local contradiction observable.
      // The code lets the caller tell this LOCAL, deterministic refusal from a
      // failed broker read: it recurs on every pass until an operator acts, so
      // it is an attempt at the row, not a transport failure (V3 I1).
      throw identityRefusal(`position ledger identity ambiguous or not closed: count=${count}; rows=${JSON.stringify(rows)}`, count, rows)
    }
    if (tradeId == null) filledRow = Number(rows[0].id)
    if (tradeId != null) {
      const scope = rowScopeRefusal(db, acct, positionId, positionScopeSql, tradeId, count)
      if (scope.refusal) throw identityRefusal(`row-scoped settlement refused: ${scope.refusal}; count=${count}; rows=${JSON.stringify(rows)}`, count, rows)
      rowOpenedMs = scope.openedMs
      rowScope = scope
    }
  }

  // Nothing to do unless some closed trade ON THIS ACCOUNT is actually
  // missing its P&L. This cheap check gates the broker round-trip so we don't
  // hit the deal API when every closed trade is already accounted for.
  // The gap check ALWAYS counts NULL-account rows too: an orphan row's close
  // may live in ANY account's deal history, so every account's pass must be
  // willing to fetch while one exists — that is what lets attribute-on-match
  // below ever run. (The strict scope stays on the UPDATE; only the "should
  // we bother fetching" question widens.)
  // Hoisted above the gate: the missing-exit count below MUST be bounded by
  // the same window the deal fetch actually covers, or a row older than the
  // window counts as work that can never be done and pins the gate open for
  // ever — a broker round-trip every cycle, permanently, for nothing.
  const days = Math.min(190, Math.max(1, Number(opts.days) || 14))
  const now = opts.now ?? Date.now()
  const from = now - days * 24 * 3_600_000
  const lifetimeSql = strictAccount && positionId == null ? 'AND julianday(opened_at) >= julianday(?) AND julianday(opened_at) <= julianday(?)' : ''
  const lifetimeParams = lifetimeSql ? [new Date(from).toISOString(), new Date(now).toISOString()] : []
  const gapScopeSql = `${acct == null ? '' : strictAccount ? 'AND account_id = ?' : 'AND (account_id = ? OR account_id IS NULL)'} ${positionScopeSql} ${rowScopeSql}`
  const gap = db.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql}`
  ).get(...scopeParams)
  const eligibleGap = strictAccount ? db.prepare(`SELECT COUNT(*) AS n FROM trades
    WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql} ${lifetimeSql}`).get(...scopeParams, ...lifetimeParams).n : gap.n
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
  // WIDENED 08-08-2026, and this is the change that makes #691's repair fire
  // at all. That PR taught `repairExit` to accept `exit_price_suspect` — the
  // MAGNITUDE flag — but this gate still counted only the SIGN flag. A row
  // whose price is wrong by a factor and right in direction therefore never
  // made the pass fetch, so the widened repair sat behind a gate that could
  // not see the rows it was widened for. Same shape as the bug the comment
  // above describes, one flag later: a repair that ships and never fires is
  // worse than not shipping it.
  const repairable = (() => {
    try {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE status = 'closed'
            AND (pnl_price_mismatch = 1 OR exit_price_suspect = 1) ${gapScopeSql} ${lifetimeSql}`
      ).get(...scopeParams, ...lifetimeParams)?.n || 0
    } catch {
      // A schema without `exit_price_suspect` must still fetch for the sign
      // flag alone, exactly as before — a missing column is not a reason to
      // stop repairing the rows we CAN see.
      try {
        return db.prepare(
          `SELECT COUNT(*) AS n FROM trades
            WHERE status = 'closed' AND pnl_price_mismatch = 1 ${gapScopeSql} ${lifetimeSql}`
        ).get(...scopeParams, ...lifetimeParams)?.n || 0
      } catch { return 0 }
    }
  })()

  // AND A THIRD REASON: closed rows that have their money and no price at all.
  // Same trap one more time — `fillMissingExit` below can fill these from the
  // deal's execution price, but they are in neither `gap` (net_pnl is present)
  // nor `repairable` (a NULL is not a contradiction, so nothing flags it). Left
  // out, the fill would ship and never fire, which is the third instance of
  // this exact mistake in this one function.
  //
  // Bounded to `days`, deliberately: outside the fetch window there is no deal
  // to fill from, so counting those rows would keep the gate open for ever.
  const missingExits = (() => {
    try {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE status = 'closed' AND net_pnl IS NOT NULL AND exit_price IS NULL
            AND REPLACE(closed_at, 'T', ' ') >= datetime('now', ?) ${gapScopeSql} ${lifetimeSql}`
      ).get(`-${days} days`, ...scopeParams, ...lifetimeParams)?.n || 0
    } catch { return 0 }
  })()

  if (eligibleGap === 0 && repairable === 0 && missingExits === 0) {
    return { backfilled: 0, attributed: 0, exitsRepaired: 0, exitsFilled: 0, dealsPersisted: 0, closingDeals: 0, scanned: 0,
      gap: gap.n, liveGap: 0, blockingGap: 0, ...(strictAccount ? { lifetimeSkipped: gap.n } : {}) }
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
  // WHY IT HAD NOT ARRIVED: three rows on ACCT-DEMO-2 (GBPJPY, GBPCNH and
  // 0066.HK — the same three named in unresolved-pnl.js) sit at 42 failed
  // attempts and will never fill. `noteBackfillAttempt` calls a pass "stuck"
  // when `gap > 0 && backfilled === 0`, and `gap` counted those three. So on
  // any pass that happened to fill nothing new, three dead rows ratcheted the
  // account one rung up a [0, 5m, 15m, 1h, 6h] ladder — and, since they can
  // never fill, nothing ever reset it. /state/unresolvable-plan reports
  // ACCT-DEMO-2 and ACCT-DEMO-4 both at the TOP rung.
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
          WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql} ${clauses.join(' ')} ${lifetimeSql}`
      ).get(...args, ...lifetimeParams)
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
          WHERE status = 'closed' AND net_pnl IS NULL ${gapScopeSql} ${clauses.join(' ')} ${lifetimeSql}`
      ).get(...args, ...lifetimeParams)
      return row?.n ?? 0
    } catch {
      // Unknown means "do not claim the desk is blocked", which leaves pacing
      // exactly as it was. This is the one place where fail-safe points at the
      // OLD behaviour rather than at blocking: capping the backoff is a repair
      // accelerator, and accelerating on a failed count would be guessing.
      return 0
    }
  })()

  let getDeals = opts.getDeals
  if (!getDeals) {
    const { wsGetDeals } = await import('../lib/ctrader-ws.js')
    const { host, clientId, clientSecret, accessToken, accountId } = creds
    getDeals = (t0, t1) => wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1)
  }

  // THIS LOOP USED TO TRUNCATE SILENTLY, and of the three deal pulls in this
  // repo it is the one that matters most: its output is MONEY. It walked
  // week by week (cTrader's window cap) but never read `hasMore` (the
  // response cap, maxRows 500), so any week with more than 500 deals came
  // back short with no error — and a net P&L summed over a partial set is
  // wrong while looking exactly like a right one. lib/deal-paging.js follows
  // both limits and reports whether the walk finished.
  const pull = positionId == null ? await pageDeals(getDeals, from, now)
    : verifiedPositionHistory(await opts.getPositionDeals(positionId), { accountId: acct, positionId, now })
  // The cross-environment recovery must not stamp money or attempt evidence
  // from partial history, nor write after its bounded read deadline.
  if (strictAccount && (!pull.complete || (opts.isCurrent && !opts.isCurrent()))) {
    throw new Error(!pull.complete ? `deal history incomplete: ${pull.reason}` : 'backfill deadline elapsed')
  }
  const deals = pull.deals
  let ruling = null
  if (tradeId != null) {
    // Row-scoped: the broker must have closed the position inside THIS row's
    // lifetime. A close before it opened may be the earlier record's money —
    // UNLESS the complete lifecycle proves every earlier record a false close
    // (V3 B1): then the whole lifecycle, including a partial close made while
    // the false record stood, is this row's, and the false records are marked
    // rejected with the evidence below. Never on an unbalanced lifecycle.
    const verdict = falseCloseVerdict({ target: rowScope?.target, superseded: rowScope?.superseded ?? [],
      finalCloseMs: pull.lifecycle?.balanced ? pull.lifecycle.finalCloseMs : NaN })
    const early = deals.find(d => d.closePositionDetail && Number(d.executionTimestamp) < rowOpenedMs)
    if (early && !verdict) {
      throw identityRefusal(`row-scoped settlement refused: closing deal ${early.dealId} precedes row #${tradeId}'s opening`, null, [])
    }
    ruling = verdict?.falseCloses.length ? verdict : null
  }
  // A WINDOW IS NOT A LIFECYCLE (V3 B1, PR-1(a)). A completed 14-day query
  // is the whole of a position's money only when the position's OPENING deal
  // is among the pulled deals and its closed volume equals its opened volume.
  // This replaces a check on the LOCAL opened_at, which on a re-adopted row is
  // the adoption time, not the broker's open: probe-p5bd case 2 paid 50 of a
  // 150 lifetime because the opening and a first partial close fell before the
  // window. A position whose lifecycle the window cannot show is DEFERRED to
  // the per-position reader (old-position-pnl.js), which reads its whole
  // history. `uncoveredPositions` keeps its name for the result field.
  // EVERY WINDOW PASS, STRICT OR NOT (V3 F5, B1 checker N6). B1 applied the
  // rule to strict calls only, because the non-strict path had no production
  // caller and its tests were closing-deal-only fixtures. A caller added later
  // would have written one window's closing deals as a position's money — the
  // defect B1 exists to stop — so the rule holds on both paths now. Non-strict
  // has no per-position reader to hand to: a deferred position stays NULL
  // (reported in `deferred`, excluded from attempts) until a strict pass or
  // the per-position reader settles it.
  const windowPass = positionId == null
  const uncoveredPositions = new Set()
  if (windowPass) {
    const byPid = new Map()
    for (const d of deals) {
      const pid = normPosId(d.positionId)
      if (!pid) continue
      if (!byPid.has(pid)) byPid.set(pid, [])
      byPid.get(pid).push(d)
    }
    for (const [pid, list] of byPid) {
      if (!list.some(d => d.closePositionDetail)) continue
      if (!lifecycleBalance(list, pid).balanced) uncoveredPositions.add(pid)
    }
  }
  // WHAT THIS PASS COULD WRITE AT ALL (B1 checker N1/N2). One read of the
  // account's closed rows that a statement below could change — unpriced, or
  // an exit price absent or flagged — in the identity scope (the writes' scope
  // plus the rows the no-account claim may take). A position with no such row
  // is not written, not checked for identity, not deferred and not handed
  // off: the identity check was one CAST scan of trades per closing position
  // (the checker measured 84 ms for 500 positions at 2,000 rows, 982 ms at
  // 20,000, on the main thread), it
  // warned on every pass about pairs that already carry money, and
  // `deferredPositions` counted priced and still-open positions, which could
  // fill the reader's 100-entry handoff before the rows that need a read.
  const identityScope = acct == null ? '' : strictAccount ? 'AND account_id = ?' : 'AND (account_id = ? OR account_id IS NULL)'
  const identityParams = acct == null ? [] : [acct]
  const writable = new Set(), unpriced = new Set()
  if (windowPass) {
    const writableSql = flags => `SELECT ctrader_position_id AS pid, MAX(net_pnl IS NULL) AS unpriced FROM trades
        WHERE status = 'closed' AND ctrader_position_id IS NOT NULL
          AND (net_pnl IS NULL OR exit_price IS NULL OR ${flags}) ${identityScope}
        GROUP BY ctrader_position_id`
    let rows
    // A schema without `exit_price_suspect` still reads the sign flag, as the
    // `repairable` count above does.
    try { rows = db.prepare(writableSql('pnl_price_mismatch = 1 OR exit_price_suspect = 1')).all(...identityParams) }
    catch { rows = db.prepare(writableSql('pnl_price_mismatch = 1')).all(...identityParams) }
    for (const r of rows) {
      const pid = normPosId(r.pid)
      if (!pid) continue
      writable.add(pid)
      if (Number(r.unpriced) === 1) unpriced.add(pid)
    }
  }
  // Deferred = a lifecycle the window cannot show whole AND a row still owed
  // its money. The skip below still covers every uncovered position: a
  // partial lifecycle's volume-weighted price is not the position's exit.
  const deferred = new Set([...uncoveredPositions].filter(pid => unpriced.has(pid)))
  if (!pull.complete) {
    console.warn(`[pnl-backfill] deal pull INCOMPLETE (${pull.reason}) after ${pull.pages} page(s) — figures below cover PART of the window`)
  }

  // PERSIST THE EVIDENCE. Best-effort, and deliberately after the fetch rather
  // than instead of it.
  //
  // Until now these deals were fetched, used to compute a number, and thrown
  // away. `broker_deals` was written ONLY by importBrokerHistory, called only
  // from a manual route nobody had ever run — so GET /state/broker-deals
  // returned zero rows for position 234799435, the 9,171.76 trade, and there
  // was no way to check the P&L against its own source. The figure was
  // broker-true and unverifiable at the same time, which is a bad combination
  // for the one number every risk brake keys on.
  //
  // Same shaper and same upsert as the manual route, so the two agree by
  // construction rather than by coincidence. Wrapped: a persistence failure
  // must never stop a backfill — the P&L fill is the job, this is the receipt.
  let dealsPersisted = 0
  try {
    if (deals.length) {
      const { shapeDeals, persistDeals } = await import('./broker-history-import.js')
      // symbolId -> { symbolName }, inverted from the map the loop already
      // keeps locally. The manual route builds richer metadata from TWO extra
      // broker calls; this path deliberately does not, because a receipt is
      // not worth adding round-trips to the trading loop for. The cost is that
      // `lots` may be absent where lotSize is unknown — acceptable, since the
      // fields this exists to preserve (deal id, position id, close price,
      // realised money, timestamps) do not depend on it, and a MISSING lot
      // size is honest where a guessed one would be the JPN225 mistake again.
      let symMeta = {}
      try {
        const idMap = strictAccount
          ? (await import('../lib/ctrader-creds.js')).getAccountSymbolMap(db, acct)?.map ?? {}
          : JSON.parse((db.prepare(`SELECT value FROM agent_state WHERE key = 'symbol_id_map'`).get()?.value) || '{}') || {}
        for (const [name, id] of Object.entries(idMap)) symMeta[id] = { symbolName: name }
      } catch { symMeta = {} }
      // V3 L2b W10: the broker's own lot size from the registry, so the deal
      // stores its lots — never a guessed divisor (lot-size-registry.js).
      const { withBrokerLotSizes } = await import('../lib/lot-size-registry.js')
      const shaped = shapeDeals(deals, withBrokerLotSizes(db, symMeta), acct)
      if (strictAccount && opts.isCurrent && !opts.isCurrent()) throw new Error('backfill deadline elapsed')
      dealsPersisted = persistDeals(db, shaped)?.seen || 0
    }
  } catch (e) {
    console.warn('[pnl-backfill] deal persistence skipped:', e.message)
  }
  if (strictAccount && opts.isCurrent && !opts.isCurrent()) throw new Error('backfill deadline elapsed')

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
    if (uncoveredPositions.has(positionId)) continue
    closingDeals++
    const scale = Math.pow(10, cpd.moneyDigits ?? 2)
    const m = (v) => (v == null ? 0 : v / scale)
    const gross = m(cpd.grossProfit)
    const net = gross + m(cpd.swap) + m(cpd.commission)
    const agg = byPosition.get(positionId) || { net: 0, gross: 0, swap: 0, commission: 0, pxVol: 0, vol: 0, fee: 0 }
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
      const vol = Number(opts.positionId == null ? (d.volume ?? d.filledVolume ?? 0) : d.filledVolume)
      if (Number.isFinite(px) && px > 0 && Number.isFinite(vol) && vol > 0) {
        agg.pxVol += px * vol
        agg.vol += vol
      }
    }
    // Forensics: keep the cost components separate too (Performance Ledger
    // shows cost-per-strategy; folding them into net loses that).
    agg.swap += m(cpd.swap)
    agg.commission += m(cpd.commission)
    // pnlConversionFee: NOT part of net (the convention on every path), but
    // summed so what is excluded is measured (B1 checker, owner question).
    // null once any closing deal's fee cannot be read.
    const fee = cpd.pnlConversionFee
    agg.fee = agg.fee == null || (fee != null && !/^-?\d+$/.test(String(fee))) ? null : agg.fee + m(fee)
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
  // deliberately narrow: it touches ONLY rows an audit has already flagged. A
  // row whose exit price is merely absent is left alone — absence is honest,
  // and inventing a price for it would turn a known unknown into a plausible
  // wrong answer.
  //
  // WIDENED 08-08-2026. The trigger was `pnl_price_mismatch = 1` alone, and
  // that flag is a SIGN check: it fires when the money and the prices disagree
  // about DIRECTION. Direction is half a price. A row pointing the right way
  // but wrong by a FACTOR — trade 641's 2.6 recorded points against a 9,171.76
  // charge — was never flagged, so it was never re-fetched and never repaired,
  // and every consumer computing R from prices went on reading it as fact.
  //
  // `exit_price_suspect` is the other half, written by the magnitude check in
  // services/exit-price-suspects.js. Either flag now earns a repair, because
  // either is enough to know the recorded price is not the fill.
  const repairExit = db.prepare(
    `UPDATE trades
        SET exit_price = ?
      WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
        AND status = 'closed'
        AND (pnl_price_mismatch = 1 OR exit_price_suspect = 1) ${scopeSql}`
  )
  // AND THE MISSING ONES. Separate statement, separate counter, because it is
  // a different intent and conflating them would hide which is doing the work.
  //
  // 08-08-2026. The note above says an absent exit price is "left alone —
  // absence is honest, and inventing a price for it would turn a known unknown
  // into a plausible wrong answer." That reasoning is right about INVENTING and
  // wrong about this: `d.executionPrice` is not a guess, it is the price the
  // close actually filled at. The consequence of the old rule was that FOUR of
  // the five close paths leave exit_price NULL (reconciler.js:392 being the
  // dominant one), no audit flags a NULL — correctly, absence is not a
  // contradiction — and so those rows were never filled by anything. The
  // ledger had the money and permanently lacked the price, for the majority of
  // its closes.
  //
  // Filling a NULL from broker truth is the opposite of inventing. What we
  // still refuse to do is OVERWRITE a price that is present and unflagged.
  const fillMissingExit = db.prepare(
    `UPDATE trades
        SET exit_price = ?
      WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
        AND status = 'closed' AND exit_price IS NULL ${scopeSql}`
  )
  // ONE ROW PER BROKER POSITION (V3 B1, PR-1(b)). The window update and the
  // no-account claim wrote EVERY unpriced closed row of a position with the
  // position's whole total: probe-p5bd case 1, a false close and its
  // re-adoption, both unpriced, got 150 each against a broker lifetime of 150.
  // Money now needs exactly one identity row — any status but rejected or
  // cancelled, in the scope the writes use plus unattributed rows — and it
  // must be closed. Anything else is AMBIGUOUS: logged with its row ids,
  // nothing written (money or exit), no attempt counted, and left to the
  // per-position reader, which settles one row from the complete history or
  // labels it (old-position-pnl.js). Which duplicate is real is never guessed.
  const ambiguous = new Map()
  if (windowPass && byPosition.size) {
    // Both text forms of the id as plain values (persistDeals does the same),
    // so idx_trades_position_id serves each lookup; only positions this pass
    // could write are checked.
    const identity = db.prepare(`SELECT id, status FROM trades WHERE ctrader_position_id IN (?, ?)
      AND status NOT IN ('rejected','cancelled') ${identityScope} ORDER BY id LIMIT 7`)
    for (const pid of byPosition.keys()) {
      if (!writable.has(pid)) continue
      const rows = identity.all(pid, `${pid}.0`, ...identityParams)
      if (rows.length > 1 || (rows.length === 1 && rows[0].status !== 'closed')) ambiguous.set(pid, rows)
    }
    for (const [pid, rows] of ambiguous) {
      console.warn(`[pnl-backfill] ledger identity ambiguous for position ${pid} on account ${acct ?? '(any)'}: rows ${rows.map(r => `#${r.id}:${r.status}`).join(',')} — no money written; the per-position reader decides`)
    }
  }
  // THE FALSE CLOSES, marked with their evidence (V3 B1, PR-1(d)). Rejected,
  // not deleted: the row, its close reason and its postmortems all stay (the
  // owner's rule, 25-09: never delete a record), and the reason names the
  // broker evidence and the row that now holds the lifecycle.
  const rejectFalseClose = db.prepare(`UPDATE trades SET status = 'rejected', close_reason = COALESCE(close_reason, '') || ?
    WHERE id = ? AND account_id = ? AND status = 'closed' AND net_pnl IS NULL`)
  const falseClosed = []
  let backfilled = 0
  let attributed = 0
  let exitsRepaired = 0
  let exitsFilled = 0
  let feeExcluded = 0, feeUnreadable = 0
  // Re-stamp realised R and the consistency verdict on every closed row of a
  // position after any write above changed its money or its prices. One
  // helper shared with closeTradeRow and the loop's price-reconcile step, so
  // the three writers cannot disagree about what the columns mean.
  const closedIds = db.prepare(
    `SELECT id FROM trades WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) AND status = 'closed' ${scopeSql}`
  )
  const restampPosition = (positionId) => {
    try { for (const { id } of closedIds.all(positionId, ...scopeParams)) stampRealisedAudit(db, id) } catch { /* audit columns never fail a backfill */ }
  }
  const tx = db.transaction((entries) => {
    if (ruling) {
      const until = new Date(ruling.finalCloseMs).toISOString()
      for (const f of ruling.falseCloses) {
        const changed = rejectFalseClose.run(` | false close: broker position ${positionId} open until ${until}; lifecycle on #${tradeId}`, f.id, acct).changes
        if (changed) falseClosed.push(f.id)
      }
    }
    for (const [positionId, agg] of entries) {
      // Nothing on the position that a statement below could change: skip the
      // four CAST scans (a no-op — every statement's WHERE is inside `writable`).
      if (windowPass && !writable.has(positionId)) continue
      if (ambiguous.has(positionId)) continue
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
      let moneyLanded = r.changes
      if (!strictAccount && acct != null && r.changes === 0) {
        const c = claim.run(String(acct), ...money, positionId)
        attributed += c.changes
        backfilled += c.changes
        moneyLanded += c.changes
      }
      // Money just landed on a row that had none: the self-consistency
      // verdict (money vs prices) was undecidable at close and is decidable
      // now, so re-stamp it — and the R, in case the prices arrived first
      // through the loop's price-reconcile step (02-09-2026: that step did
      // not stamp R, and the exit-fill below never ran for those rows
      // because the exit was no longer NULL).
      if (moneyLanded) restampPosition(positionId)
      if (moneyLanded) { if (agg.fee == null) feeUnreadable++; else feeExcluded += agg.fee }
      // Volume-weighted exit, only for rows already flagged as contradicting
      // themselves. Re-stamp realised R and clear the flag from the repaired
      // row rather than assuming the repair worked — if the deal price still
      // disagrees with the money, that is a finding, not a success.
      if (agg.vol > 0) {
        const vwap = agg.pxVol / agg.vol
        const rep = repairExit.run(vwap, positionId, ...scopeParams)
        // Fill the absent ones from the same volume-weighted deal price. Run
        // AFTER the repair so a row cannot be counted in both buckets, and
        // counted separately so "we corrected 3 and filled 40" stays legible.
        const fil = fillMissingExit.run(vwap, positionId, ...scopeParams)
        exitsFilled += fil.changes
        if (rep.changes || fil.changes) {
          exitsRepaired += rep.changes
          restampPosition(positionId)
        }
      }
    }
  })
  tx([...byPosition])
  if (falseClosed.length) {
    try {
      db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run('PNL_FALSE_CLOSE', '/pnl-backfill', JSON.stringify({
        accountId: acct, positionId, lifecycleOn: tradeId, rejected: falseClosed, finalCloseAt: new Date(ruling.finalCloseMs).toISOString(),
        conversionFeeExcluded: pull.lifecycle?.conversionFee ?? null,
        backfilled, source: 'broker complete position history', note: 'rows kept; status rejected with the evidence in close_reason (V3 B1)',
      }).slice(0, 2000))
    } catch { /* audit best-effort */ }
    // The receipts were linked before the rejection, when the ledger still
    // held the position twice (no link). Re-link now that one row holds it.
    try {
      const { shapeDeals, persistDeals } = await import('./broker-history-import.js')
      persistDeals(db, shapeDeals(deals, {}, acct))
    } catch (e) { console.warn('[pnl-backfill] receipt re-link skipped:', e.message) }
  }

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
  // Deferred and ambiguous positions are NOT attempts of this pass: the window
  // could not settle them by construction, and the per-position reader counts
  // its own evidence attempts on them (V3 B1).
  noteTradeAttempts(db, { accountId: acct, at: new Date(now).toISOString(), includeUnattributed: !strictAccount,
    positionId, tradeId, eligibleSince: lifetimeSql ? new Date(from).toISOString() : null, eligibleThrough: lifetimeSql ? new Date(now).toISOString() : null,
    excludePositionIds: windowPass ? [...deferred, ...ambiguous.keys()] : [] })

  return { backfilled, attributed, exitsRepaired, exitsFilled, dealsPersisted, closingDeals, scanned: deals.length, gap: gap.n, liveGap, blockingGap,
    // `ambiguous` counts every position whose writes were withheld;
    // `ambiguousPositions` is the handoff: only those with a row still owed
    // its money, which is what the per-position reader can settle.
    ambiguous: ambiguous.size,
    ...(ambiguous.size ? { ambiguousPositions: [...ambiguous].filter(([pid]) => unpriced.has(pid)).slice(0, 100)
      .map(([pid, rows]) => ({ positionId: pid, rows: rows.map(r => r.id) })) } : {}),
    ...(falseClosed.length ? { falseCloses: falseClosed } : {}),
    ...(positionId != null && backfilled ? { filledRowId: tradeId ?? filledRow } : {}),
    // Excluded from net by the one convention; reported so its size is
    // measured. Summed over the positions whose money landed in this pass.
    conversionFeeExcluded: Math.round(feeExcluded * 100) / 100,
    ...(feeUnreadable ? { conversionFeeUnreadable: feeUnreadable } : {}),
    ...(strictAccount && windowPass ? { lifetimeSkipped: deferred.size } : {}),
    ...(windowPass && (strictAccount || deferred.size) ? { deferred: deferred.size,
      ...(deferred.size ? { deferredPositions: [...deferred].slice(0, 100) } : {}) } : {}) }
}

// ---------------------------------------------------------------------------
// ATTEMPT PACING (2026-07-29).
//
// The backfill used to run ONLY on a cycle where the reconciler reported a
// close (shouldRunPnlBackfill). That trigger cannot see most closes: the
// reconcile that feeds it runs once, for the SELECTED account (loop.js), so a
// position closing on any other account never sets it. Measured on the M4
// soak — Cocoa closed at 12:14:30Z on ACCT-DEMO-2 while ACCT-DEMO-1 was selected,
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
export function noteTradeAttempts(db, { accountId = null, at = new Date().toISOString(), includeUnattributed = true,
  eligibleSince = null, eligibleThrough = null, positionId = null, tradeId = null, excludePositionIds = [] } = {}) {
  try {
    const scope = accountId == null ? '' : includeUnattributed ? 'AND (account_id = ? OR account_id IS NULL)' : 'AND account_id = ?'
    const args = accountId == null ? [at] : [at, String(accountId)]
    const lifetime = eligibleSince != null && eligibleThrough != null ? 'AND julianday(opened_at) >= julianday(?) AND julianday(opened_at) <= julianday(?)' : ''
    if (lifetime) args.push(eligibleSince, eligibleThrough)
    const position = positionId == null ? '' : 'AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)'
    if (positionId != null) args.push(String(positionId))
    // One row only: a position the ledger holds twice must not stamp the
    // sibling that was not the one asked about (V3 I1).
    const row = tradeId == null ? '' : 'AND id = ?'
    if (tradeId != null) args.push(Number(tradeId))
    // Positions the caller could not decide by construction (V3 B1: deferred
    // or ambiguous) are left for the reader that can. A row with no position
    // id is still stamped, as before.
    const excluded = Array.isArray(excludePositionIds) && excludePositionIds.length
      ? 'AND (ctrader_position_id IS NULL OR CAST(ctrader_position_id AS INTEGER) NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))' : ''
    if (excluded) args.push(JSON.stringify(excludePositionIds.map(String)))
    return db.prepare(`
      UPDATE trades
         SET pnl_attempts = COALESCE(pnl_attempts, 0) + 1,
             pnl_last_attempt_at = ?
       WHERE status = 'closed' AND net_pnl IS NULL ${scope} ${lifetime} ${position} ${row} ${excluded}
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
/**
 * The unresolved-P&L gap, SPLIT BY WHAT CAN STILL BE DONE ABOUT IT.
 *
 * WHY (measured 15-09-2026, production, and again on the owner's uploaded log
 * 17-09): the loop printed
 *
 *   "P&L backfill: 20 closed trade(s) still missing net_pnl … — deal history
 *    had no matching close"
 *
 * every cycle, from a bare `COUNT(*) WHERE status='closed' AND net_pnl IS NULL`
 * with no qualification at all (loop.js). That count includes rows this system
 * has ALREADY and CORRECTLY given up on: `pnl_unresolvable = 1` rows written
 * off by sweepUnresolvable because the broker has no deal history for them
 * past the horizon. `backfillClosedPnl` excludes exactly those rows from
 * `liveGap` so they stop pacing the retries — and then the log reported them
 * anyway, as though 20 repairable holes remained.
 *
 * So the panel and the mechanism disagreed, and the panel was the wrong one.
 * A reader seeing "20 still missing" every cycle for days cannot tell a broken
 * repair from a repair that finished and a ledger that is honestly incomplete.
 *
 * AND THE SENTENCE WAS FALSE FOR PART OF THE SET. "deal history had no
 * matching close" is a claim about the BROKER. For a row with
 * `pnl_attempts = 0` nobody has asked the broker anything — that row is
 * evidence about US, not about coverage. This module's own comment already
 * says so ("Reporting one number for both is how the earlier 'deal history had
 * no matching close' log blamed coverage for what was an account-scoping
 * bug") — the lesson was applied inside the helper and not to the line that
 * prints.
 *
 * `total` is the raw count, kept so the ledger's real incompleteness is never
 * hidden by the split.
 */
export function pnlGapBreakdown(db, { overdueMin = 15 } = {}) {
  const zero = { total: 0, writtenOff: 0, live: 0, neverTried: 0, neverTriedOverdue: 0, attempted: 0, oldestLive: null, error: false }
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND net_pnl IS NULL`
    ).get()?.n || 0
    if (total === 0) return zero
    const live = pnlReconciliationState(db, { overdueMin })
    if (live.unresolved < 0) return { ...zero, total, error: true }
    return {
      total,
      // Rows the system has finished with, on the record, with a reason.
      writtenOff: Math.max(0, total - live.unresolved),
      live: live.unresolved,
      neverTried: live.neverTried,
      neverTriedOverdue: live.neverTriedOverdue,
      // Only THESE justify a statement about broker coverage.
      attempted: Math.max(0, live.unresolved - live.neverTried),
      oldestLive: live.oldestClosedAt,
      error: false,
    }
  } catch { return { ...zero, error: true } }
}

export function pnlUnreachedRows(db, { overdueMin = 15, limit = 20 } = {}) {
  try {
    return db.prepare(`
      SELECT id, symbol, account_id AS accountId, ctrader_position_id AS positionId,
             opened_at AS openedAt, closed_at AS closedAt
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NULL
         AND COALESCE(pnl_unresolvable, 0) = 0
         AND COALESCE(pnl_attempts, 0) = 0
         AND closed_at IS NOT NULL
         AND datetime(REPLACE(closed_at, 'T', ' ')) < datetime('now', ?)
       ORDER BY datetime(REPLACE(closed_at, 'T', ' ')) ASC, id ASC
       LIMIT ?
    `).all(`-${Math.max(0, Number(overdueMin) || 0)} minutes`, Math.max(1, Math.min(100, Number(limit) || 20)))
  } catch { return [] }
}

/**
 * The pnl_reconcile heartbeat, decided from the PASS, not from the records.
 *
 * V3 I1 (production 25-09-2026): the beat was `ok` only while no unpriced
 * close was "never attempted" 15+ minutes after closing. Two rows the repair
 * reached on every pass but whose refusal it never counted (#774/#775) kept it
 * in error for four days — 1,776 consecutive failures, "have never been
 * attempted" — while the pass itself ran every time. A stuck RECORD is shown
 * where records are judged (order-lifecycle STK-05, the ledger's written-off
 * notice); this heartbeat now says whether the CONTROLLER did its job, on
 * EVERY account it covers:
 *   ok    — the state was readable and no account the pass tried failed
 *           (skipped and paced accounts are not failures);
 *   error — the state could not be read, or the repair failed on ANY account
 *           it tried, on either session: the selected session's accounts
 *           (`pass`) and the other session's, which loop.js repairs through
 *           backfillCrossSidePnl after this beat and hands to the NEXT beat
 *           (`opts.crossSide`, consume-once).
 * CORRECTED (checker B1, 25-09-2026): the first version beat ok while any
 * account completed, and read only the selected session's accounts — so with
 * a demo account selected, the live account holding #774/#775 could fail on
 * every pass and the beat stayed ok. Owner principle 1: the beat vouches for
 * every account or says which one it cannot vouch for. One failed pass is the
 * heartbeat's own `warn`; three in a row are its `error` (heartbeat.js).
 * Rows not yet attempted stay in the detail as a notice with their count, so
 * nothing is hidden; they are no longer reported as a controller failure.
 *
 * @param {{unresolved:number,neverTriedOverdue?:number}} st pnlReconciliationState
 * @param {{attempted?:number,completed?:number,skipped?:number,failures?:Array<{accountId:string,error:string}>,skippedFor?:Array<{accountId:string,reason:string}>}} pass
 *   the selected session's pass, normally pnlPassSummary(results)
 * @param {{crossSide?: {state:'pending'}|{state:'awaited',since:string|null,lastReportedAt:string|null}|({state:'reported',at:string|null}&object)}} [opts]
 *   the other session's last pass: 'pending' before its first run this
 *   process, 'reported' with a pnlPassSummary, 'awaited' once a beat has read
 *   it (pnlCrossSideAwaited) — still 'awaited' at the next beat means the
 *   cross-side repair did not run in between, which is a failure.
 */
export function pnlReconcileHeartbeat(st, pass = {}, { crossSide = null } = {}) {
  const own = normalisedPass(pass)
  let cross = { attempted: 0, completed: 0, skipped: 0, failures: [], skippedFor: [] }, crossView = null
  if (crossSide?.state === 'reported') {
    cross = normalisedPass(crossSide)
    crossView = { state: 'reported', at: crossSide.at ?? null, attempted: cross.attempted, completed: cross.completed, skipped: cross.skipped }
  } else if (crossSide?.state === 'awaited') {
    const last = crossSide.lastReportedAt ? `last report ${crossSide.lastReportedAt}` : 'no report this process'
    cross.failures = [{ accountId: 'cross-side', error: `the cross-side P&L repair has not reported since ${crossSide.since ?? 'the previous beat'} (${last})` }]
    crossView = { state: 'awaited', since: crossSide.since ?? null, lastReportedAt: crossSide.lastReportedAt ?? null }
  } else if (crossSide) crossView = { state: String(crossSide.state ?? 'pending') }
  const attempted = own.attempted + cross.attempted, completed = own.completed + cross.completed
  const failures = [...own.failures, ...cross.failures], skippedFor = [...own.skippedFor, ...cross.skippedFor]
  const tried = Math.max(attempted, failures.length + completed)
  const unreadable = !st || !(Number(st.unresolved) >= 0)
  const overdue = unreadable ? 0 : Number(st.neverTriedOverdue) || 0
  const notice = overdue > 0
    ? `${overdue} closed trade(s) with no realised P&L not yet attempted by the repair (15+ min after close); a record notice, not a controller failure`
    : null
  const listed = failures.slice(0, 3).map(f => `${f.accountId}: ${f.error}`).join('; ') + (failures.length > 3 ? `; +${failures.length - 3} more` : '')
  return {
    ok: !unreadable && failures.length === 0,
    error: unreadable
      ? 'pnl reconciliation state could not be read'
      : failures.length === 0
        ? null
        : completed === 0
          ? `the P&L repair pass failed on every account it tried (${failures.length}/${tried}): ${listed}`
          : `the P&L repair failed on ${failures.length} of ${tried} account(s) it tried: ${listed}`,
    detail: {
      ...(st || {}),
      pass: {
        attempted, completed, skipped: own.skipped + cross.skipped,
        failed: failures.slice(0, 7).map(f => ({ accountId: f.accountId, error: f.error.slice(0, 120) })),
        ...(skippedFor.length ? { skippedFor: skippedFor.slice(0, 7) } : {}),
        ...(crossView ? { crossSide: crossView } : {}),
      },
      ...(notice ? { notice } : {}),
    },
  }
}

function normalisedPass(p) {
  return {
    attempted: Math.max(0, Number(p?.attempted) || 0),
    completed: Math.max(0, Number(p?.completed) || 0),
    skipped: Math.max(0, Number(p?.skipped) || 0),
    failures: (Array.isArray(p?.failures) ? p.failures : [])
      .map(f => ({ accountId: String(f?.accountId ?? ''), error: String(f?.error ?? 'unknown error').slice(0, 160) })),
    skippedFor: (Array.isArray(p?.skippedFor) ? p.skippedFor : [])
      .map(s => ({ accountId: String(s?.accountId ?? ''), reason: String(s?.reason ?? '').slice(0, 60) })),
  }
}

/**
 * One session's per-account P&L repair outcomes, counted the way the
 * heartbeat reads them. Each entry is what backfillAccountPnl returns (or the
 * loop's own pacing skip): `result` completed, `skipped` skipped, anything
 * else a FAILURE with its account id — an entry that says neither is not
 * counted as done. Non-pacing skips (token refused, a read still in flight)
 * are listed by account so a skip that recurs every pass can be seen.
 */
export function pnlPassSummary(results, { at = null } = {}) {
  let completed = 0, skipped = 0
  const failures = [], skippedFor = []
  for (const r of Array.isArray(results) ? results : []) {
    const accountId = String(r?.accountId ?? '?')
    if (r?.result) completed++
    else if (r?.skipped) {
      skipped++
      if (r.skipped !== 'paced') skippedFor.push({ accountId, reason: String(r.skipped).slice(0, 60) })
    } else failures.push({ accountId, error: String(r?.error ?? 'no result recorded').slice(0, 160) })
  }
  return { at, attempted: completed + failures.length, completed, skipped, failures, skippedFor }
}

/**
 * What a beat leaves behind for the next one: the cross-side summary it just
 * read, marked read. If the next beat still finds it 'awaited', the cross-side
 * repair did not report in between, and pnlReconcileHeartbeat says so instead
 * of carrying an old ok forward.
 */
export function pnlCrossSideAwaited(crossSide, at) {
  const lastReportedAt = crossSide?.state === 'reported' ? (crossSide.at ?? null) : (crossSide?.lastReportedAt ?? null)
  return { state: 'awaited', since: at ?? null, lastReportedAt }
}

export function pnlReconciliationState(db, { accountId = null, overdueMin = 15 } = {}) {
  try {
    const scope = accountId == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'
    const args = accountId == null ? [] : [String(accountId)]
    const row = db.prepare(`
      SELECT COUNT(*) AS unresolved,
             MIN(closed_at) AS oldest,
             MAX(COALESCE(pnl_attempts, 0)) AS maxAttempts,
             SUM(CASE WHEN COALESCE(pnl_attempts, 0) = 0 THEN 1 ELSE 0 END) AS neverTried,
             SUM(CASE WHEN COALESCE(pnl_attempts, 0) = 0
                       AND closed_at IS NOT NULL
                       AND datetime(REPLACE(closed_at, 'T', ' ')) < datetime('now', ?)
                      THEN 1 ELSE 0 END) AS neverTriedOverdue
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NULL
         AND COALESCE(pnl_unresolvable, 0) = 0 ${scope}
    `).get(`-${Math.max(0, Number(overdueMin) || 0)} minutes`, ...args) || {}
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
      // …and a row nobody has tried for longer than the repair's own cadence
      // is the failure the heartbeat exists to show. A row closed seconds ago
      // is not (the paced pass may simply not have reached it yet), which is
      // why the heartbeat keys on THIS count and not on `neverTried`.
      neverTriedOverdue: Number(row.neverTriedOverdue) || 0,
    }
  } catch {
    return { unresolved: -1, oldestClosedAt: null, maxAttempts: 0, neverTried: 0, neverTriedOverdue: 0, error: true }
  }
}
