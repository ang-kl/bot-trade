import { marketIdentityKey } from '../lib/market-identity.js'
import { orderStatusName } from '../lib/order-answer.js'
import { partialPositionEvidence } from './momentum-broker-evidence.js'
import { sameTicks, planMomentumTargets } from './momentum-target-policy.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'

const id = x => (typeof x === 'string' && /^[1-9]\d*$/.test(x)) || (Number.isSafeInteger(x) && x > 0) ? String(x) : null
const positiveInt = x => Number.isSafeInteger(x) && x > 0
const side = x => x === 1 || x === 'BUY' ? 'BUY' : x === 2 || x === 'SELL' ? 'SELL' : null

export function exactBrokerVolume(lots, lotSize) {
  if (!Number.isFinite(lots) || !positiveInt(lotSize)) return null
  const units = lots * lotSize, rounded = Math.round(units)
  return positiveInt(rounded) && Math.abs(units - rounded) <= rounded * 1e-12 ? rounded : null
}

// A terminal status alone cannot tell a partial entry from a position later
// reduced manually. All opening deals must explain exactly the remaining
// position, and a newly requested reconcile must follow the terminal reply.
// These are read-only broker responses, never cached status or local expiry.
export function finalMomentumLimitEvidence(input, { proposal, intent, trade, position, nowMs, maxAgeMs }) {
  const p = proposal?.plan, identity = proposal?.identity
  const d = input?.details, o = d?.order, td = o?.tradeData
  const received = input?.detailsReceivedAtMs, started = input?.reconcileStartedAtMs
  const observed = position?.observedAtMs, orderId = id(intent?.broker_order_id)
  const created = Date.parse(intent?.created_at)
  const status = orderStatusName(o?.orderStatus)
  if (proposal?.evidence?.orderType !== 'LIMIT' || intent?.state !== 'FILLED'
    || intent.order_type !== 'LIMIT' || !orderId || intent.id !== trade?.intent_id
    || String(intent.account_id) !== identity?.accountId || String(trade.account_id) !== identity.accountId
    || String(intent.symbol_id) !== identity.symbolId || intent.symbol !== trade.symbol || intent.side !== p?.side
    || intent.risk_event_id !== trade.risk_event_id || id(intent.broker_position_id) !== position?.positionId
    || marketIdentityKey(identity) !== marketIdentityKey(position)
    || d?.error || d?.errorCode || d?.hasMore === true || id(d?.ctidTraderAccountId) !== identity.accountId
    || id(o?.orderId) !== orderId || ![2, 'LIMIT'].includes(o?.orderType) || o?.closingOrder === true
    || (o?.positionId != null && id(o.positionId) !== position.positionId)
    || !['CANCELLED', 'EXPIRED'].includes(status) || id(td?.symbolId) !== identity.symbolId
    || side(td?.tradeSide) !== p.side || td?.volume !== p.volume || intent.volume !== p.volume
    || !positiveInt(o?.executedVolume) || o.executedVolume >= p.volume || o.executedVolume !== position.volume
    || exactBrokerVolume(trade.volume, proposal.evidence.symbolMeta.lotSize) !== position.volume
    || ![received, started, observed, nowMs, created].every(positiveInt)
    || received < created || started < received || observed < started
    || observed > nowMs || nowMs - received > maxAgeMs || nowMs - observed > maxAgeMs) return null

  const snapshot = input?.reconcile
  if (snapshot?.error || snapshot?.errorCode || snapshot?.hasMore === true
    || id(snapshot?.ctidTraderAccountId) !== identity.accountId
    || (snapshot.order != null && !Array.isArray(snapshot.order))) return null
  const orders = snapshot.order ?? [] // ProtoJSON omits an empty repeated field.
  if (orders.some(row => !id(row?.orderId) || id(row.orderId) === orderId)) return null
  const fresh = partialPositionEvidence(snapshot, { identity, positionId: position.positionId, nowMs: observed })
  if (!fresh || ['volume', 'side', 'entry', 'stopLoss', 'takeProfit'].some(k => fresh[k] !== position[k])) return null

  if (!Array.isArray(d.deal) || !d.deal.length) return null
  const ids = new Set()
  let volume = 0, value = 0
  for (const deal of d.deal) {
    const dealId = id(deal?.dealId)
    if (!dealId || ids.has(dealId) || id(deal.orderId) !== orderId || id(deal.positionId) !== position.positionId
      || id(deal.symbolId) !== identity.symbolId || side(deal.tradeSide) !== p.side || deal.closePositionDetail != null
      || ![2, 3, 'FILLED', 'PARTIALLY_FILLED'].includes(deal.dealStatus)
      || !positiveInt(deal.filledVolume) || !positiveInt(deal.volume) || deal.filledVolume > deal.volume
      || !Number.isFinite(deal.executionPrice) || deal.executionPrice <= 0
      || !positiveInt(deal.executionTimestamp) || deal.executionTimestamp < created
      || deal.executionTimestamp > received) return null
    ids.add(dealId)
    volume += deal.filledVolume
    value += deal.filledVolume * deal.executionPrice
  }
  if (!Number.isSafeInteger(volume) || volume !== o.executedVolume || !sameTicks(value / volume, position.entry, p.digits)) return null
  return { ...identity, positionId: position.positionId, orderId, status,
    originalVolume: p.volume, filledVolume: volume, dealIds: [...ids],
    detailsReceivedAtMs: received, reconcileStartedAtMs: started, observedAtMs: observed,
    source: 'broker_order_details_then_reconcile' }
}

