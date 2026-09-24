import { marketIdentity } from '../lib/market-identity.js'

const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0
const integer = x => Number.isSafeInteger(x) && x > 0
const id = x => (typeof x === 'string' && /^[1-9]\d*$/.test(x)) || integer(x) ? String(x) : null
const side = x => x === 1 || x === 'BUY' ? 'BUY' : x === 2 || x === 'SELL' ? 'SELL' : null
const within = (stamp, { nowMs, maxAgeMs }) => integer(stamp) && integer(nowMs)
  && positive(maxAgeMs) && stamp <= nowMs && nowMs - stamp <= maxAgeMs
function scope(raw, context) {
  const identity = marketIdentity(context?.identity)
  return identity && id(context.positionId) && id(raw?.ctidTraderAccountId) === identity.accountId ? identity : null
}

// Only call for a newly completed, bounded RECONCILE request. nowMs is local
// receipt time, not an invented broker event timestamp. Cached sidecar status
// is not an equivalent input to this decoder.
export function partialPositionEvidence(raw, context) {
  const identity = scope(raw, context)
  if (!identity || !integer(context.nowMs) || !Array.isArray(raw.position)) return null
  const rows = raw.position.filter(p => id(p.positionId) === context.positionId)
  if (rows.length !== 1) return null
  const p = rows[0], td = p.tradeData
  if (![1, 'POSITION_STATUS_OPEN'].includes(p.positionStatus) || id(td?.symbolId) !== identity.symbolId
    || !side(td?.tradeSide) || !integer(td?.volume) || !positive(p.price)
    || !positive(p.stopLoss) || !positive(p.takeProfit)) return null
  return { ...identity, positionId: context.positionId, side: side(td.tradeSide), entry: p.price,
    volume: td.volume, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
    observedAtMs: context.nowMs, source: 'broker_reconcile' }
}

// cTrader's initial spot event may be an old market-close quote. Both sides
// must come from this timestamped event; local receipt never refreshes its age.
export function partialQuoteEvidence(raw, context) {
  const identity = scope(raw, context)
  if (!identity || id(raw.symbolId) !== identity.symbolId || !within(raw.timestamp, context)
    || !integer(raw.bid) || !integer(raw.ask) || raw.ask < raw.bid) return null
  return { ...identity, positionId: context.positionId, bid: raw.bid / 100000, ask: raw.ask / 100000,
    observedAtMs: raw.timestamp, receivedAtMs: context.nowMs, source: 'broker_spot' }
}

export function partialClosingEvidence(raw, context) {
  const identity = scope(raw, context), d = raw?.deal, close = d?.closePositionDetail
  if (!identity || raw.alreadyClosed || ![3, 'ORDER_FILLED'].includes(raw.executionType)
    || !id(d?.dealId) || !id(d?.orderId) || id(d.positionId) !== context.positionId
    || id(d.symbolId) !== identity.symbolId || ![2, 'FILLED'].includes(d.dealStatus)
    || !['BUY', 'SELL'].includes(context.side) || side(d.tradeSide) !== (context.side === 'BUY' ? 'SELL' : 'BUY')
    || !integer(context.closeVolume) || d.filledVolume !== context.closeVolume || d.volume !== context.closeVolume
    || !positive(d.executionPrice) || close?.closedVolume !== context.closeVolume || close.entryPrice !== context.entry
    || !integer(context.attemptedAtMs) || !integer(d.executionTimestamp)
    || d.executionTimestamp < context.attemptedAtMs || d.executionTimestamp > context.nowMs) return null
  return { ...identity, positionId: context.positionId, dealId: id(d.dealId), orderId: id(d.orderId),
    closedVolume: d.filledVolume, price: d.executionPrice, executedAtMs: d.executionTimestamp }
}
