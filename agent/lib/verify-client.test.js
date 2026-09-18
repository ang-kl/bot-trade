// PR-AR — the verifier gets a session, and a refusal is said out loud.
//
// WHAT THESE TESTS ARE FOR. Measured 18-09-2026: the backlog pass reported
// "10 captured · 0 verified" four times running, 38 records, with NO error
// line. Two defects behind it:
//
//   1. Nothing ever called POST /connect, so cpp-verify held no session
//      ("sessions":[] on its /health) and every /verify returned 409.
//   2. verify() already knew the reason and drainCaptureQueue dropped it,
//      because `if (v && v.state)` treats a null state as nothing happened.
//
// So the assertions below are as much about what gets REPORTED as about what
// gets called: a verifier that fails quietly is the failure cpp-verify exists
// to prevent, one layer out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyClient, verifyRequestFor } from './verify-client.js'

const ENV = { VERIFY_URL: 'http://verify.internal:8080', EXEC_SECRET: 's3cret' }
const CREDS = { clientId: 'cid', clientSecret: 'csec', accessToken: 'tok', accountId: 43097342 }
const RECORD = {
  account_id: '43097342', ctrader_position_id: '12345', direction: 'long',
  symbol_id: 7, volume: 100, entry_price: 1.2, exit_price: 1.3, net_pnl: 9.5,
  opened_at_ms: 1_700_000_000_000, closed_at_ms: 1_700_000_600_000,
}

/** A fetch double that records calls and replies from a scripted queue. */
function fetchStub (script) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization })
    const next = script.shift()
    if (!next) throw new Error(`unscripted call to ${url}`)
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    }
  }
  return { impl, calls }
}

const okVerdict = { state: 'verified', disputes: [], fetchComplete: true }

test('unconfigured stays unconfigured — no URL, no client', () => {
  assert.equal(verifyClient({ env: {}, fetchImpl: async () => {} }), null)
  assert.equal(verifyClient({ env: { VERIFY_URL: 'x' }, fetchImpl: async () => {} }), null,
    'a URL without EXEC_SECRET cannot authenticate, so it is not a client')
})

test('IT CONNECTS FIRST: /connect precedes /verify on the first call for a host', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1, requested: 1 } },
    { status: 200, body: okVerdict },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'demo.ctrader.com', ...CREDS })
  assert.equal(v.state, 'verified')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/connect$/, 'the session is opened before anything is asked of it')
  assert.match(calls[1].url, /\/verify$/)
  assert.equal(calls[0].body.host, 'demo.ctrader.com')
  assert.deepEqual(calls[0].body.accountIds, [43097342], 'the account is named, so I17 can authorize it')
  assert.equal(calls[0].auth, 'Bearer s3cret')
})

test('the session is opened ONCE per host, not per record', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1 } },
    { status: 200, body: okVerdict },
    { status: 200, body: okVerdict },
    { status: 200, body: okVerdict },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  for (let i = 0; i < 3; i++) await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(calls.filter(c => /\/connect$/.test(c.url)).length, 1,
    'a backlog of 60 records must not open 60 sessions')
  assert.equal(calls.filter(c => /\/verify$/.test(c.url)).length, 3)
})

test('A 409 RECONNECTS AND RETRIES ONCE — the verifier restarted under us', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1 } },   // first connect
    { status: 409, body: {} },                  // session gone
    { status: 200, body: { authorized: 1 } },   // reconnect
    { status: 200, body: okVerdict },           // retry succeeds
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(v.state, 'verified')
  assert.equal(calls.filter(c => /\/connect$/.test(c.url)).length, 2)
})

