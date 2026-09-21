// Tests for the exec-engine delegator: mode selection plus cpp-mode HTTP
// contract against a local stub sidecar (auth header, paths, body
// passthrough, error-text preservation for loop.js substring matching).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execEngineMode, placeOrder, stripLedgerFields, amendPosition, closePosition, cancelOrder, reconcile, backtestRemote, validateOrderBracket, orderHasBracket, orderHasTarget, validateExecGuard, execBaseFor, invalidateSidecarSession,
  _resetOrderLocks, sidecarQuotes,
} from './exec-engine.js'

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
      // /connect always succeeds — it just sets credentials, never depends on
      // reconcile state. Every test that wants a FAILING call is testing the
      // actual operation (order/positions/etc), never the credential push.
      // nextResponse may be an ARRAY to serve different replies in sequence
      // (e.g. POST /positions 404 → GET /positions fallback).
      const resp = req.url === '/connect'
        ? { status: 200, body: '{}' }
        : (Array.isArray(nextResponse) ? (nextResponse.length > 1 ? nextResponse.shift() : nextResponse[0]) : nextResponse)
      res.writeHead(resp.status, { 'content-type': 'application/json' })
      res.end(resp.body)
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
  // The order-idempotency lock is process-global and 60s wide by design, so
  // without this a test inherits the previous test's dispatch and is refused
  // for a duplicate it never sent. Cleared per test rather than per file so no
  // case can quietly depend on another's lock state.
  _resetOrderLocks()
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
  const payload = { symbolId: 41, tradeSide: 'BUY', volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000 }
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
    // Roster-less creds still push a one-entry roster — the sidecar treats it
    // exactly like the legacy single-account push, and the set-memo needs the
    // account recorded so later callers naming it are recognised as served.
    accountIds: [String(CREDS.accountId)],
  })
  assert.equal(requests[1].method, 'POST')
  assert.equal(requests[1].url, '/order')
  assert.equal(requests[1].auth, 'Bearer sekret')
  // The body is the payload PLUS the account, stamped by exec-engine's
  // withAccount(). Phase 2: the sidecar's own primary-account default
  // (engine.cpp:276-280) must be unreachable from Node, because it silently
  // mis-routed every exit on a non-primary account. See
  // agent/multi-account-routing.characterisation.test.js.
  assert.deepEqual(JSON.parse(requests[1].body), { ...payload, ctidTraderAccountId: 123 })
})

test('cpp amendPosition: POST /amend with args passthrough', async () => {
  const args = { positionId: 7, stopLoss: 1.1, takeProfit: 1.2 }
  await amendPosition(CREDS, args)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/amend')
  assert.equal(requests[0].auth, 'Bearer sekret')
  // args + the stamped account — see the /order test above.
  assert.deepEqual(JSON.parse(requests[0].body), { ...args, ctidTraderAccountId: 123 })
})

test('cpp closePosition: POST /close with args passthrough', async () => {
  const args = { positionId: 7, volume: 100000 }
  await closePosition(CREDS, args)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/close')
  // args + the stamped account — see the /order test above.
  assert.deepEqual(JSON.parse(requests[0].body), { ...args, ctidTraderAccountId: 123 })
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

test('cpp reconcile: POST /positions with the account id, returns parsed JSON', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ position: [{ positionId: 1 }] }) }
  const out = await reconcile(CREDS)
  const req = requests[requests.length - 1]
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/positions')
  assert.deepEqual(JSON.parse(req.body), { ctidTraderAccountId: 123 })
  assert.deepEqual(out, { position: [{ positionId: 1 }] })
})

test('cpp reconcile: 404 from an OLD sidecar binary falls back to legacy GET /positions', async () => {
  nextResponse = [
    { status: 404, body: '{"error":"not found"}' },
    { status: 200, body: JSON.stringify({ position: [{ positionId: 7 }] }) },
  ]
  const out = await reconcile(CREDS)
  assert.deepEqual(out, { position: [{ positionId: 7 }] })
  const [post, get] = requests.filter(r => r.url === '/positions')
  assert.equal(post.method, 'POST')
  assert.equal(get.method, 'GET')
})

test('cpp multi-account connect: accountIds roster forwarded to the sidecar', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ position: [] }) }
  await reconcile({ ...CREDS, accessToken: 'fresh-token', accountIds: ['123', '456'] })
  const connect = requests.find(r => r.url === '/connect')
  assert.ok(connect, 'roster change must re-push /connect')
  assert.deepEqual(JSON.parse(connect.body).accountIds, ['123', '456'])
})

test('bracket guarantee: a naked MARKET order is refused before it reaches the broker', async () => {
  // Engine-agnostic parity guard (mirrors cpp-exec/order_guard). Applies in
  // BOTH modes — a market order with no stop never leaves the process.
  for (const mode of ['cpp', 'js']) {
    if (mode === 'js') delete process.env.EXEC_ENGINE; else process.env.EXEC_ENGINE = 'cpp'
    requests = []
    await assert.rejects(
      placeOrder(CREDS, { symbolId: 1, tradeSide: 'BUY', volume: 100 }),
      (err) => { assert.match(err.message, /guard_naked_order/); return true },
    )
    assert.equal(requests.length, 0, 'a naked order must not reach the sidecar/broker')
  }
  process.env.EXEC_ENGINE = 'cpp'
})

