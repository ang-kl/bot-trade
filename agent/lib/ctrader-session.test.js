// ctrader-session — a persistent authenticated socket carries hazards a
// throwaway one does not. These tests exist for the hazards, not the happy
// path: this module sits directly on the order path of a live account, and the
// failure it must never have is one request reading another's reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { PT } from './ctrader-payload-types.js'
import { isUnsolicited, pooledRun, poolStatus, _resetPool, poolEnabled } from './ctrader-session.js'

// A scriptable stand-in for `ws`. Records everything sent and lets a test
// reply on its own schedule, so ordering hazards can be provoked deliberately.
class FakeWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1 // OPEN
    this.sent = []
    FakeWs.last = this
    setImmediate(() => this.emit('open'))
  }
  send(raw) {
    const msg = JSON.parse(raw)
    if (msg.payloadType === PT.HEARTBEAT) return
    this.sent.push(msg)
    if (this.onSend) this.onSend(msg, this)
  }
  close() { this.readyState = 3 }
  reply(payloadType, payload = {}, clientMsgId = undefined) {
    this.emit('message', Buffer.from(JSON.stringify({ payloadType, payload, ...(clientMsgId ? { clientMsgId } : {}) })))
  }
}

// Auto-answer the two auth steps, then hand control to the test.
const autoAuth = (afterAuth) => (msg, ws) => {
  if (msg.payloadType === PT.APP_AUTH_REQ) return ws.reply(PT.APP_AUTH_RES, {}, msg.clientMsgId)
  if (msg.payloadType === PT.ACCOUNT_AUTH_REQ) return ws.reply(PT.ACCOUNT_AUTH_RES, {}, msg.clientMsgId)
  if (afterAuth) afterAuth(msg, ws)
}

const deps = (afterAuth) => ({
  connect: () => { const w = new FakeWs(); w.onSend = autoAuth(afterAuth); return w },
  takeHistoricalToken: async () => 0,
  isHistorical: () => false,
})

const APP = { clientId: 'cid', clientSecret: 'sec' }
const ACC = { ctidTraderAccountId: 111, accessToken: 'tok' }
const run = (steps, d, timeout = 1000, collectAll = false) =>
  pooledRun('demo.example.com', APP, ACC, steps, timeout, collectAll, d)

const RECONCILE = [{ send: { payloadType: PT.RECONCILE_REQ, payload: {} }, expect: PT.RECONCILE_RES }]

test('off by default — the flag has to be set deliberately', () => {
  const prev = process.env.CTRADER_WS_POOL
  delete process.env.CTRADER_WS_POOL
  try { assert.equal(poolEnabled(), false) } finally {
    if (prev !== undefined) process.env.CTRADER_WS_POOL = prev
  }
})

test('auth runs ONCE, then the socket is reused — the whole point', async () => {
  _resetPool()
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.RECONCILE_REQ) ws.reply(PT.RECONCILE_RES, { position: [] }, msg.clientMsgId)
  })
  const a = await run(RECONCILE, d)
  const first = FakeWs.last
  const b = await run(RECONCILE, d)

  assert.deepEqual(a, { position: [] })
  assert.deepEqual(b, { position: [] })
  assert.equal(FakeWs.last, first, 'the second call must not open a new socket')
  const auths = first.sent.filter(m => m.payloadType === PT.APP_AUTH_REQ || m.payloadType === PT.ACCOUNT_AUTH_REQ)
  assert.equal(auths.length, 2, `auth should be paid once, saw ${auths.length} auth messages`)
  _resetPool()
})

test('THE HAZARD: two concurrent calls do not interleave on one socket', async () => {
  _resetPool()
  process.env.CTRADER_WS_POOL_SIZE = '1' // force both onto the same socket
  const pending = []
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.RECONCILE_REQ) pending.push({ msg, ws })
  })
  try {
    const p1 = run(RECONCILE, d)
    const p2 = run(RECONCILE, d)
    // Let both calls get as far as they can.
    await new Promise(r => setTimeout(r, 30))
    assert.equal(pending.length, 1, 'the second request must wait, not share the socket')

    pending[0].ws.reply(PT.RECONCILE_RES, { position: ['first'] }, pending[0].msg.clientMsgId)
    assert.deepEqual(await p1, { position: ['first'] })

    await new Promise(r => setTimeout(r, 10))
    assert.equal(pending.length, 2, 'the queued request should go out once the first finished')
    pending[1].ws.reply(PT.RECONCILE_RES, { position: ['second'] }, pending[1].msg.clientMsgId)
    assert.deepEqual(await p2, { position: ['second'] })
  } finally {
    delete process.env.CTRADER_WS_POOL_SIZE
    _resetPool()
  }
})

