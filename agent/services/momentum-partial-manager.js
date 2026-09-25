import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { planMomentumTargets, sameTicks, stopHeld } from './momentum-target-policy.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'
import { classifyCloseFailure, matchClosingDeal, closingDealsSince, TRANSPORT_HORIZON_MS, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'

function validPlan(plan) {
  if (!plan || typeof plan !== 'object') return false
  const calculated = planMomentumTargets(plan)
  return calculated.ok && calculated.mode === 'partial_runner'
    && JSON.stringify(calculated) === JSON.stringify(plan)
}

function parse(value) {
  try { return JSON.parse(value) } catch { return null }
}

// T2 (V3 P0-1b): the broker order id of the attempt, the evidence a terminal
// state was decided on, and when. Added to tables created before T2.
const PARTIAL_COLUMNS = [['order_id', 'TEXT'], ['evidence_json', 'TEXT'], ['resolved_at', 'INTEGER']]
export function addMissingColumns(db, table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
  for (const [name, type] of columns) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS momentum_partial_plans (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, position_id TEXT NOT NULL,
    plan_json TEXT NOT NULL, evidence_id TEXT NOT NULL, identity_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ARMED', attempted_at INTEGER, quote_json TEXT,
    receipt_json TEXT, reason TEXT,
    PRIMARY KEY(account_id,trade_id), UNIQUE(account_id,position_id)
  )`)
  addMissingColumns(db, 'momentum_partial_plans', PARTIAL_COLUMNS)
}

/** Every state a partial plan can be in. The attempt's terminal outcomes are
 * REJECTED (the broker refused this close), NOT_EXECUTED (proven never
 * executed after the whole transport window), CLOSED_EXTERNALLY (the position
 * is gone, with its closing deal ids) and VOLUME_CHANGED (another close
 * changed the volume). None of them sends again; the runner's broker SL and
 * TP, and the rank exit, continue. */
export const PARTIAL_STATES = Object.freeze(['ARMED', 'SENDING', 'AMBIGUOUS', 'RECEIVED', 'CONFIRMED',
  'REJECTED', 'NOT_EXECUTED', 'CLOSED_EXTERNALLY', 'VOLUME_CHANGED',
  'RANK_RESERVED', 'RANK_SENDING', 'RANK_AMBIGUOUS', 'RANK_RECEIVED', 'RANK_CONFIRMED',
  'RANK_NOT_EXECUTED', 'RANK_CLOSED_EXTERNALLY', 'RANK_VOLUME_CHANGED'])

export function registerPartialPlan(db, { accountId, tradeId, positionId, plan, evidenceId, identity }) {
  if (typeof accountId !== 'string' || !accountId || ['all', '_all'].includes(accountId)
    || !Number.isSafeInteger(tradeId) || tradeId <= 0 || !/^[1-9]\d*$/.test(positionId)
    || typeof evidenceId !== 'string' || !evidenceId) throw Error('explicit plan identity and evidence required')
  const boundIdentity = marketIdentity(identity)
  if (!boundIdentity || boundIdentity.accountId !== accountId) throw Error('explicit broker identity required')
  if (!validPlan(plan)) throw Error('valid immutable partial plan required')
  schema(db)
  const serialized = JSON.stringify(plan)
  const prior = db.prepare('SELECT * FROM momentum_partial_plans WHERE account_id=? AND trade_id=?').get(accountId, tradeId)
  if (prior) {
    if (prior.position_id !== positionId || prior.plan_json !== serialized || prior.evidence_id !== evidenceId || marketIdentityKey(parse(prior.identity_json)) !== marketIdentityKey(boundIdentity)) throw Error('plan already registered with different evidence')
    return readPartialPlan(db, accountId, tradeId)
  }
  db.prepare('INSERT INTO momentum_partial_plans(account_id,trade_id,position_id,plan_json,evidence_id,identity_json) VALUES (?,?,?,?,?,?)')
    .run(accountId, tradeId, positionId, serialized, evidenceId, JSON.stringify(boundIdentity))
  return readPartialPlan(db, accountId, tradeId)
}

export function readPartialPlan(db, accountId, tradeId) {
  const row = db.prepare('SELECT * FROM momentum_partial_plans WHERE account_id=? AND trade_id=?').get(accountId, tradeId)
  return row ? { ...row, plan: parse(row.plan_json), identity: parse(row.identity_json),
    receipt: row.receipt_json ? parse(row.receipt_json) : null,
    evidence: row.evidence_json ? parse(row.evidence_json) : null } : null
}

// Deliberately dependency-bound: no credentials, broker implementation or live
// activation is inferred by this state machine. The runtime adapter must supply
// fresh account-owned reads and a decoded, filled closing-deal receipt.
export async function runPartialPlan(db, creds, tradeId, deps) {
  const accountId = String(creds?.accountId ?? '')
  const row = readPartialPlan(db, accountId, tradeId)
  if (!row) return { state: 'UNAVAILABLE', reason: 'plan_not_found' }
  if (!['ARMED', 'RECEIVED', 'SENDING', 'AMBIGUOUS'].includes(row.state)) return { state: row.state, reason: row.reason }
  if (!marketIdentity(row.identity) || row.identity.accountId !== accountId || row.identity.host !== creds.host) return { state: row.state, reason: 'stored_identity_mismatch' }
  if (!validPlan(row.plan)) return { state: row.state, reason: 'stored_plan_invalid' }
  addMissingColumns(db, 'momentum_partial_plans', PARTIAL_COLUMNS)
  // This reader is synchronous so its final check and the database claim have
  // no event-loop yield between them. The adapter reads the authoritative
  // trade, book and monitor rows; it cannot infer ownership from a symbol.
  const owned = () => {
    try {
      const o = deps.readOwnership ? deps.readOwnership(accountId, tradeId, row.position_id)
        : readPartialOwnership(db, accountId, tradeId, row.position_id, row.plan.digits)
      return ownershipMatchesPlan(o, { accountId, tradeId, positionId: row.position_id, plan: row.plan })
    } catch { return false }
  }
  // Ownership gates a send. Recovering an attempt, reading back a receipt and
  // recording that the position is gone only read the broker, so they run
  // even after the reconciler has closed the lifecycle rows (T2).
  const armedOwned = row.state === 'ARMED' ? owned() : true
  const p = row.plan, age = deps.maxAgeMs
  const now = Number.isFinite(deps.now?.()) ? deps.now() : NaN
  if (!Number.isFinite(now) || !Number.isFinite(age) || age <= 0) {
    return { state: row.state, reason: armedOwned ? 'freshness_policy_required' : 'lifecycle_ownership_unverified' }
  }
  const timeoutMs = deps.timeoutMs ?? 5000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) return { state: row.state, reason: 'request_budget_invalid' }
  const bounded = async work => {
    let timer
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('broker request deadline exceeded')), timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  const fresh = stamp => {
    const checkedAt = deps.now()
    return Number.isFinite(checkedAt) && Number.isFinite(stamp) && stamp <= checkedAt && checkedAt - stamp <= age
  }
  // Broker prices against the stored plan in ticks at its digits: a float a
  // few ulps beside a grid price is the same price, a tick away is not.
  const matches = bp => bp?.accountId === accountId && String(bp.positionId) === row.position_id
    && bp.side === p.side && sameTicks(bp.entry, p.entry, p.digits) && fresh(bp.observedAtMs)
    && stopHeld(p.side, bp.stopLoss, p.originalStop, p.digits)
    && sameTicks(bp.takeProfit, p.brokerTarget, p.digits)
  // What a fresh read proves on its own: this account's list has no such
  // position, or this lifecycle (side and entry) is present at a volume.
  const readFor = bp => bp?.accountId === accountId && String(bp.positionId) === row.position_id && fresh(bp.observedAtMs)
  const absent = bp => readFor(bp) && bp.absent === true
  const present = bp => readFor(bp) && bp.absent !== true && bp.side === p.side
    && sameTicks(bp.entry, p.entry, p.digits) && Number.isSafeInteger(bp.volume) && bp.volume > 0
  let attemptedAtMs = row.attempted_at
  const validReceipt = receipt => {
    // A deal-history receipt is stamped by the broker's clock: the bounded
    // skew applies to it. A live execution event is held to this attempt.
    const skew = receipt?.source === 'deal_history' ? MAX_CLOCK_SKEW_MS : 0
    return receipt?.accountId === accountId && String(receipt.positionId) === row.position_id
      && typeof receipt.dealId === 'string' && /^[1-9]\d*$/.test(receipt.dealId)
      && receipt.closedVolume === p.closeVolume && Number.isFinite(receipt.price) && receipt.price > 0
      && Number.isSafeInteger(attemptedAtMs) && Number.isSafeInteger(receipt.executedAtMs)
      && receipt.executedAtMs >= attemptedAtMs - skew && receipt.executedAtMs <= deps.now() + skew
  }
  const current = () => readPartialPlan(db, accountId, tradeId)
  const setState = (from, to, { reason = null, evidence = null, orderId = null } = {}) => db.prepare(`UPDATE momentum_partial_plans
      SET state=?,reason=?,evidence_json=COALESCE(?,evidence_json),order_id=COALESCE(?,order_id),resolved_at=?
      WHERE account_id=? AND trade_id=? AND state=? AND attempted_at IS ?`)
    .run(to, reason, evidence ? JSON.stringify(evidence) : null, orderId, deps.now(), accountId, tradeId, from, attemptedAtMs).changes === 1
  const readDeals = async () => {
    if (typeof deps.readClosingDeals !== 'function') return null
    try {
      const h = await bounded(() => deps.readClosingDeals(creds, row.position_id))
      return h?.accountId === accountId && String(h.positionId) === row.position_id && Array.isArray(h.closing) ? h : null
    } catch { return null }
  }
  const dealIds = list => list.map(d => d.dealId).filter(Boolean)
  // The position is gone or its volume changed, and deal history names the
  // closing deals. Terminal; a receipt already held is kept.
  const external = (from, to, bp, history, closing, reason) => {
    const evidence = { observedAtMs: bp.observedAtMs, absent: bp.absent === true,
      observedVolume: bp.absent === true ? 0 : bp.volume, closingDealIds: dealIds(closing),
      orderId: current()?.order_id ?? null, attemptedAtMs: attemptedAtMs ?? null, source: 'broker_reconcile+deal_history' }
    setState(from, to, { reason, evidence })
    const now = current()
    return { state: now.state, reason: now.reason }
  }
  const receive = receipt => {
    if (!validReceipt(receipt)) throw Error('unconfirmed closing deal')
    // This callback stays attached to the original request after our bounded
    // wait expires. A late, proven receipt may recover AMBIGUOUS; it never
    // causes another submission or guesses from a changed position size.
    const confirmedReceipt = { accountId, positionId: row.position_id, dealId: receipt.dealId,
      orderId: receipt.orderId ?? null, closedVolume: receipt.closedVolume, price: receipt.price,
      executedAtMs: receipt.executedAtMs, source: receipt.source ?? 'execution_event' }
    db.prepare(`UPDATE momentum_partial_plans SET state='RECEIVED',receipt_json=?,reason=NULL,order_id=COALESCE(?,order_id)
      WHERE account_id=? AND trade_id=? AND state IN ('SENDING','AMBIGUOUS','NOT_EXECUTED') AND attempted_at=?`)
      .run(JSON.stringify(confirmedReceipt), receipt.orderId ?? null, accountId, tradeId, attemptedAtMs)
    return receipt
  }
  const finish = async () => {
    let after
    try { after = await bounded(() => deps.readPosition(creds, row.position_id)) } catch { return { state: 'RECEIVED', reason: 'readback_unavailable' } }
    if (matches(after) && after.volume === p.runnerVolume) {
      db.prepare("UPDATE momentum_partial_plans SET state='CONFIRMED',reason=NULL,resolved_at=? WHERE account_id=? AND trade_id=? AND state='RECEIVED'")
        .run(deps.now(), accountId, tradeId)
      return { state: 'CONFIRMED' }
    }
    // The partial is proven, and then the rest of the position closed or
    // changed elsewhere (a stop, the runner target, a manual close). The
    // receipt stays; the record names the closing deals.
    const gone = absent(after), changed = present(after) && after.volume !== p.runnerVolume && after.volume !== p.volume
    if (gone || changed) {
      const history = await readDeals()
      if (!history) return { state: 'RECEIVED', reason: 'deal_history_unavailable' }
      if (gone && !history.closing.length) return { state: 'RECEIVED', reason: 'absence_without_closing_deal' }
      return external('RECEIVED', gone ? 'CLOSED_EXTERNALLY' : 'VOLUME_CHANGED', after, history, history.closing,
        gone ? 'position_closed_after_partial' : 'volume_changed_after_partial')
    }
    return { state: 'RECEIVED', reason: 'residual_not_confirmed' }
  }
  // An attempt whose request may not have ended (SENDING) or ended without a
  // proven fill (AMBIGUOUS). A closing deal with the attempt's own order id
  // proves it at any time; that nothing executed is proven only after the
  // whole transport window, by a volume read taken after that point.
  const resolveAttempt = async () => {
    const attempt = current()
    if (!['SENDING', 'AMBIGUOUS'].includes(attempt?.state)) return { state: attempt?.state, reason: attempt?.reason }
    if (!Number.isSafeInteger(attemptedAtMs)) return { state: attempt.state, reason: 'attempt_time_missing' }
    const history = await readDeals()
    if (!history) return { state: attempt.state, reason: 'deal_history_unavailable' }
    const orderId = attempt.order_id ?? null
    if (orderId) {
      const found = matchClosingDeal(history, { orderId, side: p.side, entry: p.entry, digits: p.digits,
        closeVolume: p.closeVolume, attemptedAtMs, nowMs: deps.now() })
      if (found.count > 1) return { state: attempt.state, reason: 'closing_deal_not_unique' }
      if (found.receipt) {
        try { receive(found.receipt) } catch { return { state: attempt.state, reason: 'closing_deal_unconfirmed' } }
        return current().state === 'RECEIVED' ? finish() : { state: current().state }
      }
    }
    const since = closingDealsSince(history, attemptedAtMs)
    if (orderId && since.some(d => d.orderId === orderId)) return { state: attempt.state, reason: 'order_deals_inexact' }
    let after
    try { after = await bounded(() => deps.readPosition(creds, row.position_id)) } catch { return { state: attempt.state, reason: 'position_read_unavailable' } }
    const pastHorizon = deps.now() - attemptedAtMs > TRANSPORT_HORIZON_MS && after?.observedAtMs > attemptedAtMs + TRANSPORT_HORIZON_MS
    // The position is gone: nothing is left for this attempt to execute on.
    // An accepted order's own deal is still waited for inside the window, in
    // case the history read ran ahead of the position read.
    if (absent(after)) {
      if (orderId && !pastHorizon) return { state: attempt.state, reason: 'awaiting_transport_horizon' }
      if (!history.closing.length) return { state: attempt.state, reason: 'absence_without_closing_deal' }
      return external(attempt.state, 'CLOSED_EXTERNALLY', after, history, history.closing, orderId
        ? 'position_closed_without_this_order' : 'position_closed_attribution_unproven')
    }
    if (!present(after)) return { state: attempt.state, reason: 'position_unverified' }
    if (!pastHorizon) return { state: attempt.state, reason: 'awaiting_transport_horizon' }
    if (after.volume === p.volume && since.length === 0) {
      // H-P0-3 default: an attempt proven never executed ends here. No
      // resend; the runner's broker SL and TP and the rank exit continue.
      setState(attempt.state, 'NOT_EXECUTED', { reason: 'no_closing_deal_after_transport_horizon',
        evidence: { observedAtMs: after.observedAtMs, observedVolume: after.volume, closingDealIds: [],
          orderId, attemptedAtMs, horizonMs: TRANSPORT_HORIZON_MS, source: 'broker_reconcile+deal_history' } })
      const now = current()
      return { state: now.state, reason: now.reason }
    }
    if (after.volume !== p.volume && since.length) {
      return external(attempt.state, 'VOLUME_CHANGED', after, history, since, orderId
        ? 'volume_changed_without_this_order' : 'volume_changed_attribution_unproven')
    }
    return { state: attempt.state, reason: 'closing_deal_unattributed' }
  }

  if (row.state === 'RECEIVED') return validReceipt(row.receipt) ? finish()
    : { state: 'RECEIVED', reason: 'stored_receipt_invalid' }
  if (row.state === 'SENDING' || row.state === 'AMBIGUOUS') return resolveAttempt()

  // ARMED.
  let before, quote
  try {
    before = await bounded(() => deps.readPosition(creds, row.position_id))
  } catch { return { state: 'ARMED', reason: armedOwned ? 'preflight_unavailable' : 'lifecycle_ownership_unverified' } }
  // Nothing was attempted, and the position closed or changed elsewhere:
  // record it with its closing deals rather than waiting on it forever.
  if (absent(before) || (present(before) && before.volume !== p.volume)) {
    const history = await readDeals()
    if (history?.closing.length) {
      return external('ARMED', absent(before) ? 'CLOSED_EXTERNALLY' : 'VOLUME_CHANGED', before, history, history.closing,
        absent(before) ? 'position_closed_before_partial' : 'volume_changed_before_partial')
    }
    return { state: 'ARMED', reason: armedOwned ? (history ? 'absence_without_closing_deal' : 'deal_history_unavailable') : 'lifecycle_ownership_unverified' }
  }
  if (!armedOwned) return { state: 'ARMED', reason: 'lifecycle_ownership_unverified' }
  try {
    quote = await bounded(() => deps.quote(creds, row.position_id))
  } catch { return { state: 'ARMED', reason: 'preflight_unavailable' } }
  if (!matches(before) || before.volume !== p.volume) return { state: 'ARMED', reason: 'broker_position_mismatch' }
  if (quote?.accountId !== accountId || String(quote?.positionId) !== row.position_id
    || !fresh(quote?.observedAtMs) || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)
    || !(quote.bid > 0) || !(quote.ask >= quote.bid)) return { state: 'ARMED', reason: 'fresh_quote_required' }
  const price = p.side === 'BUY' ? quote.bid : quote.ask
  if (p.side === 'BUY' ? price < p.trigger : price > p.trigger) return { state: 'ARMED', reason: 'trigger_not_reached' }
  // Credentials are read before the claim: a changed token refuses here and
  // the attempt is not used up (T2).
  try { deps.preflight?.(creds) } catch { return { state: 'ARMED', reason: 'credentials_changed' } }
  if (!owned()) return { state: 'ARMED', reason: 'lifecycle_ownership_unverified' }
  // Commit before the network call. SENDING is recovered from deal history,
  // never resent. Concurrent callers must win this compare-and-set to acquire
  // the one attempt.
  attemptedAtMs = deps.now()
  const claimed = db.prepare("UPDATE momentum_partial_plans SET state='SENDING',attempted_at=?,quote_json=?,order_id=NULL,reason=NULL WHERE account_id=? AND trade_id=? AND state='ARMED'")
    .run(attemptedAtMs, JSON.stringify({ bid: quote.bid, ask: quote.ask, observedAtMs: quote.observedAtMs }), accountId, tradeId)
  if (claimed.changes !== 1) return { state: readPartialPlan(db, accountId, tradeId).state }
  // The broker's order id for this close, from its acceptance. Stored on the
  // SENDING row so a later pass (or a later boot) can find its deal.
  const recordOrder = accepted => {
    if (accepted?.accountId !== accountId || String(accepted.positionId) !== row.position_id
      || typeof accepted.orderId !== 'string' || !/^[1-9]\d*$/.test(accepted.orderId)) throw Error('unconfirmed order acceptance')
    db.prepare(`UPDATE momentum_partial_plans SET order_id=? WHERE account_id=? AND trade_id=?
      AND state IN ('SENDING','AMBIGUOUS') AND attempted_at=? AND order_id IS NULL`).run(accepted.orderId, accountId, tradeId, attemptedAtMs)
    return 'accepted'
  }
  const absorb = out => out?.orderAccepted === true ? recordOrder(out)
    : out?.alreadyClosed === true ? 'already_closed' : (receive(out), 'received')
  let outcome
  try {
    outcome = await bounded(() => Promise.resolve(deps.close(creds,
      { positionId: row.position_id, volume: p.closeVolume }, { attemptedAtMs })).then(absorb))
  } catch (error) {
    const failure = classifyCloseFailure(error)
    if (failure.kind === 'not_sent') {
      // Nothing reached the broker: the attempt is not used up.
      db.prepare("UPDATE momentum_partial_plans SET state='ARMED',reason=? WHERE account_id=? AND trade_id=? AND state='SENDING' AND attempted_at=?")
        .run(`close_not_sent: ${failure.code}`, accountId, tradeId, attemptedAtMs)
      return { state: current().state, reason: 'close_not_sent' }
    }
    if (failure.kind === 'rejected') {
      setState('SENDING', 'REJECTED', { reason: `broker_rejected: ${failure.code}`,
        evidence: { code: failure.code, message: String(error.message).slice(0, 300), attemptedAtMs, source: 'broker_answer' } })
      return { state: current().state, reason: current().reason }
    }
    if (failure.kind === 'already_closed') outcome = 'already_closed'
    else {
      db.prepare("UPDATE momentum_partial_plans SET state='AMBIGUOUS',reason='closing_deal_unconfirmed' WHERE account_id=? AND trade_id=? AND state='SENDING'")
        .run(accountId, tradeId)
      return { state: readPartialPlan(db, accountId, tradeId).state, reason: 'closing_deal_unconfirmed' }
    }
  }
  if (outcome === 'already_closed') {
    // The broker had no such position: this close did not execute. What
    // happened to the position is proven by an absence read (T2).
    setState('SENDING', 'AMBIGUOUS', { reason: 'position_not_found_at_close' })
    return resolveAttempt()
  }
  if (outcome === 'accepted') return resolveAttempt()
  return finish()
}
