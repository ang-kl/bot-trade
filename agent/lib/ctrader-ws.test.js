import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wsAmendPosition, wsClosePosition, PT } from './ctrader-ws.js'

// These tests exercise the input-validation paths that run *before* any
// WebSocket handshake — so we can assert them without mocking `ws`. The
// broker-facing happy paths are exercised by live integration against a
// Pepperstone demo account as part of the PR acceptance checklist.

test('PT payload constants match Spotware OpenAPI', () => {
  assert.equal(PT.APP_AUTH_REQ, 2100)
  assert.equal(PT.ACCOUNT_AUTH_REQ, 2102)
  assert.equal(PT.NEW_ORDER_REQ, 2106)
  assert.equal(PT.AMEND_POSITION_SLTP_REQ, 2110)
  assert.equal(PT.CLOSE_POSITION_REQ, 2111)
  assert.equal(PT.SYMBOL_BY_ID_REQ, 2116)
  assert.equal(PT.SYMBOL_BY_ID_RES, 2117)
  assert.equal(PT.RECONCILE_REQ, 2124)
  assert.equal(PT.RECONCILE_RES, 2125)
  assert.equal(PT.EXECUTION_EVENT, 2126)
  assert.equal(PT.ORDER_ERROR_EVENT, 2132)
})

test('wsAmendPosition rejects missing positionId', async () => {
  await assert.rejects(
    () => wsAmendPosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: null, stopLoss: 100,
    }),
    /positionId required/,
  )
})

test('wsAmendPosition rejects when neither SL nor TP supplied', async () => {
  await assert.rejects(
    () => wsAmendPosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42,
    }),
    /stopLoss or takeProfit required/,
  )
})

test('wsAmendPosition accepts SL only', async () => {
  // Argument check passes → throws a network/timeout error instead. That's
  // enough to confirm the guard let us through; we don't actually dial.
  await assert.rejects(
    () => wsAmendPosition('invalid-host.localhost', 'cid', 'csec', 'tok', '123', {
      positionId: 42, stopLoss: 100,
    }, 100),
    (err) => !/positionId required|stopLoss or takeProfit/.test(err.message),
  )
})

test('wsClosePosition rejects missing positionId', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: null, volume: 10000,
    }),
    /positionId required/,
  )
})

test('wsClosePosition rejects non-positive volume', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: 0,
    }),
    /volume must be a positive number/,
  )
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: -100,
    }),
    /volume must be a positive number/,
  )
})

test('wsClosePosition rejects non-numeric volume', async () => {
  await assert.rejects(
    () => wsClosePosition('demo.ctraderapi.com', 'cid', 'csec', 'tok', '123', {
      positionId: 42, volume: '10000',
    }),
    /volume must be a positive number/,
  )
})

// V3 T2 fix round (checker N1). The JS WebSocket fallback answers a close
// with the FIRST execution event, as the gateway does, and for a market close
// that can be ORDER_ACCEPTED: an order and no deal. Its order id is the only
// way the close's deal is found in history afterwards, so the fallback must
// return the `order`. Driven through the pooled path, whose socket is the one
// test seam this module has (ctrader-session _setConnectForTests).
test('wsClosePosition keeps the ORDER_ACCEPTED order, so the partial evidence decodes its order id', async () => {
  const { EventEmitter } = await import('node:events')
  const { _setConnectForTests, _resetPool } = await import('./ctrader-session.js')
  const { partialAcceptedEvidence } = await import('../services/momentum-broker-evidence.js')
  class FakeWs extends EventEmitter {
    constructor(answer) { super(); this.readyState = 1; this.answer = answer; setImmediate(() => this.emit('open')) }
    send(raw) {
      const msg = JSON.parse(raw)
      const reply = (payloadType, payload) => setImmediate(() => this.emit('message',
        Buffer.from(JSON.stringify({ payloadType, payload, clientMsgId: msg.clientMsgId }))))
      if (msg.payloadType === PT.APP_AUTH_REQ) reply(PT.APP_AUTH_RES, {})
      else if (msg.payloadType === PT.ACCOUNT_AUTH_REQ) reply(PT.ACCOUNT_AUTH_RES, {})
      else if (msg.payloadType === PT.CLOSE_POSITION_REQ) reply(PT.EXECUTION_EVENT, this.answer)
    }
    close() { this.readyState = 3 }
  }
  const accepted = { ctidTraderAccountId: 4001, executionType: 'ORDER_ACCEPTED',
    order: { orderId: 77, positionId: 33, closingOrder: true, tradeData: { symbolId: 22, tradeSide: 'SELL', volume: 2600 } },
    position: { positionId: 33 } }
  const filled = { ctidTraderAccountId: 4001, executionType: 'ORDER_FILLED', deal: { dealId: 5 }, position: { positionId: 33 } }
  const context = { identity: { host: 'demo.ctraderapi.com', accountId: '4001', symbolId: '22' }, positionId: '33', side: 'BUY', closeVolume: 2600 }
  const prev = process.env.CTRADER_WS_POOL
  process.env.CTRADER_WS_POOL = '1'
  try {
    for (const [answer, check] of [[accepted, out => {
      assert.equal(out.executionType, 'ORDER_ACCEPTED')
      assert.equal(out.order?.orderId, 77)
      assert.equal(partialAcceptedEvidence(out, context)?.orderId, '77')
    }], [filled, out => {
      // A fill without an order in its payload is returned as before: no key.
      assert.deepEqual(out, { ctidTraderAccountId: 4001, executionType: 'ORDER_FILLED', deal: { dealId: 5 }, position: { positionId: 33 } })
    }]]) {
      _resetPool()
      _setConnectForTests(() => new FakeWs(answer))
      check(await wsClosePosition('demo.example.com', 'cid', 'sec', 'tok', '4001', { positionId: 33, volume: 2600 }))
    }
  } finally {
    _setConnectForTests(null)
    if (prev === undefined) delete process.env.CTRADER_WS_POOL
    else process.env.CTRADER_WS_POOL = prev
    _resetPool()
  }
})
