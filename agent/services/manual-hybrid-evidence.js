// Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
// Read-only proof of a contemporaneous opening-order bracket. A position's
// current/adopted SL, a strategy label and a guessed entry intent are not inputs.
import { marketIdentity } from '../lib/market-identity.js'
import { priceTicks, sameTicks } from './momentum-target-policy.js'
import { brokerPolicyObservation, brokerTrailing } from '../lib/stop-policy.js'

const MAX_RAW_BYTES = 64 * 1024
const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const integer = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9]\d*$/.test(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
const id = value => integer(value) == null ? null : String(integer(value))
const sideOf = value => value === 1 || value === 'BUY' ? 'BUY' : value === 2 || value === 'SELL' ? 'SELL' : null
const dealStatus = value => value === 2 || value === 'FILLED' ? 2
  : value === 3 || value === 'PARTIALLY_FILLED' ? 3 : null
const openingTypes = new Set([1, 2, 3, 5, 6, 'MARKET', 'LIMIT', 'STOP', 'MARKET_RANGE', 'STOP_LIMIT'])
const optionalFalse = value => value === undefined || value === false
const refuse = reason => ({ ok: false, reason })

function contextFacts(context) {
  const identity = marketIdentity(context?.identity)
  if (!identity || !id(identity.accountId) || !id(identity.symbolId) || !id(context?.positionId)
    || !['BUY', 'SELL'].includes(context.side) || !positive(context.entry)
    || !Number.isInteger(context.digits) || context.digits < 0 || context.digits > 5
    || !(priceTicks(context.entry, context.digits) > 0)
    || typeof context.volume !== 'number' || !integer(context.volume)
    || typeof context.nowMs !== 'number' || !integer(context.nowMs)) return null
  return { identity: { host: identity.host, accountId: identity.accountId, symbolId: identity.symbolId },
    positionId: id(context.positionId), side: context.side, entry: context.entry,
    volume: context.volume, digits: context.digits, nowMs: context.nowMs }
}

// The detached raw receipt survives later caller mutation and ring/cache
// pruning. These are broker payloads only; credentials are never accepted.
function receiptCopy(history, orderDetails, includeOrder) {
  try {
    const encoded = JSON.stringify(includeOrder ? { history, orderDetails } : { history }, (_key, value) => {
      // JSON would silently turn NaN/Infinity into null and hide a supplied
      // malformed bracket as an absent optional field. Preserve refusal.
      if ((typeof value === 'number' && !Number.isFinite(value))
        || ['bigint', 'function', 'symbol'].includes(typeof value)) throw Error('non_json_receipt')
      return value
    })
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RAW_BYTES) return refuse('manual_entry_receipt_too_large')
    return { ok: true, raw: JSON.parse(encoded) }
  } catch { return refuse('manual_entry_receipt_invalid') }
}

function openingDeals(deals, context) {
  if (!Array.isArray(deals) || !deals.length) return refuse('manual_opening_deals_missing')
  let total = 0, weighted = 0
  const seen = new Set(), orders = new Set(), normalized = []
  for (const d of deals) {
    if (!object(d) || id(d.positionId) !== context.positionId || id(d.symbolId) !== context.identity.symbolId
      || sideOf(d.tradeSide) !== context.side) return refuse('manual_opening_deal_identity_conflict')
    if (d.closePositionDetail != null) return refuse('manual_opening_history_has_close')
    const dealId = id(d.dealId), orderId = id(d.orderId), filled = integer(d.filledVolume), requested = integer(d.volume)
    const status = dealStatus(d.dealStatus), executedAt = integer(d.executionTimestamp)
    if (!dealId || !orderId || !filled || !requested || filled > requested || !status
      || !positive(d.executionPrice) || !(priceTicks(d.executionPrice, context.digits) > 0)
      || !executedAt || executedAt > context.nowMs
      || (d.createTimestamp != null && (!integer(d.createTimestamp) || integer(d.createTimestamp) > executedAt))) {
      return refuse('manual_opening_deal_unverified')
    }
    if (seen.has(dealId)) return refuse('manual_opening_deal_duplicate')
    seen.add(dealId); orders.add(orderId)
    total += filled
    weighted += filled * d.executionPrice
    if (!Number.isSafeInteger(total) || !Number.isFinite(weighted)) return refuse('manual_opening_volume_conflict')
    normalized.push({ dealId, orderId, volume: requested, filledVolume: filled,
      executionPrice: d.executionPrice, executionTimestamp: executedAt, dealStatus: status })
  }
  if (orders.size !== 1) return refuse('manual_opening_order_ambiguous')
  if (total !== context.volume) return refuse('manual_opening_volume_conflict')
  const entry = weighted / total
  if (!sameTicks(entry, context.entry, context.digits)) return refuse('manual_opening_entry_conflict')
  normalized.sort((a, b) => a.dealId.localeCompare(b.dealId, 'en'))
  return { ok: true, entryOrderId: [...orders][0], openingDealIds: normalized.map(d => d.dealId), normalized, entry }
}

