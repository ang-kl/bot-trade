// node --test agent/lib/inflight.test.js
//
// Wave 5 (first-principles audit 19-09-2026 §K item 15): the in-flight call
// registry, the pooled session's end-to-end bound and the watchdog line that
// names the stuck call.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PT } from './ctrader-payload-types.js'
import {
  beginCall, endCall, inflightCalls, oldestInflight, inflightSummary, describeSteps, describeCall,
  configureInflight, maybeStamp, INFLIGHT_KEY, STAMP_MIN_MS, fmtMs, _resetInflightForTests,
} from './inflight.js'

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

test('begin/end/oldest: calls are listed oldest first with their age; ending retires one', () => {
  _resetInflightForTests()
  const a = beginCall({ name: 'ws:A', symbol: 'EURUSD', accountId: '47790949' }, 1_000)
  const b = beginCall({ name: 'ws:B' }, 2_000)
  const list = inflightCalls(5_000)
  assert.deepEqual(list.map(c => [c.name, c.ms]), [['ws:A', 4_000], ['ws:B', 3_000]])
  assert.equal(oldestInflight(5_000).name, 'ws:A')
  assert.equal(inflightSummary(5_000).count, 2)
  endCall(a)
  assert.equal(oldestInflight(5_000).name, 'ws:B')
  endCall(b)
  endCall(b) // a double end is harmless
  assert.deepEqual(inflightSummary(5_000), { oldest: null, count: 0 })
})

test('describeCall names the call, what it is about, the account by last 4 and the age', () => {
  assert.equal(describeCall({ name: 'ws:GET_TRENDBARS_REQ', symbol: 'symbolId 1', accountId: '47790949', ms: 702_000 }), 'ws:GET_TRENDBARS_REQ symbolId 1 (…0949) for 11m42s')
  assert.equal(describeCall({ name: 'sidecar:POST /order', symbol: null, accountId: null, ms: 850 }), 'sidecar:POST /order for 850ms')
  assert.equal(describeCall(null), 'none')
  assert.equal(fmtMs(42_000), '42s')
})

test('describeSteps names the request step past the auth pair and reads the account from the auth step', () => {
  const steps = [
    { send: { payloadType: PT.APP_AUTH_REQ, payload: {} }, expect: PT.APP_AUTH_RES },
    { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: 47790949 } }, expect: PT.ACCOUNT_AUTH_RES },
    { send: { payloadType: PT.GET_TRENDBARS_REQ, payload: { ctidTraderAccountId: 47790949, symbolId: 1, period: 5 } }, expect: PT.GET_TRENDBARS_RES },
  ]
  assert.deepEqual(describeSteps(steps), { name: 'ws:GET_TRENDBARS_REQ', symbol: 'symbolId 1', accountId: '47790949' })
  // The pooled path peels the auth pair; the account comes from the caller.
  assert.deepEqual(describeSteps(steps.slice(2), 47790949), { name: 'ws:GET_TRENDBARS_REQ', symbol: 'symbolId 1', accountId: '47790949' })
  assert.deepEqual(describeSteps([{ send: { payloadType: PT.CLOSE_POSITION_REQ, payload: { positionId: 77 } } }]), { name: 'ws:CLOSE_POSITION_REQ', symbol: 'position 77', accountId: null })
  assert.equal(describeSteps(null).name, 'ws:unknown')
})

test('the stamp is throttled to once per STAMP_MIN_MS and forced by the watchdog', () => {
  _resetInflightForTests()
  const writes = []
  configureInflight({ db: { fake: true }, setState: (_db, k, v) => writes.push([k, JSON.parse(v)]) })
  beginCall({ name: 'ws:A' }, 10_000)
  assert.equal(writes.length, 1, 'the first begin stamps')
  assert.equal(writes[0][0], INFLIGHT_KEY)
  assert.equal(writes[0][1].oldest.name, 'ws:A')
  beginCall({ name: 'ws:B' }, 10_000 + STAMP_MIN_MS - 1)
  assert.equal(writes.length, 1, 'inside the window: no second write')
  beginCall({ name: 'ws:C' }, 10_000 + STAMP_MIN_MS)
  assert.equal(writes.length, 2, 'at the window: written')
  assert.equal(maybeStamp(10_000 + STAMP_MIN_MS + 1), false)
  assert.equal(maybeStamp(10_000 + STAMP_MIN_MS + 1, true), true, 'forced')
  assert.equal(writes.length, 3)
  assert.equal(writes[2][1].count, 3)
  configureInflight({})
  _resetInflightForTests()
})

test('a leaked token older than an hour is dropped on read, not reported as the oldest call forever', () => {
  _resetInflightForTests()
  beginCall({ name: 'ws:leaked' }, 0)
  beginCall({ name: 'ws:live' }, 3_600_000 + 500)
  assert.deepEqual(inflightCalls(3_600_000 + 1_000).map(c => c.name), ['ws:live'])
  _resetInflightForTests()
})