test('bracket guarantee: validateOrderBracket + orderHasBracket cover the cases', () => {
  assert.equal(orderHasBracket({ relativeStopLoss: 5 }), true)
  assert.equal(orderHasBracket({ stopLoss: 1.23 }), true)
  assert.equal(orderHasBracket({ volume: 100 }), false)
  assert.equal(validateOrderBracket({ orderType: 'MARKET', volume: 100 }).ok, false)
  assert.equal(validateOrderBracket({ orderType: 'MARKET', volume: 100, allowNaked: true }).ok, false, 'allowNaked cannot waive TP1')
  assert.equal(validateOrderBracket({ orderType: 'MARKET', volume: 100, allowNaked: true, relativeTakeProfit: 5 }).ok, true)
  assert.equal(validateOrderBracket({ orderType: 'LIMIT', volume: 100 }).ok, false, 'resting entries can fill and must be protected')
  assert.equal(validateOrderBracket({ orderType: 'LIMIT', volume: 100, relativeStopLoss: 5, relativeTakeProfit: 5 }).ok, true)
  assert.equal(validateOrderBracket({ orderType: 'STOP', volume: 100, relativeStopLoss: 5 }).ok, false, 'stop entries require TP1')
  assert.equal(validateOrderBracket({ orderType: 'STOP_LIMIT', volume: 100, relativeStopLoss: 5 }).ok, false, 'stop-limit entries require TP1')
  assert.equal(validateOrderBracket({ orderType: 2, volume: 100, relativeStopLoss: 5 }).ok, false, 'numeric LIMIT enum requires TP1')
  assert.equal(validateOrderBracket({ orderType: 3, volume: 100, relativeStopLoss: 5 }).ok, false, 'numeric STOP enum requires TP1')
  for (const type of [4, 999, 2.5, true, '2']) {
    assert.match(validateOrderBracket({ orderType: type, relativeStopLoss: 5, relativeTakeProfit: 5 }).reason, /^guard_bad_payload/)
  }
  assert.equal(validateOrderBracket({ volume: 100, relativeStopLoss: 5, relativeTakeProfit: 5 }).ok, true)
})

