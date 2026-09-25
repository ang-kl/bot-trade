import { createHash } from 'node:crypto'
import { marketIdentityKey } from '../lib/market-identity.js'
import { planMomentumTargets, shiftStopToFill, stopHeld, sameTicks } from './momentum-target-policy.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'
import { registerPartialPlan } from './momentum-partial-manager.js'

const json = value => { try { return JSON.parse(value) } catch { return null } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Lots name an integer broker volume. (v / lotSize) * lotSize can miss v by a
// few ulps — 1.49e-8 at FX lotSize 1e7 and 8.04 lots, past the old 1e-8
// tolerance — so the comparison is on the integer, and only float residue
// (a relative 1e-12, never a fractional unit) is accepted as that integer.
function brokerVolume(lots, lotSize) {
  if (!Number.isFinite(lots) || !Number.isSafeInteger(lotSize) || lotSize <= 0) return null
  const units = lots * lotSize, volume = Math.round(units)
  return Number.isSafeInteger(volume) && Math.abs(units - volume) <= volume * 1e-12 ? volume : null
}
function verified(proposal) {
  const p = proposal?.plan, calculated = planMomentumTargets(p)
  return proposal?.ok === true && proposal.executionAuthorized === false && calculated.ok && same(p, calculated)
    && proposal.evidenceId === hash(proposal.evidence)
    && same(p, proposal.evidence?.plan) && proposal.cost?.costReservePrice === p.costReservePrice
    && marketIdentityKey(proposal.identity) != null
    && marketIdentityKey(proposal.identity) === marketIdentityKey(proposal.evidence?.identity)
}
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS momentum_target_intents (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, risk_event_id INTEGER NOT NULL,
    proposal_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'PREPARED', position_id TEXT, plan_json TEXT, fill_json TEXT,
    PRIMARY KEY(account_id,trade_id)
  )`)
}
export function readMomentumEntry(db, accountId, tradeId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_target_intents'").get()) return null
  const row = db.prepare('SELECT * FROM momentum_target_intents WHERE account_id=? AND trade_id=?').get(accountId, tradeId)
  return row ? { ...row, proposal: json(row.proposal_json), plan: json(row.plan_json), fill: json(row.fill_json) } : null
}

/** Must share the transaction that creates the existing 'submitting' trade.
 * An exception must prevent submission; this is not best-effort analytics.
 */
export function recordMomentumEntry(db, { accountId, tradeId, proposal, nowMs }) {
  if (typeof accountId !== 'string' || proposal?.identity?.accountId !== accountId
    || !Number.isSafeInteger(tradeId) || tradeId <= 0) throw Error('entry identity required')
  if (!verified(proposal) || !Number.isSafeInteger(nowMs) || nowMs <= 0) throw Error('entry evidence invalid')
  const stamps = [proposal.evidence.quote.observedAtMs, proposal.evidence.quote.receivedAtMs,
    proposal.evidence.symbolMeta.receivedAtMs]
  if (proposal.evidence.conversion.source !== 'usd_identity') stamps.push(proposal.evidence.conversion.observedAtMs, proposal.evidence.conversion.receivedAtMs)
  if (stamps.some(stamp => !Number.isSafeInteger(stamp) || stamp > nowMs || nowMs - stamp > 5000)) throw Error('entry evidence must be fresh before submission')
  const t = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=?').get(tradeId, accountId)
  if (!t || t.status !== 'submitting' || t.ctrader_position_id != null || t.origin !== 'bot_market_dispatch'
    || !(t.risk_event_id > 0) || t.symbol !== proposal.evidence.symbol || t.side !== proposal.plan.side
    || t.entry_price !== proposal.plan.entry || t.sl_price !== proposal.plan.originalStop
    || t.tp_price !== proposal.plan.brokerTarget
    || brokerVolume(t.volume, proposal.evidence.symbolMeta.lotSize) !== proposal.plan.volume) throw Error('entry trade identity or bracket mismatch')
  schema(db)
  const previous = readMomentumEntry(db, accountId, tradeId)
  if (previous) {
    if (!same(previous.proposal, proposal) || previous.risk_event_id !== t.risk_event_id) throw Error('entry evidence already fixed')
    return previous
  }
  db.prepare('INSERT INTO momentum_target_intents(account_id,trade_id,risk_event_id,proposal_json,created_at_ms) VALUES(?,?,?,?,?)')
    .run(accountId, tradeId, t.risk_event_id, JSON.stringify(proposal), nowMs)
  return readMomentumEntry(db, accountId, tradeId)
}

/** A fresh confirmed position can bind the immutable plan; this does not
 * register a partial or claim book ownership. Atomic handover does that later.
 */
export function bindMomentumEntry(db, { accountId, tradeId, position, nowMs, maxAgeMs = 5000 }) {
  const intent = readMomentumEntry(db, accountId, tradeId), p = intent?.proposal?.plan
  if (!intent || !verified(intent.proposal)) throw Error('entry fill has no valid recorded proposal')
  const t = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=?').get(tradeId, accountId)
  if (!t || !['submitting', 'open'].includes(t.status) || t.origin !== 'bot_market_dispatch'
    || t.risk_event_id !== intent.risk_event_id || t.symbol !== intent.proposal.evidence.symbol || t.side !== p.side
    || (t.ctrader_position_id != null && String(t.ctrader_position_id) !== position?.positionId)) throw Error('entry fill lifecycle mismatch')
  if (marketIdentityKey(position) !== marketIdentityKey(intent.proposal.identity)
    || !/^[1-9]\d*$/.test(position?.positionId) || position.source !== 'broker_reconcile'
    || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(position.observedAtMs)
    || !(maxAgeMs > 0) || maxAgeMs > 10000 || position.observedAtMs < intent.created_at_ms
    || position.observedAtMs > nowMs || nowMs - position.observedAtMs > maxAgeMs
    || position.side !== p.side || position.volume !== p.volume
    || !Number.isFinite(position.entry) || position.entry <= 0) throw Error('entry fill evidence mismatch')
  // The stop moves with the fill in whole ticks, as the broker moves a
  // relative stop. The unrounded p.originalStop + shift (247.81000000000003
  // against the broker's 247.81) refused 5,057 of the P0 reviewer's 30,000
  // simulated slipped fills, and 252 of the 2,000 in
  // momentum-plan-arithmetic.test.js. Broker prices are then compared in
  // ticks at the plan's digits, never as floats.
  const stop = shiftStopToFill(p, position.entry)
  const plan = stop == null ? null : planMomentumTargets({ ...p, entry: position.entry, originalStop: stop })
  if (!plan?.ok || !stopHeld(p.side, position.stopLoss, plan.originalStop, p.digits)
    || !sameTicks(position.takeProfit, plan.brokerTarget, p.digits)) throw Error('entry fill bracket mismatch')
  if (intent.state === 'BOUND') {
    if (intent.position_id !== position.positionId || !same(intent.plan, plan)) throw Error('entry fill already bound differently')
    return intent
  }
  if (intent.state !== 'PREPARED') throw Error('entry fill state mismatch')
  const receipt = { ...intent.proposal.identity, positionId: position.positionId, side: position.side,
    entry: position.entry, volume: position.volume, stopLoss: position.stopLoss, takeProfit: position.takeProfit,
    observedAtMs: position.observedAtMs, source: position.source }
  db.prepare("UPDATE momentum_target_intents SET state='BOUND',position_id=?,plan_json=?,fill_json=? WHERE account_id=? AND trade_id=? AND state='PREPARED'")
    .run(position.positionId, JSON.stringify(plan), JSON.stringify(receipt), accountId, tradeId)
  return readMomentumEntry(db, accountId, tradeId)
}

/** Called inside the book-row/monitor-pause transaction. Old book entries
 * without a recorded target intent retain their existing handover contract.
 */
export function enrollMomentumBook(db, { accountId, tradeId, positionId }) {
  const intent = readMomentumEntry(db, accountId, tradeId)
  if (!intent) return null
  if (!db.inTransaction) throw Error('entry enrollment requires atomic book handover')
  if (intent.state !== 'BOUND' || intent.position_id !== positionId || !verified(intent.proposal)
    || !intent.plan?.ok || !same(intent.plan, planMomentumTargets(intent.plan))) throw Error('entry enrollment requires a bound plan')
  const trade = db.prepare('SELECT risk_event_id FROM trades WHERE id=? AND account_id=?').get(tradeId, accountId)
  if (trade?.risk_event_id !== intent.risk_event_id) throw Error('entry enrollment lifecycle mismatch')
  // The producer's rows are fill-anchored by its own float arithmetic
  // (loop.js anchorBracketToFill), so entry and initial risk match the bound
  // plan in ticks, not bit for bit.
  const owner = readPartialOwnership(db, accountId, tradeId, positionId, intent.plan.digits)
  if (!ownershipMatchesPlan(owner, { accountId, tradeId, positionId, plan: intent.plan })) throw Error('entry enrollment ownership mismatch')
  if (intent.plan.mode === 'partial_runner') {
    registerPartialPlan(db, { accountId, tradeId, positionId, plan: intent.plan,
      identity: intent.proposal.identity,
      evidenceId: hash({ proposal: intent.proposal.evidenceId, fill: intent.fill, plan: intent.plan }) })
  }
  const changed = db.prepare("UPDATE momentum_target_intents SET state='ENROLLED' WHERE account_id=? AND trade_id=? AND state='BOUND'")
    .run(accountId, tradeId)
  if (changed.changes !== 1) throw Error('entry enrollment state changed')
  return intent.plan.mode
}

// Small, bounded diagnostic over the write-ahead ledger. Reading it never
// creates tables, registers plans or grants execution permission.
export function momentumTargetStatus(db, { accountId, all = false, limit = 50 } = {}) {
  if (!all && (typeof accountId !== 'string' || !/^[1-9]\d*$/.test(accountId))) throw new RangeError('Select an account or request all accounts.')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Limit must be between 1 and 100.')
  const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const base = { accountId: all ? 'all' : accountId, executionAuthorized: false, runtimeIntegration: 'INCOMPLETE' }
  if (!has('momentum_target_intents')) return { ...base, recordedPlans: 0, rows: [], truncated: false }
  const where = all ? '' : 'WHERE i.account_id=?', params = all ? [] : [accountId]
  const recordedPlans = db.prepare(`SELECT count(*) n FROM momentum_target_intents i ${where}`).get(...params).n
  const partial = has('momentum_partial_plans')
  const rows = db.prepare(`SELECT i.*,t.status trade_status${partial ? ',p.state partial_state,p.reason partial_reason' : ''}
    FROM momentum_target_intents i LEFT JOIN trades t ON t.id=i.trade_id AND t.account_id=i.account_id
    ${partial ? 'LEFT JOIN momentum_partial_plans p ON p.account_id=i.account_id AND p.trade_id=i.trade_id' : ''}
    ${where} ORDER BY i.created_at_ms DESC,i.trade_id DESC LIMIT ?`).all(...params, limit)
  return { ...base, recordedPlans, truncated: recordedPlans > rows.length, rows: rows.map(r => {
    const proposal = json(r.proposal_json), plan = json(r.plan_json)
    let evidenceValid = false
    try { evidenceValid = !!verified(proposal) } catch { /* retain the damaged row as visible, invalid evidence */ }
    return { accountId: r.account_id, tradeId: r.trade_id, positionId: r.position_id,
      state: r.state, tradeStatus: r.trade_status, createdAtMs: r.created_at_ms,
      evidenceValid, evidenceId: evidenceValid ? proposal.evidenceId : null,
      mode: plan?.mode ?? proposal?.plan?.mode ?? null,
      partialState: r.partial_state ?? null, partialReason: r.partial_reason ?? null }
  }) }
}