test('a SECOND 409 is reported, not retried into silence', async () => {
  const { impl } = fetchStub([
    { status: 200, body: { authorized: 1 } },
    { status: 409, body: {} },
    { status: 200, body: { authorized: 1 } },
    { status: 409, body: {} },                  // still refusing
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(v.state, null)
  assert.equal(v.skipped, 'http_409', 'the real condition surfaces instead of looping')
})

test('a 200 with ZERO authorized accounts is a failure, not a session', async () => {
  const { impl, calls } = fetchStub([{ status: 200, body: { authorized: 0, requested: 1 } }])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(v.state, null)
  assert.equal(v.skipped, 'connect_no_accounts',
    'caching this as connected would send every later /verify into a guaranteed 403')
  assert.equal(calls.length, 1, '/verify is not attempted')
})

test('a failed connect is NOT cached — the next record tries again', async () => {
  const { impl, calls } = fetchStub([
    { status: 502, body: {} },                  // connect fails
    { status: 200, body: { authorized: 1 } },   // second attempt succeeds
    { status: 200, body: okVerdict },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const first = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(first.skipped, 'connect_http_502')
  const second = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(second.state, 'verified')
  assert.equal(calls.filter(c => /\/connect$/.test(c.url)).length, 2)
})

test('missing credentials are named, not silently skipped', async () => {
  const { impl, calls } = fetchStub([])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1' })   // no clientId/secret/token
  assert.equal(v.state, null)
  assert.equal(v.skipped, 'no_credentials')
  assert.equal(calls.length, 0, 'nothing is sent without something to send')
})

test('no host is refused before any call', async () => {
  const { impl, calls } = fetchStub([])
  const verify = verifyClient({ env: { ...ENV, CTRADER_HOST: '' }, fetchImpl: impl })
  const v = await verify(RECORD, { ...CREDS })
  assert.equal(v.skipped, 'no_host')
  assert.equal(calls.length, 0)
})

test('THE ANSWER IS CARRIED, NOT INTERPRETED: a dispute comes back intact', async () => {
  const disputes = [{ field: 'entry_price', keeper: '1.23', broker: '1.2345', delta: 0.0045 }]
  const { impl } = fetchStub([
    { status: 200, body: { authorized: 1 } },
    { status: 200, body: { state: 'disputed', disputes, fetchComplete: true, broker: { entryPrice: 1.2345 } } },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(v.state, 'disputed')
  assert.deepEqual(v.disputes, disputes, 'the verifier\'s findings are relayed unchanged')
  assert.equal(v.host, 'h1')
})

test('a reply with no state is bad_reply — this client never invents a verdict', async () => {
  const { impl } = fetchStub([
    { status: 200, body: { authorized: 1 } },
    { status: 200, body: { disputes: [] } },     // no `state`
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(RECORD, { host: 'h1', ...CREDS })
  assert.equal(v.state, null)
  assert.equal(v.skipped, 'bad_reply')
})

test('the request window CONTAINS the position, slack on both sides', () => {
  const req = verifyRequestFor(RECORD, { host: 'h1' })
  assert.ok(req.fromMs < RECORD.opened_at_ms, 'opens before the position opened')
  assert.ok(req.toMs > RECORD.closed_at_ms, 'closes after it closed')
  assert.equal(req.record.positionId, 12345)
  assert.equal(req.record.tradeSide, 1, 'long is side 1')
  assert.equal(verifyRequestFor({ ...RECORD, direction: 'short' }, { host: 'h1' }).record.tradeSide, 2)
})

// CONTRACT 3 (fix-the-exits BC): the keeper stores LOTS, so the request
// carries the symbol's lotSize — and only a real one. A null/zero/absent
// lot size is OMITTED, so cpp-verify leaves the volume uncompared instead
// of dividing by a guess.
test('verifyRequestFor sends the broker lotSize with the record, and omits it when there is none', () => {
  assert.equal(verifyRequestFor({ ...RECORD, lot_size: 1000000 }, { host: 'h1' }).record.lotSize, 1000000)
  assert.equal(verifyRequestFor({ ...RECORD, lot_size: null }, { host: 'h1' }).record.lotSize, undefined)
  assert.equal(verifyRequestFor({ ...RECORD, lot_size: 0 }, { host: 'h1' }).record.lotSize, undefined)
  assert.equal(verifyRequestFor(RECORD, { host: 'h1' }).record.lotSize, undefined)
  assert.ok(!('lotSize' in JSON.parse(JSON.stringify(verifyRequestFor(RECORD, { host: 'h1' }).record))), 'absent on the wire, not null')
})

// A SKIPPED VERDICT MUST REACH THE LOG. The drain is where the reason was
// dropped, so this pins the drain rather than the client.
test('drainCaptureQueue surfaces a skipped reason as an error line', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../services/position-capture.js', import.meta.url), 'utf8'))
  const stripped = src.replace(/^\s*\/\/.*$/gm, '')     // no passing by matching prose
  assert.match(stripped, /if \(v && !v\.state && v\.skipped\) out\.errors\.push\(/,
    'a null state with a reason must be reported, not dropped')
})