test('target guarantee: an SL-only market order (no TP) is refused — "a few open trades didn\'t set T/P" (owner-approved 2026-07-22)', () => {
  assert.equal(orderHasTarget({ relativeTakeProfit: 5 }), true)
  assert.equal(orderHasTarget({ takeProfit: 1.23 }), true)
  assert.equal(orderHasTarget({ volume: 100 }), false)
  const v = validateOrderBracket({ orderType: 'MARKET', volume: 100, relativeStopLoss: 5 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /guard_no_target/)
  assert.equal(validateOrderBracket({ orderType: 'MARKET', volume: 100, relativeStopLoss: 5, allowNaked: true }).ok, false, 'allowNaked cannot waive TP1')
  assert.equal(validateOrderBracket({ orderType: 'LIMIT', volume: 100, relativeStopLoss: 5 }).ok, false, 'resting entries require TP1 too')
})

test('exec guard: halt kill switch refuses orders in BOTH engine modes (5A parity with cpp order_guard)', async () => {
  const halted = { ...CREDS, execGuard: { halt: true } }
  const payload = { symbolId: 1, tradeSide: 'BUY', volume: 100, relativeStopLoss: 5, relativeTakeProfit: 5 }
  for (const mode of ['cpp', 'js']) {
    if (mode === 'js') delete process.env.EXEC_ENGINE; else process.env.EXEC_ENGINE = 'cpp'
    requests = []
    await assert.rejects(placeOrder(halted, payload), (err) => {
      assert.match(err.message, /guard_halt/)
      return true
    })
    assert.equal(requests.length, 0, 'a halted order must never leave the process')
  }
  process.env.EXEC_ENGINE = 'cpp'
})

test('exec guard: volume cap refuses oversized orders; verdicts mirror order_guard.cpp', async () => {
  // Pure-function verdicts, same reason strings the C++ guard emits.
  assert.equal(validateExecGuard({ volume: 100 }, null).ok, true)
  assert.equal(validateExecGuard({ volume: 100 }, {}).ok, true)
  assert.equal(validateExecGuard({ volume: 100 }, { maxOrderVolume: 0 }).ok, true) // 0 = no cap
  assert.equal(validateExecGuard({ volume: 100 }, { maxOrderVolume: 100 }).ok, true) // at cap = allowed
  const over = validateExecGuard({ volume: 101 }, { maxOrderVolume: 100 })
  assert.equal(over.ok, false)
  assert.match(over.reason, /guard_volume_cap/)
  const halted = validateExecGuard({ volume: 1 }, { halt: true })
  assert.equal(halted.ok, false)
  assert.match(halted.reason, /guard_halt/)

  // And the chokepoint enforces it before any network call.
  requests = []
  await assert.rejects(
    placeOrder({ ...CREDS, execGuard: { maxOrderVolume: 100 } },
      { symbolId: 1, tradeSide: 'BUY', volume: 200, relativeStopLoss: 5, relativeTakeProfit: 5 }),
    (err) => { assert.match(err.message, /guard_volume_cap/); return true },
  )
  assert.equal(requests.length, 0)
  // Within the cap → goes through as normal.
  nextResponse = { status: 200, body: '{"ok":true}' }
  const out = await placeOrder({ ...CREDS, execGuard: { maxOrderVolume: 100 } },
    { symbolId: 1, tradeSide: 'BUY', volume: 100, relativeStopLoss: 5, relativeTakeProfit: 5 })
  assert.deepEqual(out, { ok: true })
})

test('cpp error mapping preserves broker text: order rejected', async () => {
  nextResponse = { status: 422, body: 'order rejected: MARKET_CLOSED' }
  await assert.rejects(placeOrder(CREDS, { symbolId: 1, relativeStopLoss: 50000, relativeTakeProfit: 50000 }), (err) => {
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

test('cpp reconcile: "no reconcile data yet" falls back to the JS/WS path instead of failing', async () => {
  // Owner hit this live: the sidecar hadn't completed its first reconcile
  // pass, so GET /positions 503s every time — which took out BOTH
  // pending-order-manager (hard failure every tick) and weekend-bank's
  // heartbeat (never reached because the main loop's own reconcile call
  // threw first). The fallback delegates to ctrader-ws instead of
  // propagating the sidecar's "not ready yet" as a hard error — proven the
  // same way the "js mode delegates" tests prove delegation: a bogus host
  // makes the ws layer fail at the network level, which could only happen
  // if the fallback path was actually reached.
  nextResponse = { status: 503, body: '{"error":"no reconcile data yet"}' }
  const p = reconcile({ ...CREDS, host: '127.0.0.1' })
  await assert.rejects(p, (err) => /ECONNREFUSED|ETIMEDOUT|socket|closed|handshake|connect/i.test(err.message) || /ECONNREFUSED|ETIMEDOUT/.test(err.code || ''))
  // The sidecar was still tried first (connect push + the /positions 503).
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url, '/positions')
})

test('cpp reconcile: any OTHER sidecar error still throws — only "no reconcile data yet" falls back', async () => {
  nextResponse = { status: 500, body: 'sidecar exploded' }
  await assert.rejects(reconcile(CREDS), (err) => {
    assert.match(err.message, /sidecar exploded/)
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
  const p = placeOrder({ ...CREDS, host: '127.0.0.1' }, { symbolId: 1, relativeStopLoss: 50000, relativeTakeProfit: 50000 })
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

// ---------------------------------------------------------------------------
// THE ROSTER pingSidecar USED TO DROP.
//
// The sidecar has always reported its authorised accounts on GET /health, but
// pingSidecar built its return object field-by-field and never copied them. So
// heartbeat.js's rosterDrift(r.accounts, …) compared against `undefined` on
// every single probe: `missing` was always the whole registry, drift was ALWAYS
// true, the broker session was re-pushed every ~2 minutes, and `extra` —
// authorisation the owner REVOKED, the direction that actually matters — could
// never fire at all. The drift check looked like it worked only because an
// unconditional re-push does converge the roster.
//
// The existing heartbeat tests could not catch this: they stub pingSidecar with
// an `accounts` key, i.e. they fake the very field production was missing. This
// test drives the REAL function against a fake fetch, which is the only place
// the omission was visible.
// ---------------------------------------------------------------------------
test('pingSidecar surfaces the authorised roster from /health', async () => {
  const prevEngine = process.env.EXEC_ENGINE
  const prevUrl = process.env.EXEC_URL
  const prevFetch = globalThis.fetch
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL = 'http://sidecar.test'
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true, connected: true, hasCredentials: true,
      lastReconcileAt: 1785386613987,
      accounts: [46130058, 46979908],
    }),
  })
  try {
    const { pingSidecar } = await import('./exec-engine.js')
    const r = await pingSidecar()
    assert.deepEqual(r.accounts, [46130058, 46979908])
    assert.equal(r.connected, true)
    assert.equal(r.ok, true)
  } finally {
    globalThis.fetch = prevFetch
    if (prevEngine === undefined) delete process.env.EXEC_ENGINE; else process.env.EXEC_ENGINE = prevEngine
    if (prevUrl === undefined) delete process.env.EXEC_URL; else process.env.EXEC_URL = prevUrl
  }
})

test('pingSidecar reports a MISSING roster as null, not as an empty roster', async () => {
  // An old sidecar that does not report `accounts` must read as "unknown", so
  // rosterDrift stays quiet instead of concluding the sidecar holds nothing.
  const prevEngine = process.env.EXEC_ENGINE
  const prevUrl = process.env.EXEC_URL
  const prevFetch = globalThis.fetch
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL = 'http://sidecar.test'
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, connected: true }) })
  try {
    const { pingSidecar } = await import('./exec-engine.js')
    const r = await pingSidecar()
    assert.equal(r.accounts, null)
  } finally {
    globalThis.fetch = prevFetch
    if (prevEngine === undefined) delete process.env.EXEC_ENGINE; else process.env.EXEC_ENGINE = prevEngine
    if (prevUrl === undefined) delete process.env.EXEC_URL; else process.env.EXEC_URL = prevUrl
  }
})

