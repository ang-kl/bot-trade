import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wsAmendPosition, wsClosePosition, wsGetSymbolsList, PT } from './ctrader-ws.js'

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

// V3 K2: the host-keyed symbol-list cache answers a read "for" account B with
// whichever account on the host was read first. The one writer of an
// account's own map asks for `perAccount`, which must never be served from,
// nor stored into, that cache. Asserted on promise identity while the reads
// are in flight (an unroutable host, so nothing reaches a broker); every
// other caller keeps the shared cache exactly as before.
test('an account-true symbol-list read is never served from, nor stored into, the host-shared cache', async () => {
  const host = 'k2-symbols-list.invalid-host.localhost'
  const first = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '1', 50)
  const shared = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50)
  assert.equal(shared, first, 'unchanged for every other caller: one read per host')
  const own = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50, { perAccount: true })
  assert.notEqual(own, first, "RED if the per-account read returns the host entry (account 1's list)")
  const ownAgain = wsGetSymbolsList(host, 'cid', 'csec', 'tok', '2', 50, { perAccount: true })
  assert.notEqual(ownAgain, own, 'nor is it cached itself: the per-account map in the DB is its cache')
  assert.equal(wsGetSymbolsList(host, 'cid', 'csec', 'tok', '3', 50), first, 'the per-account reads did not replace the host entry')
  const settled = await Promise.allSettled([first, own, ownAgain])
  assert.deepEqual(settled.map(s => s.status), ['rejected', 'rejected', 'rejected'])
  // K2 fix round (B7's rule): a per-account read's failure names its account,
  // so the reactive refresh's skip predicate can match a refused account. The
  // host-shared promise is served to other accounts' callers, so it stays
  // untagged exactly as before.
  assert.deepEqual([settled[1].reason.accountId, settled[2].reason.accountId], ['2', '2'], 'RED if the per-account read\'s error is not tagged')
  assert.equal(settled[0].reason.accountId, undefined, 'the host-shared read is unchanged: untagged')
})

// V3 S-8 fix round 3 (N-2): the entry path's options must REACH withRetry
// through wsGetSymbolsList and wsGetSymbolById, not only be passed to them.
// Driven through the pooled path's socket seam: the broker refuses the account
// auth with an auth error carrying "retry after 1ms", so the default path's
// three attempts cost milliseconds, not the 2 s + 4 s backoff.
test('S-8: the entry options reach withRetry — 1 connect and no refresh, where the defaults make 3 connects and 1 refresh', async () => {
  const { EventEmitter } = await import('node:events')
  const { _setConnectForTests, _resetPool } = await import('./ctrader-session.js')
  const { wsGetSymbolById, setAuthErrorHook, _resetAuthRecoveryForTests } = await import('./ctrader-ws.js')
  class FakeWs extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')) }
    send(raw) {
      const msg = JSON.parse(raw)
      const reply = (payloadType, payload) => setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ payloadType, payload, clientMsgId: msg.clientMsgId }))))
      if (msg.payloadType === PT.APP_AUTH_REQ) reply(PT.APP_AUTH_RES, {})
      else if (msg.payloadType === PT.ACCOUNT_AUTH_REQ) reply(PT.ERROR_RES, { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'retry after 1ms' })
    }
    close() { this.readyState = 3 }
  }
  let connects = 0, refreshes = 0
  const prev = process.env.CTRADER_WS_POOL
  process.env.CTRADER_WS_POOL = '1'
  _setConnectForTests(() => { connects++; return new FakeWs() })
  setAuthErrorHook(async () => { refreshes++ })
  const reads = {
    wsGetSymbolsList: opts => wsGetSymbolsList('s8.example.com', 'cid', 'sec', 'tok', '4001', 1000, { perAccount: true, ...opts }),
    wsGetSymbolById: opts => wsGetSymbolById('s8.example.com', 'cid', 'sec', 'tok', '4001', [22], 1000, opts),
  }
  try {
    for (const [name, read] of Object.entries(reads)) {
      for (const [opts, want] of [
        [{ maxRetries: 0, recoverAuth: false }, { connects: 1, refreshes: 0 }],
        [undefined, { connects: 3, refreshes: 1 }],
      ]) {
        _resetPool(); _resetAuthRecoveryForTests(); connects = 0; refreshes = 0
        await assert.rejects(read(opts), /CH_ACCESS_TOKEN_INVALID/)
        assert.deepEqual({ connects, refreshes }, want, `${name} ${opts ? 'entry options' : 'defaults'}: RED if the options stop at the function instead of reaching withRetry`)
      }
    }
  } finally {
    setAuthErrorHook(null)
    _setConnectForTests(null)
    if (prev === undefined) delete process.env.CTRADER_WS_POOL
    else process.env.CTRADER_WS_POOL = prev
    _resetPool()
  }
})
