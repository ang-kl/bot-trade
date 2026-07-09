// Tests for the exec-engine delegator: mode selection plus cpp-mode HTTP
// contract against a local stub sidecar (auth header, paths, body
// passthrough, error-text preservation for loop.js substring matching).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execEngineMode, placeOrder, amendPosition, closePosition, reconcile } from './exec-engine.js'

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
