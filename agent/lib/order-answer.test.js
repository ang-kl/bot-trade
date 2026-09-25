// node --test agent/lib/order-answer.test.js
//
// V3 X1 (25-09-2026): what an entry order's answer proves, per order type.
// A resting LIMIT / STOP answered ORDER_ACCEPTED — which carries the broker's
// pre-created position id — is ACCEPTED, never FILLED; a market order settles
// exactly as it did before X1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryAnswerVerdict, isMarketOrderType, isFillExecution, orderDetailsVerdict, orderStatusName } from './order-answer.js'

// The cTrader answers the two engines return (cpp: the first execution event
// echoing the clientMsgId; js: the EXECUTION_EVENT payload).
const ACCEPTED_WITH_PRECREATED_POSITION = { executionType: 'ORDER_ACCEPTED', order: { orderId: 360473873 }, position: { positionId: 241267454 } }
const FILLED = { executionType: 'ORDER_FILLED', order: { orderId: 555 }, position: { positionId: 777 }, deal: { dealId: 9, positionId: 777 } }

// The pre-X1 settleIntent rule, verbatim, for the "exactly as before" check.
const preX1 = (result) => {
  const positionId = result?.position?.positionId ?? result?.deal?.positionId ?? null
  const orderId = result?.order?.orderId ?? null
  return { state: positionId != null ? 'FILLED' : 'ACCEPTED', positionId, brokerOrderId: orderId }
}

test('a resting LIMIT, STOP or STOP_LIMIT accepted with the broker\'s pre-created position id is ACCEPTED with the order id, and the position id is NOT recorded', () => {
  for (const type of ['LIMIT', 'STOP', 'STOP_LIMIT', 'limit', 2, 3, 6, '2']) {
    const v = entryAnswerVerdict(type, ACCEPTED_WITH_PRECREATED_POSITION)
    assert.equal(v.state, 'ACCEPTED', `${type}: acceptance is not a fill`)
    assert.equal(v.brokerOrderId, 360473873)
    assert.equal(v.positionId, null, `${type}: no position exists until the order fills`)
    // the numeric executionType spelling proves the same
    assert.equal(entryAnswerVerdict(type, { ...ACCEPTED_WITH_PRECREATED_POSITION, executionType: 2 }).state, 'ACCEPTED')
  }
})

test('a resting order is FILLED only when the answer says it filled: ORDER_FILLED, ORDER_PARTIAL_FILL (by name or number), or a deal', () => {
  for (const type of ['LIMIT', 'STOP', 'STOP_LIMIT']) {
    assert.deepEqual(entryAnswerVerdict(type, FILLED), { state: 'FILLED', positionId: 777, brokerOrderId: 555, basis: 'resting_deal' })
    assert.equal(entryAnswerVerdict(type, { executionType: 'ORDER_FILLED', order: { orderId: 1 }, position: { positionId: 2 } }).state, 'FILLED')
    assert.equal(entryAnswerVerdict(type, { executionType: 3, order: { orderId: 1 }, position: { positionId: 2 } }).state, 'FILLED')
    assert.equal(entryAnswerVerdict(type, { executionType: 'ORDER_PARTIAL_FILL', order: { orderId: 1 }, position: { positionId: 2 } }).state, 'FILLED')
    assert.equal(entryAnswerVerdict(type, { executionType: 11, order: { orderId: 1 }, position: { positionId: 2 } }).state, 'FILLED')
    assert.equal(entryAnswerVerdict(type, { order: { orderId: 1 }, deal: { positionId: 5 } }).positionId, 5, 'a deal names the position')
    // an unknown or replaced frame without a fill proves acceptance only
    assert.equal(entryAnswerVerdict(type, { executionType: 'ORDER_REPLACED', order: { orderId: 1 }, position: { positionId: 2 } }).state, 'ACCEPTED')
    assert.equal(entryAnswerVerdict(type, {}).state, 'ACCEPTED')
  }
})

