// ---------------------------------------------------------------------------
// agent/lib/order-answer.js — what the broker's answer to an ENTRY order
// proves, per order type (V3 X1 / LIFECYCLE-SPEC W4, owner-approved
// 25-09-2026). Pure: no DB, no transport; exec-engine.settleIntent and
// entry-ledger.reconcileIntents read the same rule.
//
// THE DEFECT (found 25-09-2026 10:25 UTC). settleIntent wrote FILLED whenever
// the answer carried a position id. cTrader's ORDER_ACCEPTED carries one for a
// RESTING LIMIT / STOP too — the broker pre-creates the position record the
// order will fill into (fill-anchor.js records the same frame for market
// orders: "ORDER_ACCEPTED — which carries the position id and no deal"). So
// every resting limit was recorded FILLED at placement, filled or not. The
// CADJPY intent i7fgue8t2rgxx (pending_fib_orders) resolved FILLED from
// 'response' on 12-09 07:12, thirteen days before the order was cancelled
// unfilled; /state/order-lifecycle ORD-04 counted 25 such rows at 15:00 UTC
// on 25-09.
//
// THE RULE.
//   MARKET / MARKET_RANGE (enum 1 / 5, or no type — validateOrderBracket's
//   default): exactly as before — FILLED when the answer names a position,
//   ACCEPTED otherwise. A market order has nothing to rest on.
//   Every other entry type (LIMIT 2, STOP 3, STOP_LIMIT 6): FILLED only when
//   the answer says it filled — executionType ORDER_FILLED (3) or
//   ORDER_PARTIAL_FILL (11) — or carries a deal. Otherwise ACCEPTED with the
//   broker's order id: "the broker holds a resting order" (entry-ledger.js).
//   The position id on a resting acceptance is NOT recorded as the intent's
//   position: no position exists until the order fills.
// ---------------------------------------------------------------------------

const MARKET_TYPES = new Set(['MARKET', 'MARKET_RANGE', '1', '5'])
const FILL_EXECUTION = new Set(['ORDER_FILLED', 'ORDER_PARTIAL_FILL', '3', '11'])

/** True for an order that executes on arrival (or has no type, which the bracket guard reads as MARKET). */
export function isMarketOrderType(orderType) {
  if (orderType == null || orderType === '') return true
  return MARKET_TYPES.has(String(orderType).trim().toUpperCase())
}

/** executionType ORDER_FILLED / ORDER_PARTIAL_FILL, by name or ProtoOAExecutionType number. */
export function isFillExecution(executionType) {
  if (executionType == null || executionType === '') return false
  return FILL_EXECUTION.has(String(executionType).trim().toUpperCase())
}

/**
 * The intent verdict an order answer supports.
 * @returns {{ state: 'FILLED'|'ACCEPTED', positionId: (string|number|null), brokerOrderId: (string|number|null), basis: string }}
 */
export function entryAnswerVerdict(orderType, result) {
  const positionId = result?.position?.positionId ?? result?.deal?.positionId ?? null
  const brokerOrderId = result?.order?.orderId ?? null
  if (isMarketOrderType(orderType)) {
    // Unchanged from the pre-X1 settleIntent, byte for byte in effect.
    return positionId != null
      ? { state: 'FILLED', positionId, brokerOrderId, basis: 'market_position' }
      : { state: 'ACCEPTED', positionId: null, brokerOrderId, basis: 'market_no_position' }
  }
  const hasDeal = result?.deal != null && typeof result.deal === 'object'
  if (isFillExecution(result?.executionType) || hasDeal) {
    return { state: 'FILLED', positionId, brokerOrderId, basis: hasDeal ? 'resting_deal' : 'resting_fill_execution' }
  }
  return { state: 'ACCEPTED', positionId: null, brokerOrderId, basis: 'resting_accepted' }
}

// ProtoOAOrderStatus (OpenApiModelMessages.proto): ACCEPTED 1, FILLED 2,
// REJECTED 3, EXPIRED 4, CANCELLED 5 — by name or number.
const ORDER_STATUS = {
  1: 'ACCEPTED', 2: 'FILLED', 3: 'REJECTED', 4: 'EXPIRED', 5: 'CANCELLED',
  ORDER_STATUS_ACCEPTED: 'ACCEPTED', ORDER_STATUS_FILLED: 'FILLED', ORDER_STATUS_REJECTED: 'REJECTED',
  ORDER_STATUS_EXPIRED: 'EXPIRED', ORDER_STATUS_CANCELLED: 'CANCELLED',
}
export function orderStatusName(status) {
  if (status == null || status === '') return null
  return ORDER_STATUS[String(status).trim().toUpperCase()] ?? ORDER_STATUS[Number(status)] ?? null
}

// ProtoOADealStatus: FILLED 2, PARTIALLY_FILLED 3. An absent status (older
// shape) is not held against a deal, as in entry-ledger.js.
const DEAL_OK = new Set(['2', '3', 'FILLED', 'PARTIALLY_FILLED'])
const dealFilled = (d) => { const st = d?.dealStatus; return st == null || DEAL_OK.has(String(st).toUpperCase()) }

/**
 * The terminal state a ProtoOAOrderDetailsRes ({ order, deal[] }) proves for
 * an ACCEPTED intent, or null when the order is still working (or the answer
 * proves nothing). Any filled deal, an ORDER_STATUS_FILLED, or executed
 * volume means a position opened — a partial fill later cancelled or expired
 * is still FILLED (the position exists), with the partial named in the note.
 * @returns {null|{state:string, positionId:(string|null), brokerOrderId:(string|null), note:string}}
 */
export function orderDetailsVerdict(res) {
  const order = res?.order
  if (!order || typeof order !== 'object') return null
  const status = orderStatusName(order.orderStatus)
  const deals = (Array.isArray(res?.deal) ? res.deal : []).filter(d => d && typeof d === 'object' && dealFilled(d) && !d.closePositionDetail)
  const executed = Number(order.executedVolume)
  const oid = order.orderId != null ? String(order.orderId) : null
  const pid = deals.find(d => d.positionId != null)?.positionId ?? order.positionId ?? null
  if (deals.length || status === 'FILLED' || (Number.isFinite(executed) && executed > 0)) {
    const partial = status && status !== 'FILLED' ? `; partial fill (executed ${Number.isFinite(executed) ? executed : '?'}), then ${status.toLowerCase()}` : ''
    return { state: 'FILLED', positionId: pid != null ? String(pid) : null, brokerOrderId: oid, note: `order_details: ${status || 'fill'} with ${deals.length} deal(s)${partial}` }
  }
  if (status === 'CANCELLED') return { state: 'RELEASED', positionId: null, brokerOrderId: oid, note: 'order_cancelled: the broker reports the resting order cancelled, unfilled' }
  if (status === 'EXPIRED') return { state: 'EXPIRED', positionId: null, brokerOrderId: oid, note: 'order_expired: the broker reports the resting order expired, unfilled' }
  if (status === 'REJECTED') return { state: 'REJECTED', positionId: null, brokerOrderId: oid, note: 'order_rejected: the broker reports the resting order rejected, unfilled' }
  return null
}