test('a reply carrying somebody else\'s clientMsgId is refused, not returned', async () => {
  _resetPool()
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.RECONCILE_REQ) {
      ws.reply(PT.RECONCILE_RES, { position: ['WRONG'] }, 'not-our-id')
      setTimeout(() => ws.reply(PT.RECONCILE_RES, { position: ['ours'] }, msg.clientMsgId), 5)
    }
  })
  assert.deepEqual(await run(RECONCILE, d), { position: ['ours'] })
  _resetPool()
})

test('multi-step sequences still work, and collectAll returns every payload', async () => {
  _resetPool()
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.SYMBOLS_LIST_REQ) ws.reply(PT.SYMBOLS_LIST_RES, { symbol: ['a'] }, msg.clientMsgId)
    if (msg.payloadType === PT.TRADER_REQ) ws.reply(PT.TRADER_RES, { trader: { balance: 1 } }, msg.clientMsgId)
  })
  const steps = [
    { send: { payloadType: PT.SYMBOLS_LIST_REQ, payload: {} }, expect: PT.SYMBOLS_LIST_RES },
    { send: { payloadType: PT.TRADER_REQ, payload: {} }, expect: PT.TRADER_RES },
  ]
  assert.deepEqual(await run(steps, d, 1000, false), { trader: { balance: 1 } })
  assert.deepEqual(await run(steps, d, 1000, true), [{ symbol: ['a'] }, { trader: { balance: 1 } }])
  _resetPool()
})

test('a broker ERROR_RES rejects with the same message shape as before', async () => {
  _resetPool()
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.RECONCILE_REQ) {
      ws.reply(PT.ERROR_RES, { errorCode: 'NO_SUCH_THING', description: 'nope' }, msg.clientMsgId)
    }
  })
  await assert.rejects(run(RECONCILE, d), /cTrader error: NO_SUCH_THING — nope/)
  _resetPool()
})

test('a timeout destroys the socket rather than leaving a late reply for the next caller', async () => {
  _resetPool()
  const d = deps(() => { /* never answer */ })
  await assert.rejects(run(RECONCILE, d, 60), /cTrader WS timeout after 60ms/)
  assert.equal(poolStatus().sockets, 0, 'a timed-out socket must not stay in the pool')
  _resetPool()
})

test('an error after submission keeps the "after sending" marker isAmbiguousSubmitError needs', async () => {
  _resetPool()
  const d = deps((msg, ws) => {
    if (msg.payloadType === PT.NEW_ORDER_REQ) ws.emit('error', new Error('socket died'))
  })
  const steps = [{ send: { payloadType: PT.NEW_ORDER_REQ, payload: {} }, expect: PT.EXECUTION_EVENT }]
  // L3's whole idempotency story reads this substring to decide whether an
  // order may have reached the broker. Losing it would turn an ambiguous
  // submission into a "safe to retry" one — i.e. duplicate positions.
  await assert.rejects(run(steps, d, 500), new RegExp(`after sending ${PT.NEW_ORDER_REQ}`))
  _resetPool()
})

// isUnsolicited is the rule that keeps a broker-initiated fill from being read
// as our own reply. Pure, so it can be pinned exactly.
test('isUnsolicited: an execution event for somebody else is dropped while we wait on a read', () => {
  const readInFlight = { msgId: 'p1', sentType: PT.RECONCILE_REQ }
  assert.equal(isUnsolicited({ payloadType: PT.EXECUTION_EVENT }, readInFlight), true,
    'a stop firing elsewhere must not be mistaken for a reconcile reply')
})

test('isUnsolicited: our own order reply IS accepted even with no echoed id', () => {
  const orderInFlight = { msgId: 'p1', sentType: PT.NEW_ORDER_REQ }
  assert.equal(isUnsolicited({ payloadType: PT.EXECUTION_EVENT }, orderInFlight), false)
})

test('isUnsolicited: a mismatched echoed id is refused whatever the type', () => {
  const f = { msgId: 'p1', sentType: PT.NEW_ORDER_REQ }
  assert.equal(isUnsolicited({ payloadType: PT.EXECUTION_EVENT, clientMsgId: 'p2' }, f), true)
  assert.equal(isUnsolicited({ payloadType: PT.EXECUTION_EVENT, clientMsgId: 'p1' }, f), false)
})

test('isUnsolicited: nothing is accepted when no request is in flight', () => {
  assert.equal(isUnsolicited({ payloadType: PT.EXECUTION_EVENT }, null), true)
})

test('historical steps still pass through the rate limiter, and credit back the wait', async () => {
  _resetPool()
  let took = 0
  const d = {
    ...deps((msg, ws) => {
      if (msg.payloadType === PT.GET_TRENDBARS_REQ) ws.reply(PT.GET_TRENDBARS_RES, { trendbar: [] }, msg.clientMsgId)
    }),
    takeHistoricalToken: async () => { took++; return 0 },
    isHistorical: (t) => t === PT.GET_TRENDBARS_REQ,
  }
  await run([{ send: { payloadType: PT.GET_TRENDBARS_REQ, payload: {} }, expect: PT.GET_TRENDBARS_RES }], d)
  assert.equal(took, 1, 'a trendbar request that skipped the bucket is the 2026-07-28 throttling incident again')
  _resetPool()
})