test('a MARKET order settles exactly as before X1, over every answer shape — including the cpp ORDER_ACCEPTED that carries the position and no deal', () => {
  const shapes = [
    ACCEPTED_WITH_PRECREATED_POSITION, FILLED, {}, null, { order: { orderId: 3 } }, { deal: { positionId: 4 } },
    { executionType: 'ORDER_FILLED', order: { orderId: 5 } }, { ok: true, positionId: 9 }, { position: { positionId: 0 } },
  ]
  for (const type of ['MARKET', 'MARKET_RANGE', 'market', 1, 5, '1', null, undefined, '']) {
    assert.equal(isMarketOrderType(type), true, String(type))
    for (const r of shapes) {
      const v = entryAnswerVerdict(type, r)
      const old = preX1(r)
      assert.deepEqual({ state: v.state, positionId: v.positionId, brokerOrderId: v.brokerOrderId }, old, `${String(type)} ${JSON.stringify(r)}`)
    }
  }
  for (const type of ['LIMIT', 'STOP', 'STOP_LIMIT', 2, 3, 6]) assert.equal(isMarketOrderType(type), false, String(type))
})

test('isFillExecution reads names and ProtoOAExecutionType numbers; acceptance, cancel and expiry are not fills', () => {
  for (const t of ['ORDER_FILLED', 'ORDER_PARTIAL_FILL', 3, 11, '3', ' order_filled ']) assert.equal(isFillExecution(t), true, String(t))
  for (const t of ['ORDER_ACCEPTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED', 'ORDER_REJECTED', 2, 5, 6, null, '']) assert.equal(isFillExecution(t), false, String(t))
})

test('orderDetailsVerdict: filled → FILLED with the deal\'s position; cancelled → RELEASED; expired → EXPIRED; rejected → REJECTED; still working → null', () => {
  const filled = orderDetailsVerdict({ order: { orderId: 11, orderStatus: 'ORDER_STATUS_FILLED', executedVolume: 1000, positionId: 70 }, deal: [{ dealId: 1, positionId: 71, dealStatus: 'FILLED' }] })
  assert.equal(filled.state, 'FILLED'); assert.equal(filled.positionId, '71', 'the deal names the position the fill opened'); assert.equal(filled.brokerOrderId, '11')
  assert.equal(orderDetailsVerdict({ order: { orderId: 11, orderStatus: 2 } }).state, 'FILLED', 'numeric status')
  const cancelled = orderDetailsVerdict({ order: { orderId: 12, orderStatus: 'ORDER_STATUS_CANCELLED', executedVolume: 0 }, deal: [] })
  assert.deepEqual({ s: cancelled.state, p: cancelled.positionId }, { s: 'RELEASED', p: null }); assert.match(cancelled.note, /^order_cancelled/)
  assert.equal(orderDetailsVerdict({ order: { orderId: 13, orderStatus: 5 } }).state, 'RELEASED')
  const expired = orderDetailsVerdict({ order: { orderId: 14, orderStatus: 4 } })
  assert.equal(expired.state, 'EXPIRED'); assert.match(expired.note, /^order_expired/)
  assert.equal(orderDetailsVerdict({ order: { orderId: 15, orderStatus: 'ORDER_STATUS_REJECTED' } }).state, 'REJECTED')
  assert.equal(orderDetailsVerdict({ order: { orderId: 16, orderStatus: 'ORDER_STATUS_ACCEPTED' } }), null, 'still working proves no outcome')
  assert.equal(orderDetailsVerdict({}), null); assert.equal(orderDetailsVerdict(null), null)
  // a partial fill later cancelled opened a position: FILLED, and the note says so
  const partial = orderDetailsVerdict({ order: { orderId: 17, orderStatus: 'ORDER_STATUS_CANCELLED', executedVolume: 300 }, deal: [{ positionId: 80, dealStatus: 3 }] })
  assert.equal(partial.state, 'FILLED'); assert.equal(partial.positionId, '80'); assert.match(partial.note, /partial fill \(executed 300\), then cancelled/)
  // a rejected deal or a closing deal is not a fill of this entry
  assert.equal(orderDetailsVerdict({ order: { orderId: 18, orderStatus: 5 }, deal: [{ positionId: 81, dealStatus: 'REJECTED' }] }).state, 'RELEASED')
  assert.equal(orderDetailsVerdict({ order: { orderId: 19, orderStatus: 5 }, deal: [{ positionId: 82, closePositionDetail: {} }] }).state, 'RELEASED')
  assert.equal(orderStatusName('ORDER_STATUS_EXPIRED'), 'EXPIRED'); assert.equal(orderStatusName(4), 'EXPIRED'); assert.equal(orderStatusName(9), null)
})
