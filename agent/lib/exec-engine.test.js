// Tests for the exec-engine delegator: mode selection plus cpp-mode HTTP
// contract against a local stub sidecar (auth header, paths, body
// passthrough, error-text preservation for loop.js substring matching).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execEngineMode, placeOrder, amendPosition, closePosition, cancelOrder, reconcile, backtestRemote } from './exec-engine.js'

const CREDS = { host: 'demo.ctraderapi.com', clientId: 'ci', clientSecret: 'cs', accessToken: 'at', accountId: '123' }

let server
let requests = []
// Each test sets nextResponse to control the stub's reply.
let nextResponse = { status: 200, body: '{}' }

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw })
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' })
      res.end(nextResponse.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.EXEC_URL = `http://127.0.0.1:${server.address().port}`
  process.env.EXEC_SECRET = 'sekret'
})

after(() => server.close())

beforeEach(() => {
  requests = []
  nextResponse = { status: 200, body: '{}' }
  process.env.EXEC_ENGINE = 'cpp'
})

test('execEngineMode: js by default, cpp only when EXEC_ENGINE=cpp', () => {
  delete process.env.EXEC_ENGINE
  assert.equal(execEngineMode(), 'js')
  process.env.EXEC_ENGINE = 'anything-else'
  assert.equal(execEngineMode(), 'js')
  process.env.EXEC_ENGINE = 'cpp'
  assert.equal(execEngineMode(), 'cpp')
})

test('cpp placeOrder: pushes /connect once, then POST /order with bearer auth', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ ok: true, positionId: 9 }) }
  const payload = { symbolId: 41, tradeSide: 'BUY', volume: 100000 }
  const out = await placeOrder(CREDS, payload)
  assert.deepEqual(out, { ok: true, positionId: 9 })
  // First cpp-mode call must push credentials to the sidecar (which holds
  // none of its own), THEN place the order. Same creds later → no re-push.
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/connect')
  assert.equal(requests[0].auth, 'Bearer sekret')
  assert.deepEqual(JSON.parse(requests[0].body), {
    host: CREDS.host, clientId: CREDS.clientId, clientSecret: CREDS.clientSecret,
    accessToken: CREDS.accessToken, accountId: CREDS.accountId,
  })
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[1].url, '/order')
  assert.equal(requests[1].auth, 'Bearer sekret')
  assert.deepEqual(JSON.parse(requests[1].body), payload)
})

test('cpp amendPosition: POST /amend with args passthrough', async () => {
  const args = { positionId: 7, stopLoss: 1.1, takeProfit: 1.2 }
  await amendPosition(CREDS, args)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/amend')
  assert.equal(requests[0].auth, 'Bearer sekret')
  assert.deepEqual(JSON.parse(requests[0].body), args)
})

test('cpp closePosition: POST /close with args passthrough', async () => {
  const args = { positionId: 7, volume: 100000 }
  await closePosition(CREDS, args)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/close')
  assert.deepEqual(JSON.parse(requests[0].body), args)
})

test('cpp cancelOrder: POST /cancel with bearer auth, accountId + orderId body', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ executionType: 'ORDER_CANCELLED' }) }
  const out = await cancelOrder(CREDS, { orderId: 555 })
  assert.deepEqual(out, { executionType: 'ORDER_CANCELLED' })
  const req = requests[requests.length - 1]
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/cancel')
  assert.equal(req.auth, 'Bearer sekret')
  // The sidecar's /cancel body carries the account explicitly — the sidecar
  // holds no credentials of its own beyond the pushed session.
  assert.deepEqual(JSON.parse(req.body), { ctidTraderAccountId: 123, orderId: 555 })
})

test('cpp reconcile: GET /positions, returns parsed JSON', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ position: [{ positionId: 1 }] }) }
  const out = await reconcile(CREDS)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].url, '/positions')
  assert.equal(requests[0].body, '')
  assert.deepEqual(out, { position: [{ positionId: 1 }] })
})

