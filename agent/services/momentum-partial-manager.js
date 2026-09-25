import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { planMomentumTargets, sameTicks, stopHeld } from './momentum-target-policy.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'

function validPlan(plan) {
  if (!plan || typeof plan !== 'object') return false
  const calculated = planMomentumTargets(plan)
  return calculated.ok && calculated.mode === 'partial_runner'
    && JSON.stringify(calculated) === JSON.stringify(plan)
}

function parse(value) {
  try { return JSON.parse(value) } catch { return null }
}

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS momentum_partial_plans (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, position_id TEXT NOT NULL,
    plan_json TEXT NOT NULL, evidence_id TEXT NOT NULL, identity_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ARMED', attempted_at INTEGER, quote_json TEXT,
    receipt_json TEXT, reason TEXT,
    PRIMARY KEY(account_id,trade_id), UNIQUE(account_id,position_id)
  )`)
}

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
  return row ? { ...row, plan: parse(row.plan_json), identity: parse(row.identity_json), receipt: row.receipt_json ? parse(row.receipt_json) : null } : null
}

// Deliberately dependency-bound: no credentials, broker implementation or live
// activation is inferred by this state machine. The runtime adapter must supply
// fresh account-owned reads and a decoded, filled closing-deal receipt.
export async function runPartialPlan(db, creds, tradeId, deps) {
  const accountId = String(creds?.accountId ?? '')
  const row = readPartialPlan(db, accountId, tradeId)
  if (!row) return { state: 'UNAVAILABLE', reason: 'plan_not_found' }
  if (!['ARMED', 'RECEIVED'].includes(row.state)) return { state: row.state, reason: row.reason }
  if (!marketIdentity(row.identity) || row.identity.accountId !== accountId || row.identity.host !== creds.host) return { state: row.state, reason: 'stored_identity_mismatch' }
  if (!validPlan(row.plan)) return { state: row.state, reason: 'stored_plan_invalid' }
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
  if (!owned()) return { state: row.state, reason: 'lifecycle_ownership_unverified' }
  const p = row.plan, now = deps.now(), age = deps.maxAgeMs
  if (!Number.isFinite(now) || !Number.isFinite(age) || age <= 0) return { state: row.state, reason: 'freshness_policy_required' }
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
  let attemptedAtMs = row.attempted_at
  const validReceipt = receipt => receipt?.accountId === accountId && String(receipt.positionId) === row.position_id
    && typeof receipt.dealId === 'string' && /^[1-9]\d*$/.test(receipt.dealId)
    && receipt.closedVolume === p.closeVolume && Number.isFinite(receipt.price) && receipt.price > 0
    && Number.isSafeInteger(attemptedAtMs) && Number.isSafeInteger(receipt.executedAtMs)
    && receipt.executedAtMs >= attemptedAtMs && receipt.executedAtMs <= deps.now()
  const finish = async () => {
    try {
      const after = await bounded(() => deps.readPosition(creds, row.position_id))
      if (!matches(after) || after.volume !== p.runnerVolume) return { state: 'RECEIVED', reason: 'residual_not_confirmed' }
      db.prepare("UPDATE momentum_partial_plans SET state='CONFIRMED',reason=NULL WHERE account_id=? AND trade_id=? AND state='RECEIVED'")
        .run(accountId, tradeId)
      return { state: 'CONFIRMED' }
    } catch { return { state: 'RECEIVED', reason: 'readback_unavailable' } }
  }
  if (row.state === 'RECEIVED') return validReceipt(row.receipt) ? finish()
    : { state: 'RECEIVED', reason: 'stored_receipt_invalid' }
  let before, quote
  try {
    before = await bounded(() => deps.readPosition(creds, row.position_id))
    quote = await bounded(() => deps.quote(creds, row.position_id))
  } catch { return { state: 'ARMED', reason: 'preflight_unavailable' } }
  if (!matches(before) || before.volume !== p.volume) return { state: 'ARMED', reason: 'broker_position_mismatch' }
  if (quote?.accountId !== accountId || String(quote?.positionId) !== row.position_id
    || !fresh(quote?.observedAtMs) || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)
    || !(quote.bid > 0) || !(quote.ask >= quote.bid)) return { state: 'ARMED', reason: 'fresh_quote_required' }
  const price = p.side === 'BUY' ? quote.bid : quote.ask
  if (p.side === 'BUY' ? price < p.trigger : price > p.trigger) return { state: 'ARMED', reason: 'trigger_not_reached' }
  if (!owned()) return { state: 'ARMED', reason: 'lifecycle_ownership_unverified' }
  // Commit before the network call. SENDING left by a crash is never retried.
  // Concurrent callers must win this compare-and-set to acquire the one attempt.
  attemptedAtMs = deps.now()
  const claimed = db.prepare("UPDATE momentum_partial_plans SET state='SENDING',attempted_at=?,quote_json=? WHERE account_id=? AND trade_id=? AND state='ARMED'")
    .run(attemptedAtMs, JSON.stringify({ bid: quote.bid, ask: quote.ask, observedAtMs: quote.observedAtMs }), accountId, tradeId)
  if (claimed.changes !== 1) return { state: readPartialPlan(db, accountId, tradeId).state }
  const receive = receipt => {
    if (!validReceipt(receipt)) throw Error('unconfirmed closing deal')
    // This callback stays attached to the original request after our bounded
    // wait expires. A late, proven receipt may recover AMBIGUOUS; it never
    // causes another submission or guesses from a changed position size.
    const confirmedReceipt = { accountId, positionId: row.position_id, dealId: receipt.dealId,
      closedVolume: receipt.closedVolume, price: receipt.price, executedAtMs: receipt.executedAtMs }
    db.prepare("UPDATE momentum_partial_plans SET state='RECEIVED',receipt_json=?,reason=NULL WHERE account_id=? AND trade_id=? AND state IN ('SENDING','AMBIGUOUS') AND attempted_at=?")
      .run(JSON.stringify(confirmedReceipt), accountId, tradeId, attemptedAtMs)
    return receipt
  }
  try {
    await bounded(() => Promise.resolve(deps.close(creds,
      { positionId: row.position_id, volume: p.closeVolume }, { attemptedAtMs })).then(receive))
  } catch {
    db.prepare("UPDATE momentum_partial_plans SET state='AMBIGUOUS',reason='closing_deal_unconfirmed' WHERE account_id=? AND trade_id=? AND state='SENDING'")
      .run(accountId, tradeId)
    return { state: readPartialPlan(db, accountId, tradeId).state, reason: 'closing_deal_unconfirmed' }
  }
  return finish()
}