// ---------------------------------------------------------------------------
// THE ROUTING SEAM (two-sidecar plan, Phase 1).
//
// One ExecEngine holds one broker host for its whole life, so live and demo
// accounts cannot share a sidecar process. `execBase()` was a no-arg global
// returning ONE url — there was no way for Node to even NAME the demo
// account's sidecar, which is why the outage of 05-08 (four demo accounts
// enabled, none authorised, twelve hours without a trade) had no expressible
// fix on this side.
//
// Two properties are worth testing and they pull in opposite directions:
//   · with only EXEC_URL set, NOTHING changes — that is what makes this phase
//     deployable ahead of the second process;
//   · with both set, a demo call must never touch the live sidecar, including
//     its credential push and its memo.
// ---------------------------------------------------------------------------

test('execBaseFor: with only EXEC_URL set, every host resolves to the same base', () => {
  const prev = { u: process.env.EXEC_URL, l: process.env.EXEC_URL_LIVE, d: process.env.EXEC_URL_DEMO }
  delete process.env.EXEC_URL_LIVE
  delete process.env.EXEC_URL_DEMO
  process.env.EXEC_URL = 'http://only-one:8091'
  try {
    assert.equal(execBaseFor('live.ctraderapi.com'), 'http://only-one:8091')
    assert.equal(execBaseFor('demo.ctraderapi.com'), 'http://only-one:8091')
    assert.equal(execBaseFor({ host: 'demo.ctraderapi.com' }), 'http://only-one:8091')
    // No creds, unknown host, empty host — all the default. Node never decides
    // a host is illegitimate; the sidecar refuses a host that disagrees with
    // its own, which is enforcement at the boundary rather than a guess here.
    assert.equal(execBaseFor(), 'http://only-one:8091')
    assert.equal(execBaseFor('nonsense.example'), 'http://only-one:8091')
    assert.equal(execBaseFor({}), 'http://only-one:8091')
    assert.equal(execBaseFor({ host: '' }), 'http://only-one:8091')
  } finally {
    for (const [k, v] of Object.entries({ EXEC_URL: prev.u, EXEC_URL_LIVE: prev.l, EXEC_URL_DEMO: prev.d })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('execBaseFor: each side goes to its own base when configured, case-insensitively', () => {
  const prev = { u: process.env.EXEC_URL, l: process.env.EXEC_URL_LIVE, d: process.env.EXEC_URL_DEMO }
  process.env.EXEC_URL = 'http://default:8091'
  process.env.EXEC_URL_LIVE = 'http://live-sidecar:8091'
  process.env.EXEC_URL_DEMO = 'http://demo-sidecar:8091'
  try {
    assert.equal(execBaseFor('live.ctraderapi.com'), 'http://live-sidecar:8091')
    assert.equal(execBaseFor('DEMO.CtraderAPI.com'), 'http://demo-sidecar:8091')
    assert.equal(execBaseFor(' demo.ctraderapi.com '), 'http://demo-sidecar:8091')
    // One side configured, the other not: the unconfigured side keeps today's
    // single-sidecar base rather than becoming unreachable.
    delete process.env.EXEC_URL_DEMO
    assert.equal(execBaseFor('demo.ctraderapi.com'), 'http://default:8091')
    assert.equal(execBaseFor('live.ctraderapi.com'), 'http://live-sidecar:8091')
  } finally {
    for (const [k, v] of Object.entries({ EXEC_URL: prev.u, EXEC_URL_LIVE: prev.l, EXEC_URL_DEMO: prev.d })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('two sidecars: a demo order reaches the demo sidecar and NEVER the live one', async () => {
  // Two stub sidecars on two ports. The assertion that matters is the negative
  // one: `live.length === 0`. Routing that merely "usually" picks the right
  // process would place a demo order on a live account.
  const seen = { live: [], demo: [] }
  const mk = (bucket) => http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen[bucket].push({ url: req.url, body: raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  const liveSrv = mk('live')
  const demoSrv = mk('demo')
  await new Promise(r => liveSrv.listen(0, '127.0.0.1', r))
  await new Promise(r => demoSrv.listen(0, '127.0.0.1', r))
  const prev = { l: process.env.EXEC_URL_LIVE, d: process.env.EXEC_URL_DEMO }
  process.env.EXEC_URL_LIVE = `http://127.0.0.1:${liveSrv.address().port}`
  process.env.EXEC_URL_DEMO = `http://127.0.0.1:${demoSrv.address().port}`
  process.env.EXEC_ENGINE = 'cpp'
  invalidateSidecarSession()
  const entry = { symbolId: 41, tradeSide: 'BUY', volume: 100, relativeStopLoss: 5, relativeTakeProfit: 5 }
  try {
    await placeOrder({ ...CREDS, host: 'demo.ctraderapi.com', accountId: '111' }, entry)
    assert.deepEqual(seen.live, [], 'a demo order must not touch the live sidecar at all — not even its /connect')
    assert.deepEqual(seen.demo.map(r => r.url), ['/connect', '/order'])

    // The live side gets its OWN credential push. A scalar memo would have let
    // the demo push satisfy this check, and the live sidecar would then serve
    // an order having never been sent any credentials.
    await placeOrder({ ...CREDS, host: 'live.ctraderapi.com', accountId: '222' }, entry)
    assert.deepEqual(seen.live.map(r => r.url), ['/connect', '/order'])
    assert.equal(seen.demo.length, 2, 'the live order must not have re-touched the demo sidecar')
    assert.equal(JSON.parse(seen.live[1].body).ctidTraderAccountId, 222)
    assert.equal(JSON.parse(seen.demo[1].body).ctidTraderAccountId, 111)

    // And the memo still works per side: a repeat on demo re-pushes nothing.
    //
    // This repeat is the SUBJECT of the assertion, and in production it is
    // exactly what Invariant 3 refuses — the same account, symbol, side and
    // strategy inside the 60s window is the DOW.US signature. The lock is
    // cleared here so the session-memo property can still be tested; that it
    // has to be cleared is the lock working, not the lock being wrong.
    _resetOrderLocks()
    await placeOrder({ ...CREDS, host: 'demo.ctraderapi.com', accountId: '111' }, entry)
    assert.deepEqual(seen.demo.map(r => r.url), ['/connect', '/order', '/order'])
  } finally {
    invalidateSidecarSession()
    liveSrv.close(); demoSrv.close()
    for (const [k, v] of Object.entries({ EXEC_URL_LIVE: prev.l, EXEC_URL_DEMO: prev.d })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('sidecarRoster caches per base — one sidecar\'s roster is not evidence about the other\'s', async () => {
  const prevFetch = globalThis.fetch
  const prev = { e: process.env.EXEC_ENGINE, l: process.env.EXEC_URL_LIVE, d: process.env.EXEC_URL_DEMO }
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL_LIVE = 'http://live.test'
  process.env.EXEC_URL_DEMO = 'http://demo.test'
  const byHost = { 'http://live.test': [42993489], 'http://demo.test': [43097342, 46130058] }
  globalThis.fetch = async (url) => {
    const base = String(url).replace('/health', '')
    return { ok: true, json: async () => ({ ok: true, connected: true, accounts: byHost[base] ?? [] }) }
  }
  try {
    const { sidecarRoster } = await import('./exec-engine.js')
    const live = await sidecarRoster({ base: execBaseFor('live.ctraderapi.com') })
    const demo = await sidecarRoster({ base: execBaseFor('demo.ctraderapi.com') })
    assert.deepEqual(live, ['42993489'])
    // Before this was keyed by base, the demo call inside the 20s TTL returned
    // the LIVE roster — which reads as "the demo accounts are disconnected",
    // the exact wrong answer during the outage this seam exists to fix.
    assert.deepEqual(demo, ['43097342', '46130058'])
  } finally {
    globalThis.fetch = prevFetch
    for (const [k, v] of Object.entries({ EXEC_ENGINE: prev.e, EXEC_URL_LIVE: prev.l, EXEC_URL_DEMO: prev.d })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('sidecarRosterForSide: each side asks its OWN sidecar; one base makes the second free', async () => {
  const prevFetch = globalThis.fetch
  const prev = { e: process.env.EXEC_ENGINE, u: process.env.EXEC_URL, l: process.env.EXEC_URL_LIVE, d: process.env.EXEC_URL_DEMO }
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL_LIVE = 'http://live.test'
  process.env.EXEC_URL_DEMO = 'http://demo.test'
  const hits = []
  const byBase = { 'http://live.test': [42993489], 'http://demo.test': [43097342, 46130058] }
  globalThis.fetch = async (url) => {
    const base = String(url).replace('/health', '')
    hits.push(base)
    return { ok: true, json: async () => ({ ok: true, connected: true, accounts: byBase[base] ?? [] }) }
  }
  try {
    const { sidecarRostersBySide } = await import('./exec-engine.js')
    const r = await sidecarRostersBySide({ ttlMs: 0 })
    assert.deepEqual(r.live, ['42993489'])
    // Before this existed, the demo accounts were measured against the LIVE
    // sidecar's roster, found absent, and skipped at loop.js's connectivity
    // gate — the 05-08 outage, rebuilt by the split that was meant to fix it.
    assert.deepEqual(r.demo, ['43097342', '46130058'])
    assert.deepEqual(hits, ['http://live.test', 'http://demo.test'])

    // Single-base config: both sides resolve to one URL, and the 20s cache
    // makes the second lookup free rather than a second HTTP probe.
    delete process.env.EXEC_URL_LIVE
    delete process.env.EXEC_URL_DEMO
    process.env.EXEC_URL = 'http://one.test'
    byBase['http://one.test'] = [1, 2]
    hits.length = 0
    const one = await sidecarRostersBySide()
    assert.deepEqual(one.live, ['1', '2'])
    assert.deepEqual(one.demo, ['1', '2'])
    assert.equal(hits.length, 1, 'one base = one probe, not two')
  } finally {
    globalThis.fetch = prevFetch
    for (const [k, v] of Object.entries({ EXEC_ENGINE: prev.e, EXEC_URL: prev.u, EXEC_URL_LIVE: prev.l, EXEC_URL_DEMO: prev.d })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

// ---------------------------------------------------------------------------
// ACCEPTANCE 2.6.3 — Order Idempotency Lock.
//
// The plan asks: "simulate 20 concurrent duplicate HTTP POSTs; verify 1 order
// executes and 19 return DUPLICATE_ORDER_DISPATCH_BLOCKED".
//
// The production event this stands for is the 17 × DOW.US SELL that landed on
// account 46130058 inside 89 milliseconds. 89ms is the whole difficulty: any
// guard that reads state, awaits, and then writes has a window that wide to be
// raced through. The lock is claimed AFTER `withAccount` (so the key carries
// the resolved account) and BEFORE the first `await` — which on a single JS
// thread makes the check-and-set atomic, no mutex required.
//
// Fired with Promise.all so all 20 are in flight before any of them resolves;
// a sequential loop would pass even against a guard that only worked because
// each call had already finished.
// ---------------------------------------------------------------------------

test('2.6.3 — 20 concurrent identical dispatches: 1 order, 19 DUPLICATE_ORDER_DISPATCH_BLOCKED', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ ok: true, positionId: 7 }) }
  const payload = {
    symbolId: 41, tradeSide: 'SELL', volume: 100000,
    relativeStopLoss: 50000, relativeTakeProfit: 50000,
    label: 'bot|x|donchian_breakout',
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, () => placeOrder(CREDS, { ...payload }).then(
      (ok) => ({ ok }),
      (err) => ({ err }),
    )),
  )

  const sent = results.filter(r => r.ok)
  const blocked = results.filter(r => r.err)
  assert.equal(sent.length, 1, 'exactly one dispatch may reach the broker')
  assert.equal(blocked.length, 19)
  for (const b of blocked) {
    assert.equal(b.err.code, 'DUPLICATE_ORDER_DISPATCH_BLOCKED')
    assert.match(b.err.message, /idempotency lock/)
  }
  // The count that actually matters is at the wire, not in the return values:
  // one /connect plus exactly one /order.
  assert.deepEqual(requests.map(r => r.url), ['/connect', '/order'])
})

test('2.6.3 — the lock is keyed on the ORDER, not on the burst', async () => {
  // A different symbol, side or strategy inside the same 60s window is a
  // different trade and must still go through — otherwise the guard against
  // seventeen duplicates would also block the sixteen legitimate entries a
  // busy cycle can produce.
  nextResponse = { status: 200, body: '{"ok":true}' }
  const base = { volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000 }
  await placeOrder(CREDS, { ...base, symbolId: 41, tradeSide: 'SELL', label: 'bot|x|donchian_breakout' })
  await placeOrder(CREDS, { ...base, symbolId: 42, tradeSide: 'SELL', label: 'bot|x|donchian_breakout' })
  await placeOrder(CREDS, { ...base, symbolId: 41, tradeSide: 'BUY', label: 'bot|x|donchian_breakout' })
  await placeOrder(CREDS, { ...base, symbolId: 41, tradeSide: 'SELL', label: 'bot|x|fvg_strategy' })
  assert.equal(requests.filter(r => r.url === '/order').length, 4)

  // …and the fifth, identical to the first, is refused.
  await assert.rejects(
    placeOrder(CREDS, { ...base, symbolId: 41, tradeSide: 'SELL', label: 'bot|x|donchian_breakout' }),
    (err) => err.code === 'DUPLICATE_ORDER_DISPATCH_BLOCKED',
  )
  assert.equal(requests.filter(r => r.url === '/order').length, 4, 'nothing more reached the wire')
})

// P1b (11-09-2026): the per-account entry fence is re-checked at the last
// Node boundary. A refusing fence stops the order before /connect, before
// the lock, before any transport; an admitting one changes nothing.
test('placeOrder: a refusing creds.entryAdmission throws ENTRY_MODE_REFUSED before any sidecar call', async () => {
  const creds = { ...CREDS, producerId: 'scan_dispatch', entryAdmission: () => ({ ok: false, reason: 'entry_mode_stopped' }) }
  const payload = { symbolId: 41, tradeSide: 'BUY', volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000 }
  await assert.rejects(() => placeOrder(creds, payload), (err) => err.code === 'ENTRY_MODE_REFUSED' && /entry_mode_stopped/.test(err.message) && /scan_dispatch/.test(err.message))
  assert.equal(requests.length, 0, 'nothing reached the sidecar, not even /connect')
})

test('placeOrder: an admitting creds.entryAdmission is transparent', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ ok: true, positionId: 11 }) }
  const creds = { ...CREDS, producerId: 'scan_dispatch', entryAdmission: async () => ({ ok: true, modeEpoch: 3 }) }
  const payload = { symbolId: 42, tradeSide: 'SELL', volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000 }
  const out = await placeOrder(creds, payload)
  assert.deepEqual(out, { ok: true, positionId: 11 })
  assert.equal(requests.at(-1).url, '/order')
})

// ---------------------------------------------------------------------------
// P2a (11-09-2026): the intent ledger at the send. With a ledger on the
// credentials every entry is reserved and redeemed before any transport, the
// permit and intent id travel to the sidecar (and never to the JS wire), and
// the intent is settled from the order's own outcome — UNKNOWN when that
// outcome was never learned.
// ---------------------------------------------------------------------------
function fakeLedger({ reserveOk = true, redeemOk = true, reason = 'intent_open: UNKNOWN i1' } = {}) {
  const calls = { reserve: [], redeem: [], sent: [], resolved: [] }
  const permit = { id: 'p000000000001', intentId: 'i000000000001', accountId: '123', environment: 'demo', symbolId: 41, side: 'BUY', volume: 100000, epoch: 3, expiresAtMs: Date.now() + 30_000 }
  return {
    calls, permit,
    ledger: {
      reserve: (o) => { calls.reserve.push(o); return reserveOk ? { ok: true, intentId: permit.intentId, permit } : { ok: false, reason } },
      redeem: (id) => { calls.redeem.push(id); return redeemOk ? { ok: true } : { ok: false, reason: 'permit_consumed: DISPATCHING' } },
      markSent: (id, o) => { calls.sent.push({ id, ...o }); return { ok: true } },
      resolve: (id, o) => { calls.resolved.push({ id, ...o }); return { ok: true } },
    },
  }
}
const ORDER = { symbolId: 41, tradeSide: 'BUY', orderType: 'MARKET', volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000, label: 'AU|v1|VWAP|H|LN|4h|TR' }

test('placeOrder with a ledger: reserve, redeem, send with the permit and a tagged label, then FILLED from the response', async () => {
  const fx = fakeLedger()
  nextResponse = { status: 200, body: '{"executionType":"ORDER_FILLED","position":{"positionId":777},"order":{"orderId":555}}' }
  const creds = { ...CREDS, producerId: 'scan_dispatch', entryAdmission: () => ({ ok: true }), entryLedger: fx.ledger }
  const r = await placeOrder(creds, { ...ORDER, symbolId: 61 })
  assert.equal(r.position.positionId, 777)
  assert.equal(fx.calls.reserve.length, 1); assert.equal(fx.calls.reserve[0].symbolId, 61); assert.equal(fx.calls.reserve[0].side, 'BUY'); assert.equal(fx.calls.reserve[0].volume, 100000)
  assert.deepEqual(fx.calls.redeem, ['p000000000001'])
  assert.equal(fx.calls.sent.length, 1); assert.equal(fx.calls.sent[0].id, 'i000000000001')
  const sent = JSON.parse(requests.filter(q => q.url === '/order').at(-1).body)
  assert.equal(sent.intentId, 'i000000000001'); assert.equal(sent.permit.id, 'p000000000001'); assert.equal(sent.permit.epoch, 3); assert.equal(sent.permit.accountId, 123)
  assert.equal(sent.label, 'AU|v1|VWAP|H|LN|4h|TR|i000000000001', 'the label carries the intent tag')
  // WHOLE-PLAN AUDIT 11-09-2026 (plan §9): the permit binds the bracket the order carries
  assert.equal(sent.permit.relativeStopLoss, 50000); assert.equal(sent.permit.relativeTakeProfit, 50000); assert.equal('stopLoss' in sent.permit, false)
  assert.deepEqual(fx.calls.resolved, [{ id: 'i000000000001', state: 'FILLED', positionId: 777, brokerOrderId: 555, source: 'response' }])
})

test('placeOrder with a ledger: a refused reservation throws ENTRY_LEDGER_REFUSED before any transport and releases the lock; a refused redeem throws ENTRY_PERMIT_REFUSED', async () => {
  const before = requests.filter(q => q.url === '/order').length
  const refused = fakeLedger({ reserveOk: false })
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: refused.ledger }, { ...ORDER, symbolId: 62 }),
    (err) => err.code === 'ENTRY_LEDGER_REFUSED' && /intent_open: UNKNOWN i1/.test(err.message) && /scan_dispatch/.test(err.message))
  assert.equal(requests.filter(q => q.url === '/order').length, before, 'nothing reached the sidecar')
  assert.equal(refused.calls.redeem.length, 0); assert.equal(refused.calls.sent.length, 0)
  // the lock was released: the same order with an admitting ledger goes through at once
  nextResponse = { status: 200, body: '{"position":{"positionId":1}}' }
  const ok = fakeLedger()
  await placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: ok.ledger }, { ...ORDER, symbolId: 62 })
  assert.equal(requests.filter(q => q.url === '/order').length, before + 1)
  const noRedeem = fakeLedger({ redeemOk: false })
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: noRedeem.ledger }, { ...ORDER, symbolId: 63 }),
    (err) => err.code === 'ENTRY_PERMIT_REFUSED' && /permit_consumed/.test(err.message))
  assert.equal(requests.filter(q => q.url === '/order').length, before + 1)
})

test('placeOrder with a ledger: a definite rejection settles REJECTED, an unanswered send settles UNKNOWN — never FILLED, never released', async () => {
  const rej = fakeLedger()
  nextResponse = { status: 502, body: '{"error":"order rejected: TRADING_BAD_VOLUME"}' }
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: rej.ledger }, { ...ORDER, symbolId: 64 }))
  assert.equal(rej.calls.resolved.length, 1); assert.equal(rej.calls.resolved[0].state, 'REJECTED'); assert.match(rej.calls.resolved[0].errorCode, /TRADING_BAD_VOLUME/)
  const unk = fakeLedger()
  nextResponse = { status: 502, body: '{"error":"TIMEOUT: no payloadType 2126 within 20000ms"}' }
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: unk.ledger }, { ...ORDER, symbolId: 65 }))
  assert.equal(unk.calls.resolved.length, 1); assert.equal(unk.calls.resolved[0].state, 'UNKNOWN'); assert.equal(unk.calls.resolved[0].source, 'response')
  assert.equal(unk.calls.sent.length, 1, 'SENT was recorded before the transport')
})

