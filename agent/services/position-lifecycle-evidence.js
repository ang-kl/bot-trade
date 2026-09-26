// ---------------------------------------------------------------------------
// agent/services/position-lifecycle-evidence.js — what the broker's complete
// position history says about one position on one account, as a VERDICT
// with its reason (V3 B2, P5b-2).
//
// WHY. The per-position reader (old-position-pnl.js) settles unpriced rows
// from ProtoOADealListByPositionIdReq, but everything it learned that did not
// end in money was thrown away: a history of rejected deals, an opening the
// broker no longer retains, a position still open at the broker. And three
// populations were never read at all:
//   - closed rows WITH money and no broker receipt: pnl-backfill fetches deals
//     only while a row is owed money, an exit price or a repair, so a bot
//     close that stamped its own money never gets a receipt (104 positions on
//     25-09, and the number grows with every close);
//   - positions whose recorded money differs from the retained receipts;
//   - rows with no account, which no account's pass could claim.
//
// WHAT THIS WRITES. Verdict rows (position_lifecycle_evidence) and broker
// receipts (broker_deals, the same shaper and upsert as every other path).
// NEVER money: a NULL row is filled only by the strict writer (pnl-backfill
// via the old-position reader); a disagreeing or fragment row waits for the
// owner's decision (B5). Never a status change, never an account attribution
// (the report names the one account that holds a no-account row; writing it is
// the owner's), never a deletion.
//
// LOAD. The sweep shares the old reader's pacing: one position-history read
// per account per 30 s across BOTH readers, each position at most once per
// 15 minutes, a final verdict never re-read, inside the account pass's own
// 10 s budget and 5 s read deadline. A reply after the deadline writes
// nothing.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { normPosId } from '../lib/pos-id.js'
import {
  verifiedPositionHistory, executedDeal, dealStatusName, notExecutedDeal, dealStatusSummary, ownPositionDeal,
  FALSE_CLOSE_TOLERANCE_MS, POSITION_HISTORY_REFUSED,
} from '../lib/position-deal-history.js'
import { closeDealMoney } from '../lib/deal-money.js'

export const EVIDENCE_PACE_MS = 30_000
export const EVIDENCE_RETRY_MS = 15 * 60_000
/**
 * THE RULES A VERDICT WAS JUDGED UNDER (B2 checker N3). A final verdict is
 * final only under the rules that produced it: every row stores this version,
 * and a final verdict stored under an older one is read ONCE more (at the
 * usual 15-minute spacing) when the rules change — e.g. when the owner answers
 * how a history with no deals, or a mixed rejected/executed one, is judged.
 * Bump it with any change to classifyPositionHistory's outcomes.
 */
export const EVIDENCE_RULES = 1
const BOUNDED_DEALS = 500
const MONEY_TOLERANCE = 0.01

/**
 * Every verdict, and whether it is FINAL (never re-read: nothing the broker
 * can still do changes it). A non-final verdict is re-read at most once per
 * 15 minutes; `unreadable` is not a verdict about the position at all.
 */
export const VERDICTS = Object.freeze({
  agrees: { final: true, meaning: 'complete lifecycle; the ledger row carries the broker lifecycle money' },
  filled: { final: true, meaning: 'complete lifecycle; the strict writer filled the unpriced row from it on this read' },
  fragment_resolved: { final: true, meaning: 'complete lifecycle; earlier false-close record(s) rejected with evidence and the true row filled' },
  money_disagrees: { final: true, meaning: 'complete lifecycle; the one ledger row carries money that differs from the broker (owner decision, B5)' },
  money_bearing_fragment: { final: true, meaning: 'complete lifecycle; the money sits on a fragment (two priced rows, or a row closed while the broker held the position) (owner decision, B5)' },
  unpriced: { final: false, meaning: 'complete lifecycle; the ledger row is still unpriced — the strict writer owns it' },
  ledger_row_open: { final: false, meaning: 'complete lifecycle closed at the broker; the ledger still holds the row open' },
  no_ledger_row: { final: true, meaning: 'complete lifecycle at the broker on this account; no ledger row on this account holds the position' },
  open_at_broker: { final: false, meaning: 'the broker still holds (part of) the position' },
  empty_at_broker: { final: true, meaning: 'complete answer with no deal: the broker holds nothing for this position on this account' },
  never_filled: { final: true, meaning: 'every deal the broker holds for the position was rejected, internally rejected, errored or missed' },
  opening_not_retained: { final: true, meaning: 'the broker returns closing deal(s) without the opening deal: the start of the lifecycle is not retained' },
  permanently_unsupported: { final: true, meaning: 'the broker answer cannot be settled by any rule here (a paged answer or more than 500 deals, an unsupported status, invalid deal identity or money)' },
  unreadable: { final: false, meaning: 'no complete answer (error, timeout, another account, no hasMore:false and no deals): nothing is known; retried, never an attempt' },
})
const FINAL = new Set(Object.entries(VERDICTS).filter(([, v]) => v.final).map(([k]) => k))