function historyFacts(history, context) {
  if (!object(history) || history.error != null || history.errorCode != null
    || id(history.ctidTraderAccountId) !== context.identity.accountId) return refuse('manual_history_identity_unverified')
  if (history.hasMore !== false) return refuse('manual_history_incomplete')
  // This is the position-specific response. Foreign rows are contradictions,
  // not rows to filter out until a desired opening order appears to fit.
  return openingDeals(history.deal, context)
}

/** Identify the one order worth reading, without fetching or persisting it. */
export function manualOpeningOrderId(history, context) {
  const c = contextFacts(context)
  if (!c) return null
  const receipt = receiptCopy(history, null, false)
  if (!receipt.ok) return null
  const result = historyFacts(receipt.raw.history, c)
  return result.ok ? result.entryOrderId : null
}

/**
 * ProtoOAOrder (Spotware schema): FILLED=2; opening types 1/2/3/5/6;
 * type 4 is SL/TP. Optional false booleans may be omitted in ProtoJSON.
 * The complete matching opening deals independently exclude closes/adds.
 * relativeStopLoss is an ORDER distance in 1/100000 price units, BUY below /
 * SELL above its fill. The order's last update must be the final fill's exact
 * broker millisecond; historical order details alone do not prove immutability.
 * No first-observed position stop or guessed timestamp tolerance is used.
 */
export function manualOpeningProof(history, orderDetails, context) {
  const c = contextFacts(context)
  if (!c) return refuse('manual_context_unverified')
  const receipt = receiptCopy(history, orderDetails, true)
  if (!receipt.ok) return receipt
  const h = historyFacts(receipt.raw.history, c)
  if (!h.ok) return h
  const details = receipt.raw.orderDetails, order = details?.order, td = order?.tradeData
  if (!object(details) || details.error != null || details.errorCode != null
    || id(details.ctidTraderAccountId) !== c.identity.accountId
    || (details.hasMore != null && details.hasMore !== false)) return refuse('manual_order_details_unverified')
  if (!object(order) || !object(td) || id(order.orderId) !== h.entryOrderId || id(order.positionId) !== c.positionId
    || id(td.symbolId) !== c.identity.symbolId || sideOf(td.tradeSide) !== c.side) {
    return refuse('manual_opening_order_identity_conflict')
  }
  if (![2, 'ORDER_STATUS_FILLED'].includes(order.orderStatus) || !openingTypes.has(order.orderType)
    || !optionalFalse(order.closingOrder) || !optionalFalse(order.isStopOut)
    || brokerTrailing(order) === true || Object.values(brokerPolicyObservation(order)).some(value => value == null)) {
    return refuse('manual_opening_order_not_filled_entry')
  }
  if (integer(order.executedVolume) !== c.volume || !integer(td.volume) || integer(td.volume) < c.volume) {
    return refuse('manual_opening_order_volume_conflict')
  }
  if (!positive(order.executionPrice) || !sameTicks(order.executionPrice, h.entry, c.digits)) {
    return refuse('manual_opening_order_price_conflict')
  }
  const corroborated = openingDeals(details.deal, c)
  if (!corroborated.ok || corroborated.entryOrderId !== h.entryOrderId
    || JSON.stringify(corroborated.normalized) !== JSON.stringify(h.normalized)) {
    return refuse('manual_order_deals_conflict')
  }
  const finalFillAt = Math.max(...corroborated.normalized.map(deal => deal.executionTimestamp))
  if (integer(order.utcLastUpdateTimestamp) !== finalFillAt) {
    return refuse('manual_opening_bracket_time_unverified')
  }
  const hasRelative = order.relativeStopLoss != null, hasAbsolute = order.stopLoss != null
  if (!hasRelative && !hasAbsolute) return refuse('manual_original_stop_missing')
  const relative = hasRelative ? integer(order.relativeStopLoss) : null
  const direction = c.side === 'BUY' ? 1 : -1
  if ((hasRelative && !relative) || (hasAbsolute && (!positive(order.stopLoss)
    || direction * (c.entry - order.stopLoss) <= 0))) return refuse('manual_original_stop_invalid')
  const initialRisk = hasRelative ? relative / 100_000 : direction * (c.entry - order.stopLoss)
  const originalStop = hasRelative ? c.entry - direction * initialRisk : order.stopLoss
  if (!positive(initialRisk) || !positive(originalStop) || !(priceTicks(originalStop, c.digits) > 0)) {
    return refuse('manual_original_stop_invalid')
  }
  if (hasRelative && hasAbsolute && !sameTicks(originalStop, order.stopLoss, c.digits)) {
    return refuse('manual_original_stop_conflict')
  }
  return { ok: true, version: 1, source: 'broker_opening_order', identity: c.identity,
    positionId: c.positionId, side: c.side, entry: c.entry, initialRisk, originalStop, volume: c.volume,
    entryOrderId: h.entryOrderId, openingDealIds: h.openingDealIds, observedAtMs: c.nowMs, raw: receipt.raw }
}