// ---------------------------------------------------------------------------
// WIRING. The module above can be perfect and still never be reached: wsRun
// decides whether to use it, and that decision has its own failure modes —
// forgetting to peel the auth prefix, or peeling it and losing the auth.
// ---------------------------------------------------------------------------
test('wsRun routes through the pool when flagged, and pays auth once across calls', async () => {
  _resetPool()
  const prev = process.env.CTRADER_WS_POOL
  process.env.CTRADER_WS_POOL = '1'
  const { _setConnectForTests } = await import('./ctrader-session.js')
  const sockets = []
  _setConnectForTests(() => {
    const w = new FakeWs()
    sockets.push(w)
    w.onSend = autoAuth((msg, ws) => {
      if (msg.payloadType === PT.RECONCILE_REQ) ws.reply(PT.RECONCILE_RES, { position: [] }, msg.clientMsgId)
    })
    return w
  })
  try {
    const { wsReconcile } = await import('./ctrader-ws.js')
    await wsReconcile('demo.example.com', 'cid', 'sec', 'tok', '999')
    await wsReconcile('demo.example.com', 'cid', 'sec', 'tok', '999')

    assert.equal(sockets.length, 1, 'the second reconcile opened a second socket — pooling is not wired up')
    const auths = sockets[0].sent.filter(m => m.payloadType === PT.ACCOUNT_AUTH_REQ)
    assert.equal(auths.length, 1, `account auth should be paid once per socket, saw ${auths.length}`)
    // And the request itself must still have gone out — peeling the auth
    // prefix must not eat the payload it was prefixing.
    assert.equal(sockets[0].sent.filter(m => m.payloadType === PT.RECONCILE_REQ).length, 2)
  } finally {
    _setConnectForTests(null)
    if (prev === undefined) delete process.env.CTRADER_WS_POOL
    else process.env.CTRADER_WS_POOL = prev
    _resetPool()
  }
})

test('with the flag OFF, wsRun does not touch the pool at all', async () => {
  _resetPool()
  const prev = process.env.CTRADER_WS_POOL
  delete process.env.CTRADER_WS_POOL
  const { _setConnectForTests } = await import('./ctrader-session.js')
  let used = false
  _setConnectForTests(() => { used = true; return new FakeWs() })
  try {
    const { _internal } = await import('./ctrader-ws.js')
    // Legacy path opens its own real socket; we only assert it did NOT come
    // from the pool. The connection attempt itself is expected to fail here.
    await _internal.wsRun('127.0.0.1', [
      { send: { payloadType: PT.APP_AUTH_REQ, payload: {} }, expect: PT.APP_AUTH_RES },
      { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: {} }, expect: PT.ACCOUNT_AUTH_RES },
      { send: { payloadType: PT.RECONCILE_REQ, payload: {} }, expect: PT.RECONCILE_RES },
    ], 40).catch(() => {})
    assert.equal(used, false, 'the pool must be inert unless CTRADER_WS_POOL=1')
    assert.equal(poolStatus().sockets, 0)
  } finally {
    _setConnectForTests(null)
    if (prev !== undefined) process.env.CTRADER_WS_POOL = prev
    _resetPool()
  }
})


// ---------------------------------------------------------------------------
// Wave 5 §K·15, checker BLOCKER (19-09-2026): the queued-call bound must never
// let one wsPlaceOrder put two NEW_ORDER_REQ on the wire.
// ---------------------------------------------------------------------------
import { _SessionForTests } from './ctrader-session.js'
import { isAmbiguousSubmitError } from './ctrader-ws.js'
import { inflightSummary, _resetInflightForTests } from './inflight.js'

const ORDER = [{ send: { payloadType: PT.NEW_ORDER_REQ, payload: { ctidTraderAccountId: 111, symbolId: 1, label: 'ORDER-B' } }, expect: PT.EXECUTION_EVENT }]
const withQueueBudget = async (ms, fn) => {
  const prev = process.env.CTRADER_QUEUE_BUDGET_MS
  process.env.CTRADER_QUEUE_BUDGET_MS = String(ms)
  const keepAlive = setTimeout(() => {}, 5_000)
  try { return await fn() } finally {
    clearTimeout(keepAlive)
    if (prev == null) delete process.env.CTRADER_QUEUE_BUDGET_MS; else process.env.CTRADER_QUEUE_BUDGET_MS = prev
  }
}

