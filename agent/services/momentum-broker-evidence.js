import { marketIdentity } from '../lib/market-identity.js'
import { sidecarAttestsNotSent, preSubmitFailure, sidecarGuardRefused } from '../lib/exec-fallback.js'
import { sameTicks } from './momentum-target-policy.js'

const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0
const integer = x => Number.isSafeInteger(x) && x > 0
const id = x => (typeof x === 'string' && /^[1-9]\d*$/.test(x)) || integer(x) ? String(x) : null
const side = x => x === 1 || x === 'BUY' ? 'BUY' : x === 2 || x === 'SELL' ? 'SELL' : null
const opposite = s => s === 'BUY' ? 'SELL' : s === 'SELL' ? 'BUY' : null
// One freshness rule for a broker timestamp, shared with the timed quote so
// the listener waits for exactly the event this decoder will accept.
export const freshBrokerStamp = (stamp, { nowMs, maxAgeMs }) => integer(stamp) && integer(nowMs)
  && positive(maxAgeMs) && stamp <= nowMs && nowMs - stamp <= maxAgeMs
const within = freshBrokerStamp
function scope(raw, context) {
  const identity = marketIdentity(context?.identity)
  return identity && id(context.positionId) && id(raw?.ctidTraderAccountId) === identity.accountId ? identity : null
}

// T2 (V3 P0-1b). How long a close request may still execute at the broker
// after it was claimed: the gateway's own close wait (cpp-exec engine.cpp
// closePosition, 20 s), then the JS WebSocket fallback's close wait
// (exec-engine.js closePosition -> ctrader-ws.js wsClosePosition, 20 s), plus
// grace. No attempt is ever called NOT_EXECUTED inside this window, and the
// position read that proves it must be taken after it.
export const GATEWAY_CLOSE_WAIT_MS = 20_000
export const JS_FALLBACK_CLOSE_WAIT_MS = 20_000
export const CLOSE_GRACE_MS = 10_000
export const TRANSPORT_HORIZON_MS = GATEWAY_CLOSE_WAIT_MS + JS_FALLBACK_CLOSE_WAIT_MS + CLOSE_GRACE_MS
// Broker deal timestamps and this process's clock are different clocks. A
// deal-history match accepts a closing deal stamped this much before the
// claim, and no more.
export const MAX_CLOCK_SKEW_MS = 2_000

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

/** T2. The same bounded RECONCILE read, answering only "is this position
 * there, and with what volume". Absence is proven by the account's own
 * complete position list with no row for the id; a present row need not
 * carry protection. ProtoJSON omits an empty repeated field, so the
 * account's own answer with no `position` field and no error is its empty
 * list (the rule cross-side-reconcile.js already applies): otherwise the
 * account's last position closing could never be proven absent. Anything
 * ambiguous (another account, an error, a list that is not a list, two rows,
 * another instrument, a closed status) proves nothing and returns null. */