test('cpp error mapping preserves broker text: order rejected', async () => {
  nextResponse = { status: 422, body: 'order rejected: MARKET_CLOSED' }
  await assert.rejects(placeOrder(CREDS, { symbolId: 1 }), (err) => {
    assert.match(err.message, /order rejected/)
    assert.match(err.message, /MARKET_CLOSED/)
    return true
  })
})

test('cpp error mapping preserves POSITION_NOT_FOUND substring', async () => {
  nextResponse = { status: 404, body: 'POSITION_NOT_FOUND: position 7 unknown' }
  await assert.rejects(closePosition(CREDS, { positionId: 7, volume: 1 }), (err) => {
    assert.match(err.message, /POSITION_NOT_FOUND/)
    return true
  })
})

test('cpp error with empty body still throws a status-labelled error', async () => {
  nextResponse = { status: 500, body: '' }
  await assert.rejects(reconcile(CREDS), (err) => {
    assert.match(err.message, /500/)
    assert.match(err.message, /\/positions/)
    return true
  })
})

test('cpp backtestRemote: POST /backtest with bearer auth, no /connect push, parsed body back', async () => {
  const body = {
    trades: [{ dir: 1, entry: 1.1, exit: 1.2, entryT: 1000, exitT: 2000, pnlPct: 9.07, reason: 'tp' }],
    stats: { trades: 1, wins: 1, losses: 0, winRatePct: 100, profitFactor: null, totalProfitPct: 9.07, maxDrawdownPct: 0 },
    wf: { segments: [], active: 0, positive: 0, worstMddPct: 0 },
  }
  nextResponse = { status: 200, body: JSON.stringify(body) }
  const payload = {
    bars: [[1000, 1, 2, 0.5, 1.5, 10]],
    timeframe: '4h', tfMinutes: 240, capMinutes: 4320,
    entryMode: 'close', minConviction: 8,
  }
  const out = await backtestRemote(payload)
  assert.deepEqual(out, body)
  // The backtester needs no broker session — exactly one request, no /connect.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/backtest')
  assert.equal(requests[0].auth, 'Bearer sekret')
  assert.deepEqual(JSON.parse(requests[0].body), payload)
})

test('cpp backtestRemote: non-2xx throws with the sidecar text preserved', async () => {
  nextResponse = { status: 413, body: 'payload too large' }
  await assert.rejects(backtestRemote({ bars: [] }), (err) => {
    assert.match(err.message, /payload too large/)
    return true
  })
})

test('js backtestRemote: returns null without any HTTP call', async () => {
  delete process.env.EXEC_ENGINE
  const out = await backtestRemote({ bars: [], timeframe: '4h' })
  assert.equal(out, null)
  assert.equal(requests.length, 0)
})

test('js mode delegates to ctrader-ws exports with identical arguments', async () => {
  delete process.env.EXEC_ENGINE
  // The ws functions open real sockets, so verify delegation by argument
  // shape: a bogus host makes them fail, but only AFTER accepting our args —
  // we assert the failure is a connection error, not from the delegator, and
  // that no HTTP request reached the sidecar stub.
  const p = placeOrder({ ...CREDS, host: '127.0.0.1' }, { symbolId: 1 })
  // Must be a network-level failure from the ws layer (proves the call
  // reached ctrader-ws), never an error thrown by the delegator itself.
  await assert.rejects(p, (err) => /ECONNREFUSED|ETIMEDOUT|socket|closed|handshake|connect/i.test(err.message) || /ECONNREFUSED|ETIMEDOUT/.test(err.code || ''))
  assert.equal(requests.length, 0)
})

test('js cancelOrder delegates positionally to wsCancelOrder', async () => {
  delete process.env.EXEC_ENGINE
  // Same delegation-by-argument-shape technique as the js placeOrder test:
  // a bogus host must yield a network-level ws failure, proving the call
  // reached wsCancelOrder with our args, and nothing hit the sidecar stub.
  const p = cancelOrder({ ...CREDS, host: '127.0.0.1' }, { orderId: 42 })
  await assert.rejects(p, (err) => /ECONNREFUSED|ETIMEDOUT|socket|closed|handshake|connect/i.test(err.message) || /ECONNREFUSED|ETIMEDOUT/.test(err.code || ''))
  assert.equal(requests.length, 0)
})