// The durable proof becomes usable only after the book's atomic enrollment.
// A bare broker bracket or BOUND intent must never release the reservation.
export function isFinalMomentumLimitFill(db, trade, intent, limit) {
  if (!trade || !intent || !limit || trade.status !== 'open' || limit.trade_id !== trade.id
    || trade.intent_id !== intent.id || limit.intent_id !== intent.id
    || String(trade.account_id) !== String(intent.account_id) || String(limit.account_id) !== String(intent.account_id)
    || trade.symbol !== intent.symbol || trade.side !== intent.side || trade.risk_event_id !== intent.risk_event_id
    || limit.risk_event_id !== intent.risk_event_id
    || id(trade.ctrader_position_id) !== id(intent.broker_position_id)
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_target_intents'").get()) return false
  const row = db.prepare("SELECT * FROM momentum_target_intents WHERE account_id=? AND trade_id=? AND state='ENROLLED'").get(intent.account_id, trade.id)
  if (!row || row.risk_event_id !== intent.risk_event_id || row.position_id !== id(intent.broker_position_id)) return false
  let receipt, plan, proposal
  try { receipt = JSON.parse(row.fill_json); plan = JSON.parse(row.plan_json); proposal = JSON.parse(limit.proposal_json) } catch { return false }
  const proof = receipt?.finalLimitFill
  if (proof?.source !== 'broker_order_details_then_reconcile' || proof.accountId !== String(intent.account_id)
    || proof.orderId !== id(intent.broker_order_id) || proof.positionId !== row.position_id
    || !['CANCELLED', 'EXPIRED'].includes(proof.status) || proof.originalVolume !== intent.volume
    || proof.filledVolume !== receipt.volume || proof.filledVolume !== plan?.volume || !plan?.ok
    || JSON.stringify(plan) !== JSON.stringify(planMomentumTargets(plan))
    || exactBrokerVolume(trade.volume, proposal?.evidence?.symbolMeta?.lotSize) !== proof.filledVolume) return false
  const owner = readPartialOwnership(db, String(intent.account_id), trade.id, row.position_id, plan.digits)
  if (!ownershipMatchesPlan(owner, { accountId: String(intent.account_id), tradeId: trade.id, positionId: row.position_id, plan })) return false
  if (plan.mode === 'partial_runner') {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='momentum_partial_plans' AND type='table'").get()) return false
    const enrolled = db.prepare('SELECT position_id,plan_json FROM momentum_partial_plans WHERE account_id=? AND trade_id=?').get(intent.account_id, trade.id)
    if (enrolled?.position_id !== row.position_id || enrolled.plan_json !== row.plan_json) return false
  }
  // A newer local working snapshot contradicts the final receipt. Retain it.
  const broker = db.prepare('SELECT status,last_seen FROM broker_orders WHERE order_id=? AND account_id=?').get(proof.orderId, proof.accountId)
  if (broker?.status === 'working') {
    const at = Date.parse(String(broker.last_seen).replace(' ', 'T') + (/Z|[+-]\d\d:\d\d$/.test(broker.last_seen) ? '' : 'Z'))
    if (!Number.isFinite(at) || at >= proof.observedAtMs) return false
  }
  return true
}