test('placeOrder without a ledger behaves as before, and stripLedgerFields keeps ledger fields off the JS wire', async () => {
  nextResponse = { status: 200, body: '{"position":{"positionId":2}}' }
  const before = requests.filter(q => q.url === '/order').length
  await placeOrder(CREDS, { ...ORDER, symbolId: 66 })
  const sent = JSON.parse(requests.filter(q => q.url === '/order').at(-1).body)
  assert.equal(requests.filter(q => q.url === '/order').length, before + 1)
  assert.equal(sent.intentId, undefined); assert.equal(sent.permit, undefined); assert.equal(sent.label, ORDER.label)
  assert.deepEqual(stripLedgerFields({ a: 1, permit: { id: 'p' }, intentId: 'i', signalRef: 'r', symbolName: 'EURUSD' }), { a: 1 })
  assert.deepEqual(stripLedgerFields(null), {})
})

test('placeOrder with a ledger: a TIMEOUT from the sidecar keeps its clientMsgId on the UNKNOWN intent; a pacer refusal releases it', async () => {
  const to = fakeLedger()
  nextResponse = { status: 502, body: '{"errorCode":"TIMEOUT","description":"no payloadType 2126 within 20000ms","clientMsgId":"cx4242"}' }
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: to.ledger }, { ...ORDER, symbolId: 67 }))
  assert.equal(to.calls.resolved.length, 1); assert.equal(to.calls.resolved[0].state, 'UNKNOWN'); assert.equal(to.calls.resolved[0].clientMsgId, 'cx4242')
  const rl = fakeLedger()
  nextResponse = { status: 502, body: '{"errorCode":"rate_limited","description":"the connection\'s request budget is spent (40/s, 25% reserved for protection) — not sent"}' }
  await assert.rejects(() => placeOrder({ ...CREDS, producerId: 'scan_dispatch', entryLedger: rl.ledger }, { ...ORDER, symbolId: 68 }))
  assert.equal(rl.calls.resolved.length, 1); assert.equal(rl.calls.resolved[0].state, 'RELEASED')
})