test('END-TO-END BOUND: a request queued behind a chain that never settles rejects with queued_timeout naming the call, inside the budget, and its registry entry is released', async () => {
  _resetInflightForTests()
  const { _SessionForTests } = await import('./ctrader-session.js')
  const prev = process.env.CTRADER_QUEUE_BUDGET_MS
  process.env.CTRADER_QUEUE_BUDGET_MS = '30'
  // The deadline timer is unref'd on purpose (production's tickers keep the
  // process alive; a bound must not); here nothing else is pending, so a
  // ref'd keep-alive stops node from draining the loop before it fires.
  const keepAlive = setTimeout(() => {}, 2_000)
  try {
    const s = new _SessionForTests('k', { host: 'demo.example.com', appAuth: {}, accountAuth: { ctidTraderAccountId: 47790949 }, connect: () => { throw new Error('never connects') }, log: () => {} })
    s.chain = new Promise(() => {}) // a socket that is busy forever
    const steps = [{ send: { payloadType: PT.RECONCILE_REQ, payload: { ctidTraderAccountId: 47790949 } }, expect: PT.RECONCILE_RES }]
    const t0 = Date.now()
    const p = s.run(steps, 20, false, async () => 0, () => false)
    assert.equal(inflightSummary().count, 1, 'registered while queued')
    assert.equal(inflightSummary().oldest.name, 'session:RECONCILE_REQ')
    await assert.rejects(p, (err) => {
      assert.match(err.message, /queued_timeout/)
      assert.match(err.message, /RECONCILE_REQ/)
      assert.match(err.message, /dropped unsent: it never reached the broker/)
      return true
    })
    const waited = Date.now() - t0
    assert.ok(waited < 1_000, `rejected inside the budget (took ${waited}ms; budget 20+30ms)`)
    assert.equal(inflightSummary().count, 0, 'the registry entry is released with the caller')
  } finally {
    clearTimeout(keepAlive)
    if (prev == null) delete process.env.CTRADER_QUEUE_BUDGET_MS; else process.env.CTRADER_QUEUE_BUDGET_MS = prev
    _resetInflightForTests()
  }
})

test('the watchdog line names the oldest in-flight call, or says none is registered', async () => {
  const { watchdogLine } = await import('../loop.js')
  const detail = { phase: 'scanning 1 symbols', loopCount: 7, startedAt: '2026-09-19T00:00:00Z', quietMin: 12, limitMin: 12 }
  const line = watchdogLine(detail, { oldest: { name: 'ws:GET_TRENDBARS_REQ', symbol: 'symbolId 1', accountId: '47790949', ms: 702_000 }, count: 2 })
  assert.match(line, /stuck in phase "scanning 1 symbols" — in-flight: ws:GET_TRENDBARS_REQ symbolId 1 \(…0949\) for 11m42s \(\+1 more\)/)
  assert.match(line, /loop #7/)
  assert.match(watchdogLine(detail, { oldest: null, count: 0 }), /in-flight: none registered/)
  assert.match(watchdogLine(detail, null), /in-flight: none registered/)
})

test('wiring pins: wsRun, the session run and the sidecar call are registered; /health serves inflight and fastMonitor; the watchdog prints the line and stamps', () => {
  const ws = strip(readFileSync(new URL('./ctrader-ws.js', import.meta.url), 'utf8'))
  assert.match(ws, /const token = beginCall\(describeSteps\(steps\)\)/)
  assert.match(ws, /\.finally\(\(\) => endCall\(token\)\)/)
  const session = strip(readFileSync(new URL('./ctrader-session.js', import.meta.url), 'utf8'))
  assert.match(session, /Promise\.race\(\[mine, deadline\]\)/)
  assert.match(session, /queued_timeout/)
  // Checker note 4: a pooled call is registered ONCE — wsRun registers it and
  // tells the session so.
  assert.match(ws, /registered: true,/)
  assert.match(session, /\{ registered: deps\.registered === true \}/)
  assert.match(session, /const token = registered \? null : beginCall\(/)
  const exec = strip(readFileSync(new URL('./exec-engine.js', import.meta.url), 'utf8'))
  assert.match(exec, /beginCall\(\{ name: `sidecar:\$\{method\} \$\{path\}`/)
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  assert.match(index, /inflight: inflightSummary\(\)/)
  assert.match(index, /fastMonitor: \(\(\) => \{/)
  assert.match(index, /skipShare10m: t\.skipShare10m/)
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /console\.error\(watchdogLine\(detail, inflight\)\)/)
  assert.match(loop, /configureInflight\(\{ db, setState \}\)/)
})