export function partialPositionPresence(raw, context) {
  const identity = scope(raw, context)
  if (!identity || !integer(context.nowMs) || raw.error || raw.errorCode) return null
  const list = raw.position == null ? [] : raw.position
  if (!Array.isArray(list)) return null
  const rows = list.filter(p => id(p?.positionId) === context.positionId)
  const base = { ...identity, positionId: context.positionId, observedAtMs: context.nowMs, source: 'broker_reconcile' }
  if (rows.length === 0) return { ...base, absent: true }
  if (rows.length !== 1) return null
  const p = rows[0], td = p.tradeData
  if (![1, 'POSITION_STATUS_OPEN'].includes(p.positionStatus) || id(td?.symbolId) !== identity.symbolId
    || !side(td?.tradeSide) || !integer(td?.volume) || !positive(p.price)) return null
  return { ...base, absent: false, side: side(td.tradeSide), entry: p.price, volume: td.volume,
    stopLoss: positive(p.stopLoss) ? p.stopLoss : null, takeProfit: positive(p.takeProfit) ? p.takeProfit : null }
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

// The closing deal's entry price is the position's fill; the plan's entry is
// the same grid price written by another producer, so the two are compared
// in ticks at the plan's digits (T1 left this comparison to T2). Without the
// digits no price can be compared, and no receipt is proven.
export function partialClosingEvidence(raw, context) {
  const identity = scope(raw, context), d = raw?.deal, close = d?.closePositionDetail
  if (!identity || raw.alreadyClosed || ![3, 'ORDER_FILLED'].includes(raw.executionType)
    || !id(d?.dealId) || !id(d?.orderId) || id(d.positionId) !== context.positionId
    || id(d.symbolId) !== identity.symbolId || ![2, 'FILLED'].includes(d.dealStatus)
    || !['BUY', 'SELL'].includes(context.side) || side(d.tradeSide) !== (context.side === 'BUY' ? 'SELL' : 'BUY')
    || !integer(context.closeVolume) || d.filledVolume !== context.closeVolume || d.volume !== context.closeVolume
    || !positive(d.executionPrice) || close?.closedVolume !== context.closeVolume
    || !sameTicks(close.entryPrice, context.entry, context.digits)
    || !integer(context.attemptedAtMs) || !integer(d.executionTimestamp)
    || d.executionTimestamp < context.attemptedAtMs || d.executionTimestamp > context.nowMs) return null
  return { ...identity, positionId: context.positionId, dealId: id(d.dealId), orderId: id(d.orderId),
    closedVolume: d.filledVolume, price: d.executionPrice, executedAtMs: d.executionTimestamp }
}

/** T2. The gateway answers a close with the FIRST execution event carrying
 * its request id, and for a market close that can be ORDER_ACCEPTED: an
 * order and no deal, with the ORDER_FILLED that follows dropped as a late
 * frame (cpp-exec engine.cpp dispatchFrame). This decodes that answer to the
 * one fact it proves: the broker's order id for this close. Fields the
 * payload carries are checked; the fill is proven only from deal history. */
export function partialAcceptedEvidence(raw, context) {
  const identity = scope(raw, context), o = raw?.order
  if (!identity || raw.alreadyClosed || ![2, 'ORDER_ACCEPTED'].includes(raw.executionType) || !id(o?.orderId)) return null
  if (id(o.positionId ?? raw.position?.positionId) !== context.positionId) return null
  const td = o.tradeData
  if (td != null && ((td.symbolId != null && id(td.symbolId) !== identity.symbolId)
    || (td.volume != null && td.volume !== context.closeVolume)
    || (td.tradeSide != null && side(td.tradeSide) !== opposite(context.side)))) return null
  return { ...identity, positionId: context.positionId, orderId: id(o.orderId), orderAccepted: true, acceptedAtMs: context.nowMs }
}

/** T2. A position's own deal history (DEAL_LIST_BY_POSITION_ID_RES), for
 * this account and position only. A page that says hasMore, or does not say
 * it is complete, proves nothing. Deals of another position are ignored; the
 * closing deals of this one are listed as the broker reported them, and
 * matching decides what they prove. */
export function partialDealHistoryEvidence(raw, context) {
  const identity = scope(raw, context)
  if (!identity || !integer(context.nowMs) || raw.hasMore !== false || raw.error || raw.errorCode
    || (raw.deal != null && !Array.isArray(raw.deal))) return null
  const closing = []
  for (const d of raw.deal ?? []) {
    if (id(d?.positionId) !== context.positionId || !d.closePositionDetail) continue
    const c = d.closePositionDetail
    closing.push({ dealId: id(d.dealId), orderId: id(d.orderId), symbolId: id(d.symbolId), side: side(d.tradeSide),
      filled: [2, 'FILLED'].includes(d.dealStatus), volume: d.volume, filledVolume: d.filledVolume,
      closedVolume: c.closedVolume, entryPrice: c.entryPrice, price: d.executionPrice,
      executedAtMs: Number.isSafeInteger(d.executionTimestamp) ? d.executionTimestamp : null })
  }
  return { ...identity, positionId: context.positionId, closing, observedAtMs: context.nowMs, source: 'broker_deal_history' }
}

/** T2. The one closing deal an attempt produced: the attempt's own broker
 * order id, this position and instrument, the opposite side, the plan's entry
 * in ticks, exactly the attempted volume, and a timestamp no earlier than the
 * claim less the clock skew. Exactly one deal must qualify; two is not a
 * receipt. Without an order id nothing is attributed to the attempt. */
export function matchClosingDeal(history, { orderId, side: positionSide, entry, digits, closeVolume, attemptedAtMs, nowMs }) {
  if (!history || !Array.isArray(history.closing) || !id(orderId) || !integer(closeVolume)
    || !integer(attemptedAtMs) || !integer(nowMs)) return { count: 0, receipt: null }
  const want = opposite(positionSide)
  const qualifying = history.closing.filter(d => d.orderId === String(orderId) && d.dealId
    && d.symbolId === history.symbolId && d.side === want && d.filled
    && d.volume === closeVolume && d.filledVolume === closeVolume && d.closedVolume === closeVolume
    && sameTicks(d.entryPrice, entry, digits) && positive(d.price) && integer(d.executedAtMs)
    && d.executedAtMs >= attemptedAtMs - MAX_CLOCK_SKEW_MS && d.executedAtMs <= nowMs + MAX_CLOCK_SKEW_MS)
  if (qualifying.length !== 1) return { count: qualifying.length, receipt: null }
  const d = qualifying[0]
  return { count: 1, receipt: { accountId: history.accountId, positionId: history.positionId, dealId: d.dealId,
    orderId: d.orderId, closedVolume: d.closedVolume, price: d.price, executedAtMs: d.executedAtMs, source: 'deal_history' } }
}

/** Closing deals on the position at or after the claim (less the skew). A
 * deal whose time cannot be read is counted: it might be after. */
export function closingDealsSince(history, attemptedAtMs) {
  if (!history || !Array.isArray(history.closing)) return []
  return history.closing.filter(d => d.executedAtMs == null || !integer(attemptedAtMs)
    || d.executedAtMs >= attemptedAtMs - MAX_CLOCK_SKEW_MS)
}

// The gateway's own error codes (cpp-exec engine.cpp errResult). A reply
// carrying one of these is not the broker's answer about the close.
const TRANSPORT_CODES = new Set(['TIMEOUT', 'DISCONNECTED', 'SEND_FAILED', 'rate_limited', 'too_many_in_flight', 'NOT_CONNECTED'])
// Broker errors that answer the session, not the order: the request was
// refused at authorization and never reached execution.
const AUTH_CODE = /^(CH_|OA_AUTH|INVALID_TOKEN|ALREADY_LOGGED_IN)|NOT_AUTHORIZED|ACCESS_TOKEN|NOT_AUTHENTICATED/

/** T2. What a failed close request proves.
 * - not_sent: nothing reached the broker (the adapter's own pre-transport
 *   refusal, the gateway's NOT_CONNECTED or guard refusal, no connection) or
 *   the broker refused the session rather than the order;
 * - already_closed: the broker had no such position when the close arrived;
 * - rejected: the broker answered this close with an error code, so it did
 *   not execute (MARKET_CLOSED, TRADING_BAD_VOLUME, ...);
 * - ambiguous: everything else, above all a timeout: the close may have
 *   executed with its answer lost. */
export function classifyCloseFailure(error) {
  if (!error) return { kind: 'ambiguous', code: null }
  if (error.notSent === true) return { kind: 'not_sent', code: 'pre_transport' }
  if (sidecarAttestsNotSent(error)) return { kind: 'not_sent', code: 'NOT_CONNECTED' }
  if (sidecarGuardRefused(error)) return { kind: 'not_sent', code: 'guard' }
  if (preSubmitFailure(error)) return { kind: 'not_sent', code: String(error.cause?.code || error.code) }
  const message = String(error.message || '')
  const code = /"errorCode"\s*:\s*"([A-Za-z0-9_]+)"/.exec(message)?.[1]
    ?? /^cTrader (?:order rejected|error): ([A-Za-z0-9_]+)/.exec(message)?.[1] ?? null
  if (code && TRANSPORT_CODES.has(code)) return { kind: 'ambiguous', code }
  // The broker's own wording, however the gateway framed it (the code, or the
  // plain "POSITION_NOT_FOUND: position <id> unknown" line callers match on).
  if (code === 'POSITION_NOT_FOUND' || /POSITION_NOT_FOUND|Position not found/.test(message)) return { kind: 'already_closed', code: 'POSITION_NOT_FOUND' }
  if (!code || code === 'unknown') return { kind: 'ambiguous', code }
  if (AUTH_CODE.test(code)) return { kind: 'not_sent', code }
  return { kind: 'rejected', code }
}