const r2 = v => Math.round(v * 100) / 100
const ledgerMs = v => {
  if (v == null || v === '') return NaN
  const raw = String(v).replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`)
}
const SIDE = { 1: 'BUY', 2: 'SELL', BUY: 'BUY', SELL: 'SELL' }

/**
 * The ledger's rows for one account + position, every status (rejected twins
 * are evidence too). `accountId` null reads the rows with no account.
 */
export function ledgerRowsFor(db, accountId, positionId) {
  const pid = normPosId(positionId)
  if (!/^[1-9]\d*$/.test(pid || '')) return []
  const acct = accountId == null ? 'account_id IS NULL' : 'account_id = ?'
  return db.prepare(`SELECT id, account_id, status, net_pnl, opened_at, closed_at, symbol, side, COALESCE(pnl_unresolvable, 0) AS written_off
      FROM trades WHERE ${acct} AND ctrader_position_id IN (?, ?) ORDER BY id LIMIT 12`)
    .all(...(accountId == null ? [] : [String(accountId)]), pid, `${pid}.0`)
}

/**
 * PURE. Classify one broker answer for one position on one account against
 * the ledger's rows for it. Never throws. `persistable` says the deals were
 * validated and may be kept as receipts.
 */
export function classifyPositionHistory(response, { accountId, positionId, now = Date.now(), ledgerRows = [] } = {}) {
  const pid = String(positionId), acct = String(accountId)
  const out = (verdict, reason, extra = {}) => ({ verdict, final: FINAL.has(verdict), reason, deals: null, executed: null, broker: null,
    symbolId: null, openingSide: null, openedMs: null, finalCloseMs: null, persistable: false, ...extra })
  if (!response || typeof response !== 'object') return out('unreadable', 'no response')
  if (String(response.ctidTraderAccountId) !== acct) return out('unreadable', `response names account ${response.ctidTraderAccountId ?? '(none)'}, not ${acct}`)
  if (response.error || response.errorCode) return out('unreadable', `broker error ${response.errorCode ?? ''} ${response.description ?? ''}`.trim())
  if (response.deal != null && !Array.isArray(response.deal)) return out('unreadable', 'deal list malformed')
  // A PAGED ANSWER IS THE BOUNDED RESPONSE EXCEEDED (B2 checker N4). The
  // by-position read asks for the whole history (fromTimestamp 0) and reads
  // ONE response; the broker pages rather than return more than it will at
  // once, so `hasMore: true` with deals is how "more than one bounded
  // response" actually arrives — the >500 check below cannot see it. A
  // position's deals never shrink, so the next read pages the same way:
  // final, under these rules (a reader that follows pages bumps
  // EVIDENCE_RULES). An answer without hasMore:false and without deals says
  // nothing: unreadable.
  if (response.hasMore === true && Array.isArray(response.deal) && response.deal.length) {
    return out('permanently_unsupported', `the broker paged the history of position ${pid} (hasMore after ${response.deal.length} deal(s)): more than one bounded response, and this reader reads one`,
      { deals: response.deal.length, executed: response.deal.filter(executedDeal).length })
  }
  if (response.hasMore !== false) return out('unreadable', `response not complete (hasMore ${String(response.hasMore)})`)
  const deals = response.deal ?? []
  const counts = { deals: deals.length, executed: deals.filter(executedDeal).length }
  if (deals.length === 0) return out('empty_at_broker', `the broker's complete answer holds no deal for position ${pid} on account ${acct}`, counts)
  if (deals.length > BOUNDED_DEALS) return out('permanently_unsupported', `${deals.length} deals exceed the bounded response of ${BOUNDED_DEALS}`, counts)
  const unknown = deals.filter(d => dealStatusName(d) == null)
  if (unknown.length) return out('permanently_unsupported', `deal status unsupported: ${dealStatusSummary(unknown)}`, counts)
  // Every deal must be THIS position's, with a deal id, before its statuses
  // say anything about the position (B2 checker N5): a rejected deal of
  // another position is not evidence that this one never filled.
  const foreign = deals.filter(d => !ownPositionDeal(d, pid))
  if (foreign.length) {
    return out('permanently_unsupported', `position deal evidence invalid: ${foreign.length} deal(s) without a deal id or naming a position other than ${pid}`, counts)
  }
  if (deals.every(notExecutedDeal)) {
    return out('never_filled', `the broker holds ${deals.length} deal(s) for position ${pid} on account ${acct} and none executed: ${dealStatusSummary(deals)}`, counts)
  }
  if (deals.some(notExecutedDeal)) {
    // The money path (verifiedPositionHistory) refuses a lifecycle with a
    // non-executed deal in it; this verdict says so instead of retrying it.
    return out('permanently_unsupported', `non-executed deal(s) beside executed ones (${dealStatusSummary(deals)}); the settling reader refuses them`, counts)
  }
  const executed = deals.filter(executedDeal)
  const opening = executed.filter(d => !d.closePositionDetail)
    .sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp) || Number(a.dealId) - Number(b.dealId))
  if (!opening.length) {
    return out('opening_not_retained', `the broker returns ${executed.length} closing deal(s) for position ${pid} and no opening deal`, counts)
  }
  let verified
  try {
    verified = verifiedPositionHistory(response, { accountId: acct, positionId: pid, now })
  } catch (error) {
    if (error?.code !== POSITION_HISTORY_REFUSED) return out('unreadable', error?.message || String(error), counts)
    if (error.openAtBroker === true) return out('open_at_broker', error.message, { ...counts, persistable: true })
    if (error.neverFilled === true) return out('never_filled', error.message, counts)
    if (/opening history incomplete/.test(error.message)) {
      return out('opening_not_retained', `closing volume exceeds the opening volume the broker returns for position ${pid}: ${error.message}`, counts)
    }
    return out('permanently_unsupported', error.message, counts)
  }
  // A complete, balanced, validated lifecycle.
  let gross = 0, swap = 0, commission = 0, net = 0
  for (const d of verified.deals) {
    if (!d.closePositionDetail) continue
    const m = closeDealMoney(d.closePositionDetail)
    if (!m) return out('permanently_unsupported', `closing deal ${d.dealId} money unreadable`, counts)
    gross += m.gross; swap += m.swap; commission += m.commission; net += m.net
  }
  const broker = { net: r2(net), gross: r2(gross), swap: r2(swap), commission: r2(commission), conversionFee: verified.lifecycle?.conversionFee ?? null }
  const finalCloseMs = verified.lifecycle?.finalCloseMs ?? null
  const base = { ...counts, broker, symbolId: String(opening[0].symbolId), openingSide: SIDE[opening[0].tradeSide] ?? null,
    openedMs: Number(opening[0].executionTimestamp), finalCloseMs, persistable: true }
  const holders = ledgerRows.filter(r => !['rejected', 'cancelled'].includes(r.status))
  const twins = ledgerRows.filter(r => ['rejected', 'cancelled'].includes(r.status)).map(r => `#${r.id}:${r.status}`)
  const twinText = twins.length ? `; ${twins.join(',')} on the same position` : ''
  if (!holders.length) return out('no_ledger_row', `broker lifecycle net ${broker.net}; no ledger row on account ${acct} holds position ${pid}${twinText}`, base)
  const notClosed = holders.filter(r => r.status !== 'closed')
  if (notClosed.length) return out('ledger_row_open', `the broker closed position ${pid} at ${new Date(finalCloseMs).toISOString()}; the ledger holds ${notClosed.map(r => `#${r.id}:${r.status}`).join(',')}`, base)
  const priced = holders.filter(r => r.net_pnl != null)
  if (!priced.length) return out('unpriced', `broker lifecycle net ${broker.net}; ${holders.map(r => `#${r.id}`).join(',')} unpriced — the strict writer's to fill${twinText}`, base)
  const ledgerNet = r2(priced.reduce((s, r) => s + Number(r.net_pnl), 0))
  const same = Math.abs(ledgerNet - broker.net) <= MONEY_TOLERANCE + 1e-9
  if (priced.length >= 2) {
    return out('money_bearing_fragment', `${priced.length} priced rows (${priced.map(r => `#${r.id} ${r.net_pnl}`).join(', ')}) hold one broker position; broker lifecycle net ${broker.net}${twinText}`, base)
  }
  const [row] = priced
  const closedMs = ledgerMs(row.closed_at)
  if (Number.isFinite(finalCloseMs) && Number.isFinite(closedMs) && closedMs < finalCloseMs - FALSE_CLOSE_TOLERANCE_MS) {
    return out('money_bearing_fragment', `#${row.id} (net ${row.net_pnl}) was recorded closed ${new Date(closedMs).toISOString()}, before the broker's final close ${new Date(finalCloseMs).toISOString()}; broker lifecycle net ${broker.net}${twinText}`, base)
  }
  if (same) return out('agrees', `#${row.id} net ${row.net_pnl} equals the broker lifecycle net ${broker.net}${holders.length > 1 ? `; unpriced peer(s) ${holders.filter(r => r !== row).map(r => `#${r.id}`).join(',')} left to the strict writer` : ''}`, base)
  if (holders.length > 1) {
    return out('money_bearing_fragment', `#${row.id} net ${row.net_pnl} against the broker lifecycle net ${broker.net}, beside unpriced peer(s) ${holders.filter(r => r !== row).map(r => `#${r.id}`).join(',')}`, base)
  }
  return out('money_disagrees', `#${row.id} net ${row.net_pnl} against the broker lifecycle net ${broker.net} (delta ${r2(Number(row.net_pnl) - broker.net)})${twinText}`, base)
}

/**
 * Upsert one verdict. An `unreadable` read never overwrites a verdict already
 * on record: it only stamps last_error (and creates the row when none exists,
 * so the 15-minute retry spacing is durable). Returns the stored verdict.
 */
export function recordLifecycleEvidence(db, { accountId, positionId, host = null, classified, source, now = Date.now(), ledgerRows = [], tradeIds = null }) {
  const acct = String(accountId), pid = normPosId(positionId)
  const at = new Date(now).toISOString()
  const existing = db.prepare('SELECT verdict FROM position_lifecycle_evidence WHERE account_id = ? AND position_id = ?').get(acct, pid)
  if (classified.verdict === 'unreadable' && existing && existing.verdict !== 'unreadable') {
    db.prepare(`UPDATE position_lifecycle_evidence SET last_error = ?, last_error_at = ?, reads = reads + 1 WHERE account_id = ? AND position_id = ?`)
      .run(String(classified.reason).slice(0, 500), at, acct, pid)
    return existing.verdict
  }
  const holders = ledgerRows.filter(r => !['rejected', 'cancelled'].includes(r.status) && r.net_pnl != null)
  const ledgerNet = holders.length ? r2(holders.reduce((s, r) => s + Number(r.net_pnl), 0)) : null
  const rows = JSON.stringify(ledgerRows.slice(0, 8).map(r => ({ id: r.id, status: r.status, net: r.net_pnl ?? null, writtenOff: Number(r.written_off) === 1 })))
  const b = classified.broker
  const unreadable = classified.verdict === 'unreadable'
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, host, verdict, final, rules, reason, source, deals, executed,
      symbol_id, opening_side, opened_ms, final_close_ms, broker_net, broker_gross, broker_swap, broker_commission, conversion_fee, ledger_net,
      ledger_rows, trade_ids, read_at, reads, last_error, last_error_at)
    VALUES (@acct, @pid, @host, @verdict, @final, @rules, @reason, @source, @deals, @executed, @symbolId, @side, @openedMs, @closeMs, @net, @gross,
      @swap, @commission, @fee, @ledgerNet, @rows, @tradeIds, @at, 1, @err, @errAt)
    ON CONFLICT(account_id, position_id) DO UPDATE SET host = excluded.host, verdict = excluded.verdict, final = excluded.final, rules = excluded.rules,
      reason = excluded.reason, source = excluded.source, deals = excluded.deals, executed = excluded.executed, symbol_id = excluded.symbol_id,
      opening_side = excluded.opening_side, opened_ms = excluded.opened_ms, final_close_ms = excluded.final_close_ms,
      broker_net = excluded.broker_net, broker_gross = excluded.broker_gross, broker_swap = excluded.broker_swap,
      broker_commission = excluded.broker_commission, conversion_fee = excluded.conversion_fee, ledger_net = excluded.ledger_net,
      ledger_rows = excluded.ledger_rows, trade_ids = COALESCE(excluded.trade_ids, position_lifecycle_evidence.trade_ids),
      read_at = excluded.read_at, reads = position_lifecycle_evidence.reads + 1,
      last_error = excluded.last_error, last_error_at = excluded.last_error_at`)
    .run({ acct, pid, host, verdict: classified.verdict, final: classified.final ? 1 : 0, rules: EVIDENCE_RULES, reason: String(classified.reason ?? '').slice(0, 900),
      source, deals: classified.deals, executed: classified.executed, symbolId: classified.symbolId, side: classified.openingSide,
      openedMs: classified.openedMs, closeMs: classified.finalCloseMs, net: b?.net ?? null, gross: b?.gross ?? null, swap: b?.swap ?? null,
      commission: b?.commission ?? null, fee: b?.conversionFee ?? null, ledgerNet, rows,
      tradeIds: tradeIds == null ? null : JSON.stringify(tradeIds.slice(0, 12)), at,
      err: unreadable ? String(classified.reason).slice(0, 500) : null, errAt: unreadable ? at : null })
  return classified.verdict
}

/**
 * Keep the validated deals as broker receipts (the one shaper and upsert).
 * Like the other API deal writers since V3 L2b W10 (pnl-backfill, position
 * capture), the symbol names carry the broker's own declared lot size from
 * the registry (withBrokerLotSizes), so the receipt stores its lots — never a
 * guessed divisor; an undeclared symbol stays NULL. persistDeals keeps every
 * field an earlier read knew (keepKnownDealFields), so this read never blanks
 * one.
 */
async function persistReceipts(db, response, accountId) {
  const [{ shapeDeals, persistDeals }, { getAccountSymbolMap }, { withBrokerLotSizes }] = await Promise.all([
    import('./broker-history-import.js'), import('../lib/ctrader-creds.js'), import('../lib/lot-size-registry.js')])
  const symMeta = {}
  try { for (const [name, id] of Object.entries(getAccountSymbolMap(db, accountId)?.map ?? {})) symMeta[id] = { symbolName: name } } catch { /* receipt without a name */ }
  const shaped = shapeDeals((response.deal ?? []).filter(executedDeal), withBrokerLotSizes(db, symMeta), accountId)
  return shaped.length ? persistDeals(db, shaped) : { seen: 0 }
}

/**
 * The old-position reader's own read, turned into a verdict (the account
 * pass taps its getPositionDeals). Classified AFTER the reader wrote, so a
 * row it filled reads as the lifecycle it now carries: `filled`, or
 * `fragment_resolved` when the read also rejected false-close records.
 * A failed or late read records nothing but last_error on an existing row.
 */
export function recordReaderEvidence(db, { accountId, host = null, capture, outcome, now = Date.now(), isCurrent = () => true }) {
  if (!capture || !outcome?.positionId || normPosId(capture.positionId) !== normPosId(outcome.positionId)) return null
  if (!isCurrent() || /deadline elapsed/.test(capture.error?.message || '')) return null
  const ledgerRows = ledgerRowsFor(db, accountId, capture.positionId)
  const classified = capture.error
    ? { verdict: 'unreadable', final: false, reason: capture.error.message || String(capture.error) }
    : classifyPositionHistory(capture.response, { accountId, positionId: capture.positionId, now, ledgerRows })
  if (outcome.state === 'recovered' && classified.verdict === 'agrees') {
    const falseCloses = outcome.result?.falseCloses ?? []
    classified.verdict = falseCloses.length ? 'fragment_resolved' : 'filled'
    classified.final = true
    classified.reason = `${classified.reason}; filled on this read${falseCloses.length ? ` after rejecting false close(s) ${falseCloses.map(id => `#${id}`).join(',')}` : ''}`
  }
  return recordLifecycleEvidence(db, { accountId, positionId: capture.positionId, host, classified, source: 'old_position_reader', now, ledgerRows,
    tradeIds: outcome.tradeId != null ? [Number(outcome.tradeId)] : null })
}

// ---------------------------------------------------------------------------
// THE SWEEP. Three candidate classes, served in rotation so none starves
// another, each position at most once per 15 minutes and a final verdict
// never again:
//   receipt    — closed rows with money and no broker receipt on file;
//   differs    — positions whose recorded money differs from their receipts;
//   no_account — rows with no account, probed on THIS account (every enabled
//                account's pass probes, demo and live, so both hosts are
//                covered; the report names the one account that holds it, or
//                "no enabled account holds it").
// Unpriced rows are not here: they belong to the old-position reader, whose
// reads the account pass records as verdicts too.
// ---------------------------------------------------------------------------
export const SWEEP_CLASSES = Object.freeze(['receipt', 'differs', 'no_account'])
/**
 * The rows with no account that are probed — and exactly the rows the
 * reconciliation report lists (ledger-reconciliation.js), so the report's
 * `probing` means a probe is still due, never "for ever" (B2 checker N9).
 * Every status but rejected/cancelled: an open row with no account is a stuck
 * record too, and the probe names the account that holds (or closed) it.
 * Alias `t`. The sweep additionally needs a position id; the report lists a
 * row without one as `no_position_id`.
 */
export const NO_ACCOUNT_PROBED_SQL = "t.account_id IS NULL AND t.status NOT IN ('rejected','cancelled')"
const PID_SQL = col => `CAST(CAST(${col} AS INTEGER) AS TEXT)`
// A final verdict counts as final only under the current rules (N3).
const NOT_RECENT = pidExpr => `NOT EXISTS (SELECT 1 FROM position_lifecycle_evidence e WHERE e.account_id = @acct AND e.position_id = ${pidExpr}
      AND ((e.final = 1 AND e.rules = @rules) OR MAX(julianday(e.read_at), COALESCE(julianday(e.last_error_at), 0)) > julianday(@since)))`

/** The next position of one class for this account, or null. */
export function sweepCandidate(db, accountId, cls, { now = Date.now() } = {}) {
  const params = { acct: String(accountId), since: new Date(now - EVIDENCE_RETRY_MS).toISOString(), rules: EVIDENCE_RULES }
  if (cls === 'receipt') {
    return db.prepare(`SELECT t.id, ${PID_SQL('t.ctrader_position_id')} AS pid FROM trades t
      WHERE t.account_id = @acct AND t.status = 'closed' AND t.net_pnl IS NOT NULL AND CAST(t.ctrader_position_id AS INTEGER) > 0
        AND NOT EXISTS (SELECT 1 FROM broker_deals b WHERE b.account_id = @acct AND b.position_id = ${PID_SQL('t.ctrader_position_id')})
        AND ${NOT_RECENT(PID_SQL('t.ctrader_position_id'))}
      ORDER BY t.id DESC LIMIT 1`).get(params) ?? null
  }
  if (cls === 'differs') {
    return db.prepare(`WITH l AS (SELECT ${PID_SQL('ctrader_position_id')} AS pid, MIN(id) AS id, ROUND(SUM(net_pnl), 2) AS ledger FROM trades
        WHERE account_id = @acct AND status = 'closed' AND net_pnl IS NOT NULL AND CAST(ctrader_position_id AS INTEGER) > 0 GROUP BY 1),
      b AS (SELECT position_id AS pid, ROUND(SUM(net_pnl), 2) AS broker FROM broker_deals WHERE account_id = @acct AND net_pnl IS NOT NULL GROUP BY 1)
      SELECT l.id, l.pid FROM l JOIN b ON b.pid = l.pid
      WHERE ABS(l.ledger - b.broker) > ${MONEY_TOLERANCE + 0.001} AND ${NOT_RECENT('l.pid')}
      ORDER BY l.id DESC LIMIT 1`).get(params) ?? null
  }
  if (cls === 'no_account') {
    return db.prepare(`SELECT t.id, ${PID_SQL('t.ctrader_position_id')} AS pid FROM trades t
      WHERE ${NO_ACCOUNT_PROBED_SQL} AND CAST(t.ctrader_position_id AS INTEGER) > 0
        AND ${NOT_RECENT(PID_SQL('t.ctrader_position_id'))}
      ORDER BY t.id LIMIT 1`).get(params) ?? null
  }
  return null
}

function readCursor(db, key) {
  try { const v = JSON.parse(getState(db, key) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const recentRead = (cursor, now) => Number.isSafeInteger(cursor.lastReadAt) && cursor.lastReadAt <= now && now - cursor.lastReadAt < EVIDENCE_PACE_MS
/**
 * Has the sweep read a position history on this account in the last 30 s?
 * The old-position reader asks before it reads (B2 checker N1), so the shared
 * pacing holds in BOTH directions: one position-history read per account per
 * 30 s across the two readers, whatever the pass cadence.
 */
export function sweepReadRecently(db, accountId, now = Date.now()) {
  return recentRead(readCursor(db, `position_lifecycle_sweep:${String(accountId)}`), now)
}

/**
 * One sweep step for one account: at most one position-history read, and
 * only when neither this sweep nor the old-position reader has read on this
 * account in the last 30 s. `getPositionDeals(positionId)` is the pass's
 * bounded reader (its 5 s deadline, its lock).
 */
export async function sweepLifecycleEvidence(db, creds, { now = Date.now(), isCurrent = () => true, getPositionDeals } = {}) {
  const accountId = String(creds?.accountId), host = creds?.host ?? null
  if (!/^[1-9]\d*$/.test(accountId) || typeof getPositionDeals !== 'function') return { state: 'unavailable' }
  const key = `position_lifecycle_sweep:${accountId}`
  const cursor = readCursor(db, key)
  if (recentRead(cursor, now) || recentRead(readCursor(db, `position_pnl_recovery:${accountId}`), now)) return { state: 'paced' }
  const start = Number.isSafeInteger(cursor.next) ? cursor.next % SWEEP_CLASSES.length : 0
  let picked = null, cls = null, idx = -1
  for (let k = 0; k < SWEEP_CLASSES.length && !picked; k++) {
    idx = (start + k) % SWEEP_CLASSES.length
    cls = SWEEP_CLASSES[idx]
    picked = sweepCandidate(db, accountId, cls, { now })
  }
  if (!picked) return { state: 'no_candidate' }
  if (!isCurrent()) return { state: 'deadline' }
  const positionId = String(picked.pid)
  // The pacing cursor is written BEFORE the read, so a read that hangs or
  // fails still spaces the next one; it is pacing, not evidence.
  setState(db, key, JSON.stringify({ lastReadAt: now, next: (idx + 1) % SWEEP_CLASSES.length, class: cls, positionId, tradeId: picked.id }))
  let response, error = null
  try { response = await getPositionDeals(positionId) } catch (e) { error = e }
  // A late reply writes nothing (the pass's deadline): not a verdict, not a
  // receipt, not even last_error.
  if (!isCurrent() || /deadline elapsed/.test(error?.message || '')) return { state: 'deadline', class: cls, positionId }
  const ledgerRows = ledgerRowsFor(db, accountId, positionId)
  const noAccountRows = cls === 'no_account' ? ledgerRowsFor(db, null, positionId) : []
  const classified = error
    ? { verdict: 'unreadable', final: false, reason: error.message || String(error) }
    : classifyPositionHistory(response, { accountId, positionId, now, ledgerRows })
  let receipts = null
  if (classified.persistable) {
    try { receipts = (await persistReceipts(db, response, accountId))?.seen ?? 0 } catch (e) { receipts = `skipped: ${e.message}` }
  }
  const verdict = recordLifecycleEvidence(db, { accountId, positionId, host, classified, now, ledgerRows,
    source: cls === 'no_account' ? 'no_account_probe' : `evidence_sweep:${cls}`,
    tradeIds: cls === 'no_account' ? noAccountRows.map(r => Number(r.id)) : ledgerRows.map(r => Number(r.id)) })
  const out = { state: 'read', class: cls, positionId, tradeId: picked.id, verdict, ...(receipts != null ? { receipts } : {}) }
  setState(db, key, JSON.stringify({ lastReadAt: now, next: (idx + 1) % SWEEP_CLASSES.length, ...out, completedAt: Date.now() }))
  return out
}