test('19-09-2026 sidecarQuotes: GET /quotes with the bearer and the ids filter, parsed body back; a failing answer or js mode is null', async () => {
  nextResponse = { status: 200, body: JSON.stringify({ feed: 'up', generation: 3, count: 1, quotes: [{ symbolId: 41, bid: 1.1, ask: 1.1002, tsMs: 1, recvMs: 2 }] }) }
  const r = await sidecarQuotes(false, { ids: [41, 7, 'x', 0] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].url, '/quotes?ids=41,7', 'only positive numeric ids travel')
  assert.equal(requests[0].auth, 'Bearer sekret')
  assert.deepEqual(r, { feed: 'up', generation: 3, accountId: null, nowMs: null, count: 1, quotes: [{ symbolId: 41, bid: 1.1, ask: 1.1002, tsMs: 1, recvMs: 2 }] }, 'an older sidecar: no accountId, no nowMs')
  nextResponse = { status: 200, body: JSON.stringify({ feed: 'up', generation: 3, accountId: 4002, nowMs: 1_700_000_000_000, count: 0, quotes: [] }) }
  assert.deepEqual(await sidecarQuotes(false), { feed: 'up', generation: 3, accountId: '4002', nowMs: 1_700_000_000_000, count: 0, quotes: [] }, 'the feed account (the id space) and the sidecar clock ride along')
  // no ids → no query string
  await sidecarQuotes(null)
  assert.equal(requests[1].url, '/quotes')
  // an absent feed is a body, not a failure — the caller reads feed:"absent"
  nextResponse = { status: 200, body: '{"feed":"absent","generation":0,"count":0,"quotes":[]}' }
  assert.deepEqual(await sidecarQuotes(true), { feed: 'absent', generation: 0, accountId: null, nowMs: null, count: 0, quotes: [] })
  // a sidecar that predates the route (404), a wrong shape, and js mode are null
  nextResponse = { status: 404, body: '{"error":"not found"}' }
  assert.equal(await sidecarQuotes(false), null)
  nextResponse = { status: 200, body: '{"ok":true}' }
  assert.equal(await sidecarQuotes(false), null, 'a body without feed is not a quotes answer')
  process.env.EXEC_ENGINE = 'js'
  const before = requests.length
  assert.equal(await sidecarQuotes(false), null)
  assert.equal(requests.length, before, 'js mode makes no HTTP call')
})