test('CANCEL BEFORE SEND: a queued order that outlives its budget is DROPPED, never sent late — one wsPlaceOrder-style retry loop puts exactly ONE NEW_ORDER_REQ through runNow, the abandoned attempt zero', async () => {
  _resetInflightForTests()
  await withQueueBudget(30, async () => {
    const s = new _SessionForTests('k', { host: 'demo.example.com', appAuth: APP, accountAuth: ACC, connect: () => { throw new Error('no socket') }, log: () => {} })
    let releaseChain
    s.chain = new Promise(r => { releaseChain = r })       // the socket is busy with an earlier request
    const reached = []
    s.runNow = async (steps) => { reached.push(steps[steps.length - 1].send.payloadType); return { ok: true } }
    // wsPlaceOrder's loop: withRetry(fn, 2, …, isAmbiguousSubmitError) retries
    // only failures the classifier calls pre-submit. Mirrored here without
    // its 2 s/4 s backoff.
    const errors = []
    let result = null
    for (let attempt = 0; attempt <= 2 && !result; attempt++) {
      try { result = await s.run(ORDER, 20, false, async () => 0, () => false) } catch (err) {
        errors.push(err)
        if (isAmbiguousSubmitError(err)) throw err
        if (attempt === 0) {
          assert.equal(reached.length, 0, 'the abandoned attempt never reached runNow')
          assert.equal(inflightSummary().count, 0, 'the abandoned call is released from the registry')
          releaseChain()                                   // the earlier request finishes now
          await new Promise(r => setImmediate(r))
        }
      }
    }
    assert.equal(errors.length, 1, 'one queued_timeout, then the retry went through')
    assert.match(errors[0].message, /queued_timeout/)
    assert.match(errors[0].message, /dropped unsent: it never reached the broker/)
    assert.equal(isAmbiguousSubmitError(errors[0]), false, 'never sent → not ambiguous → the retry is the RIGHT call')
    assert.deepEqual(reached, [PT.NEW_ORDER_REQ], 'exactly ONE NEW_ORDER_REQ ever reached runNow')
    assert.deepEqual(result, { ok: true })
    assert.equal(inflightSummary().count, 0)
  })
  _resetInflightForTests()
})

test('ONCE STARTED the outer deadline never fires: the per-step timer owns the call, its error carries the numeric marker isAmbiguousSubmitError reads, exactly one NEW_ORDER_REQ hits the wire, and the registry holds the call until it truly ends', async () => {
  _resetPool()
  _resetInflightForTests()
  const prev = process.env.CTRADER_WS_POOL
  process.env.CTRADER_WS_POOL = '1'
  try {
    await withQueueBudget(10, async () => {
      // Per-step 60 ms, queue budget 10 ms: the deadline (70 ms) lands AFTER
      // the request has started and must be a no-op; the per-step timeout at
      // 60 ms is what rejects.
      const d = deps((msg) => { if (msg.payloadType === PT.NEW_ORDER_REQ) { /* never answered */ } })
      const p = run(ORDER, d, 60)
      await new Promise(r => setTimeout(r, 20))
      assert.equal(inflightSummary().count, 1, 'registered while in flight')
      const err = await p.then(() => null, e => e)
      assert.ok(err, 'rejected')
      assert.match(err.message, /after sending 2106/, 'the per-step timeout message, with the numeric marker')
      assert.ok(!/queued_timeout/.test(err.message), 'the outer deadline did not fire on a started call')
      assert.equal(isAmbiguousSubmitError(err), true, 'a sent order that timed out is AMBIGUOUS — no resubmit')
      assert.equal(FakeWs.last.sent.filter(m => m.payloadType === PT.NEW_ORDER_REQ).length, 1, 'exactly one NEW_ORDER_REQ on the wire')
      assert.equal(inflightSummary().count, 0, 'released when the call truly ended')
    })
  } finally {
    if (prev == null) delete process.env.CTRADER_WS_POOL; else process.env.CTRADER_WS_POOL = prev
    _resetPool(); _resetInflightForTests()
  }
})

test('a pooled call is registered ONCE: run() with registered:true does not add a session-level entry', async () => {
  _resetInflightForTests()
  const s = new _SessionForTests('k', { host: 'h', appAuth: APP, accountAuth: ACC, connect: () => { throw new Error('no socket') }, log: () => {} })
  s.runNow = async () => { assert.equal(inflightSummary().count, 0, 'wsRun holds the only entry'); return 1 }
  assert.equal(await s.run(RECONCILE, 50, false, async () => 0, () => false, { registered: true }), 1)
  s.runNow = async () => { assert.equal(inflightSummary().count, 1, 'a direct session call registers itself'); return 2 }
  assert.equal(await s.run(RECONCILE, 50, false, async () => 0, () => false), 2)
  assert.equal(inflightSummary().count, 0)
})
