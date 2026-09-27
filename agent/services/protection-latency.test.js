// node --test agent/services/protection-latency.test.js
//
// V3 M5 (P1/P4-6): the amend-latency ring itself — what one amend records,
// what it may never record, how it is bounded, summarised and persisted. The
// call sites are pinned in their own modules' test files (one per amend path)
// and in agent/amend-latency-wiring.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  measureAmend, recordAmend, noteDueLateness, latenessEligibility, amendLatencySummary,
  persistAmendLatency, loadAmendLatency, classifyAmendResult, classifyAmendError, errorCodeOf,
  accountSuffix, buildAmendEntry, AMEND_LATENCY_KEY, AMEND_RING_SIZE, LATENESS_RING_SIZE,
  PERSIST_MIN_MS, PERSIST_IDLE_MS, MIN_N_P95, _resetAmendLatencyForTests, _amendLatencyStateForTests,
} from './protection-latency.js'

/** A clock the test moves by hand: wall and monotonic from one counter. */
function fakeClock(start = 1_758_800_000_000) {
  let t = start
  return { now: () => t, clock: () => t, advance: (ms) => { t += ms } }
}
const META = { path: 'loss_guardian', source: 'loss_guardian', accountId: '43002148', positionId: '700123' }

test('an answered amend is recorded with its round trip, path, source and account suffix — and returned untouched', async () => {
  _resetAmendLatencyForTests()
  const c = fakeClock()
  const answer = { executionType: 'ORDER_REPLACED' }
  const got = await measureAmend(META, async () => { c.advance(412); return answer }, c)
  assert.equal(got, answer, 'the caller receives the very object the amend returned')
  const [e] = _amendLatencyStateForTests().amends
  assert.equal(e.path, 'loss_guardian')
  assert.equal(e.source, 'loss_guardian')
  assert.equal(e.account, '…2148', 'the account suffix only')
  assert.equal(e.positionId, '700123')
  assert.equal(e.ms, 412)
  assert.equal(e.ackAtMs - e.sentAtMs, 412)
  assert.equal(e.outcome, 'ok')
  assert.equal(e.errorCode, null)
})

test('outcomes: refused, already closed, empty, timeout and error are told apart, and a throw is re-thrown as the SAME error', async () => {
  _resetAmendLatencyForTests()
  const c = fakeClock()
  await measureAmend(META, async () => ({ error: 'TRADING_BAD_STOPS: stop 1.23456 is too close' }), c)
  await measureAmend(META, async () => ({ alreadyClosed: true, reason: 'POSITION_NOT_FOUND', rawError: 'x' }), c)
  await measureAmend(META, async () => undefined, c)
  const slow = new Error('amend timed out after 15000 ms')
  await assert.rejects(measureAmend(META, async () => { c.advance(15_000); throw slow }, c), (err) => err === slow)
  const bad = new Error('INVALID_REQUEST: Order price = 3101.801785714286 has more digits than allowed')
  await assert.rejects(measureAmend(META, () => { throw bad }, c), (err) => err === bad)
  const outs = _amendLatencyStateForTests().amends.map(e => [e.outcome, e.errorCode])
  assert.deepEqual(outs, [
    ['refused', 'TRADING_BAD_STOPS'],
    ['already_closed', 'POSITION_NOT_FOUND'],
    ['empty', null],
    ['timeout', null],
    ['error', 'INVALID_REQUEST'],
  ])
  assert.equal(_amendLatencyStateForTests().amends[3].ms, 15_000, 'a timeout keeps its elapsed time')
  // Only the broker-answered amend would count toward the round trip — none here.
  assert.equal(amendLatencySummary().all.roundTripMs.n, 0)
  assert.equal(amendLatencySummary().all.attemptMaxMs, 15_000)
})

test('no credentials, no prices, no message text reach the record — only fixed fields', async () => {
  _resetAmendLatencyForTests()
  const c = fakeClock()
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
  await measureAmend({ ...META, accessToken: token, clientSecret: 'shh-secret', stopLoss: 1.08765, takeProfit: 1.1234 },
    async () => ({ error: `rejected for Bearer ${token} at 1.08765` }), c)
  await assert.rejects(measureAmend(META, async () => { throw new Error(`clientSecret=shh-secret price 2.918 ${token}`) }, c))
  const stored = JSON.stringify(_amendLatencyStateForTests().amends)
  for (const bad of [token, 'shh-secret', '1.08765', '1.1234', '2.918', 'Bearer', 'rejected', 'accessToken', 'stopLoss']) {
    assert.ok(!stored.includes(bad), `the record must not carry ${bad}`)
  }
  assert.ok(!stored.includes('43002148'), 'the full account id is not kept, only its suffix')
  assert.deepEqual(Object.keys(buildAmendEntry({ ...META, sentAtMs: 1, ackAtMs: 2, ms: 1, outcome: 'ok', password: 'p' })).sort(),
    ['account', 'ackAtMs', 'at', 'boot', 'errorCode', 'ms', 'outcome', 'path', 'positionId', 'sentAtMs', 'source'])
})

test('the ring is bounded: the newest AMEND_RING_SIZE amends are kept', () => {
  _resetAmendLatencyForTests()
  for (let i = 0; i < AMEND_RING_SIZE + 44; i++) recordAmend({ ...META, sentAtMs: 1000 + i, ackAtMs: 1000 + i, ms: i, outcome: 'ok' })
  const { amends } = _amendLatencyStateForTests()
  assert.equal(amends.length, AMEND_RING_SIZE)
  assert.equal(amends[0].ms, 44, 'the oldest 44 were dropped')
  assert.equal(amends.at(-1).ms, AMEND_RING_SIZE + 43)
})

test('an unknown path or outcome cannot widen the record', () => {
  const e = buildAmendEntry({ path: 'something_new', outcome: 'great', source: 'x y;z', ms: 5 })
  assert.equal(e.path, '(other)')
  assert.equal(e.outcome, 'error')
  assert.equal(e.source, 'unknown', 'a source that is not a writer name is not kept, cleaned or otherwise')
  assert.equal(buildAmendEntry({ positionId: '12 34' }).positionId, null)
})

test('the composite: due → evaluated lateness + evaluated → sent + round trip, fast monitor only', async () => {
  _resetAmendLatencyForTests()
  const c = fakeClock()
  const evaluatedAtMs = c.now()
  const dueAtMs = evaluatedAtMs - 30_000
  c.advance(250) // the digits lookup before the send
  await measureAmend({ ...META, path: 'broker_action.move_sl', source: 'fast_monitor', dueAtMs, evaluatedAtMs },
    async () => { c.advance(900); return {} }, c)
  // A path with no due time records its round trip and no composite.
  await measureAmend({ ...META, path: 'broker_action.move_sl', source: 'position_manager' }, async () => { c.advance(700); return {} }, c)
  const [fast, slow] = _amendLatencyStateForTests().amends
  assert.equal(fast.latenessMs, 30_000)
  assert.equal(fast.preSendMs, 250)
  assert.equal(fast.ms, 900)
  assert.equal(fast.compositeMs, 31_150)
  assert.equal(slow.compositeMs, undefined)
  const s = amendLatencySummary(c.now())
  assert.equal(s.composite.n, 1)
  assert.equal(s.composite.compositeMs.max, 31_150)
  assert.equal(s.byPath['broker_action.move_sl'].roundTripMs.n, 2)
  assert.equal(s.byPath['broker_action.move_sl'].roundTripMs.max, 900)
})

test('summary: p50/p95/p99/max and n; p95/p99 flagged unverifiable below their sample; the native trail engine is always named Not Verifiable', () => {
  _resetAmendLatencyForTests()
  for (let i = 1; i <= MIN_N_P95 - 1; i++) recordAmend({ ...META, sentAtMs: i, ackAtMs: i, ms: i * 10, outcome: 'ok' })
  let s = amendLatencySummary()
  assert.equal(s.all.roundTripMs.n, MIN_N_P95 - 1)
  assert.equal(s.all.roundTripMs.p50, 100)
  assert.equal(s.all.roundTripMs.max, 190)
  assert.equal(s.all.roundTripMs.p95Verifiable, false)
  // Below its minimum a percentile is not served as a number (merge-check nit, 26-09).
  assert.equal(s.all.roundTripMs.p95, null)
  assert.equal(s.all.roundTripMs.p99, null)
  assert.ok(s.notVerifiable.some(x => /cpp_trail_engine/.test(x.what)))
  assert.ok(s.notVerifiable.some(x => /p95\/p99/.test(x.what) && /19 broker-answered/.test(x.why)))
  recordAmend({ ...META, sentAtMs: 99, ackAtMs: 99, ms: 5000, outcome: 'ok' })
  s = amendLatencySummary()
  assert.equal(s.all.roundTripMs.n, MIN_N_P95)
  assert.equal(s.all.roundTripMs.p95Verifiable, true)
  assert.equal(s.all.roundTripMs.p99Verifiable, false)
  assert.equal(typeof s.all.roundTripMs.p95, 'number', 'at its minimum p95 is served')
  assert.equal(s.all.roundTripMs.p99, null, 'p99 still below its minimum')
  assert.equal(s.all.roundTripMs.max, 5000)
  assert.ok(s.notVerifiable.some(x => /cpp_trail_engine/.test(x.what)), 'still named with a full sample')
  assert.equal(s.recent.length, 10)
})

test('book_stop: the read-back confirmation is summarised beside the round trip', () => {
  _resetAmendLatencyForTests()
  recordAmend({ path: 'book_stop', source: 'momentum_book', sentAtMs: 1, ackAtMs: 2, ms: 300, outcome: 'ok', confirm: 'readback_confirmed', confirmMs: 900, readbackMs: 400 })
  recordAmend({ path: 'book_stop', source: 'momentum_book', sentAtMs: 3, ackAtMs: 4, ms: 320, outcome: 'ok', confirm: 'readback_failed' })
  const s = amendLatencySummary()
  assert.deepEqual({ ...s.byPath.book_stop.readback, confirmMs: s.byPath.book_stop.readback.confirmMs.max },
    { confirmed: 1, mismatch: 0, failed: 1, confirmMs: 900 })
})

test('lateness: eligible evaluations are kept, the rest are counted apart by reason', () => {
  _resetAmendLatencyForTests()
  assert.deepEqual(latenessEligibility(undefined), { eligible: false, reason: 'first_seen' })
  assert.deepEqual(latenessEligibility({ nextDueAt: 'x', lastOutcome: 'quote_unavailable', state: 'quote_unavailable' }), { eligible: false, reason: 'after_no_quote' })
  assert.deepEqual(latenessEligibility({ nextDueAt: 'x', lastOutcome: 'evaluated', state: 'manage_off' }), { eligible: false, reason: 'after_other' })
  assert.deepEqual(latenessEligibility({ nextDueAt: 'x', lastOutcome: 'evaluated', state: 'not_due' }), { eligible: true })
  const now = 1_758_800_000_000
  assert.equal(noteDueLateness({ dueAtMs: now - 12_000, evaluatedAtMs: now, eligible: true }), true)
  assert.equal(noteDueLateness({ dueAtMs: now + 500, evaluatedAtMs: now, eligible: true }), true, 'early reads as 0, never negative')
  assert.equal(noteDueLateness({ dueAtMs: now - 172_800_000, evaluatedAtMs: now, eligible: false, reason: 'after_no_quote' }), false)
  assert.equal(noteDueLateness({ dueAtMs: NaN, evaluatedAtMs: now, eligible: true }), false)
  const s = amendLatencySummary(now)
  assert.equal(s.dueLateness.all.n, 2)
  assert.equal(s.dueLateness.all.max, 12_000, 'the weekend gap after a no-quote pass is not in the distribution')
  assert.equal(s.dueLateness.last10m.n, 2)
  assert.deepEqual(s.dueLateness.excluded, { first_seen: 0, after_no_quote: 1, after_other: 1 })
  for (let i = 0; i < LATENESS_RING_SIZE + 10; i++) noteDueLateness({ dueAtMs: now, evaluatedAtMs: now + i, eligible: true })
  assert.equal(_amendLatencyStateForTests().lateness.length, LATENESS_RING_SIZE)
})

test('persistence: at most once per 30 s, only when an amend arrived (lateness alone waits 5 min), never throws', () => {
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  const t0 = 1_758_800_000_000
  assert.equal(persistAmendLatency(db, { nowMs: t0 }).reason, 'nothing new')
  recordAmend({ ...META, sentAtMs: t0, ackAtMs: t0, ms: 10, outcome: 'ok' })
  assert.equal(persistAmendLatency(db, { nowMs: t0 }).written, true)
  recordAmend({ ...META, sentAtMs: t0, ackAtMs: t0, ms: 20, outcome: 'ok' })
  assert.equal(persistAmendLatency(db, { nowMs: t0 + PERSIST_MIN_MS - 1 }).reason, 'throttled')
  assert.equal(persistAmendLatency(db, { nowMs: t0 + PERSIST_MIN_MS }).written, true)
  noteDueLateness({ dueAtMs: t0, evaluatedAtMs: t0 + 5, eligible: true })
  assert.equal(persistAmendLatency(db, { nowMs: t0 + 2 * PERSIST_MIN_MS }).reason, 'nothing new', 'lateness alone rides the idle cadence')
  assert.equal(persistAmendLatency(db, { nowMs: t0 + PERSIST_MIN_MS + PERSIST_IDLE_MS }).written, true)
  const stored = JSON.parse(getState(db, AMEND_LATENCY_KEY))
  assert.equal(stored.entries.length, 2)
  assert.deepEqual(stored.lateness, [[t0 + 5, 5]])
  db.close()
  assert.equal(persistAmendLatency(db, { force: true }).written, false, 'a closed database is an error returned, not thrown')
})

test('a restart keeps the evidence: the stored ring seeds the new process, each entry keeping its boot', async () => {
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  const c = fakeClock()
  await measureAmend(META, async () => { c.advance(111); return {} }, c)
  noteDueLateness({ dueAtMs: c.now() - 7000, evaluatedAtMs: c.now(), eligible: true })
  persistAmendLatency(db, { nowMs: c.now(), force: true })
  const priorBoot = _amendLatencyStateForTests().amends[0].boot
  // A new process: empty rings, then one amend before the stored copy loads.
  _resetAmendLatencyForTests()
  c.advance(60_000)
  await measureAmend({ ...META, path: 'trade_guard', source: 'trade_guard' }, async () => { c.advance(222); return {} }, c)
  assert.equal(loadAmendLatency(db), true)
  assert.equal(loadAmendLatency(db), false, 'once per process')
  const { amends, lateness } = _amendLatencyStateForTests()
  assert.deepEqual(amends.map(e => [e.path, e.ms, e.account]), [['loss_guardian', 111, '…2148'], ['trade_guard', 222, '…2148']], 'oldest first, the stored one kept')
  assert.equal(amends[0].boot, priorBoot)
  assert.equal(lateness.length, 1)
  db.close()
})

test('a hand-edited stored copy cannot smuggle fields into the ring', () => {
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  // STORED_FIELDS order: sentAtMs, ackAtMs, ms, path, source, account, positionId, outcome, errorCode, boot, …
  setState(db, AMEND_LATENCY_KEY, JSON.stringify({ version: 1, entries: [
    [4, 5, 3, 'loss_guardian', 'loss_guardian accessToken=leak', '…2148', '700;leak', 'ok', 'price 1.2345', 'b1', null, null, null, null, null, 'extra-leak'],
    [null, 'nope', 3, 'loss_guardian', 'x', null, null, 'ok'],
    [6, 6, 3, 'loss_guardian', 'x', null, null, 'fabulous'],
    [6, 6, 3, 'invented_path', 'x', null, null, 'ok'],
    { at: 7, path: 'loss_guardian', outcome: 'ok', ms: 3 },
  ], lateness: [[1, 2], ['x', 3]] }))
  loadAmendLatency(db)
  const { amends, lateness } = _amendLatencyStateForTests()
  assert.equal(amends.length, 1)
  const json = JSON.stringify(amends)
  for (const bad of ['leak', '1.2345', 'accessToken']) assert.ok(!json.includes(bad), `must not carry ${bad}`)
  assert.deepEqual([amends[0].source, amends[0].account, amends[0].positionId, amends[0].errorCode, amends[0].ms],
    ['unknown', '…2148', null, null, 3])
  assert.deepEqual(lateness, [[1, 2]])
  db.close()
})

test('the stored record stays bounded with both rings full', () => {
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  const t0 = 1_758_800_000_000
  for (let i = 0; i < AMEND_RING_SIZE; i++) {
    recordAmend({ path: 'broker_action.move_sl', source: 'fast_monitor', accountId: '43002148', positionId: String(1_000_000_000 + i),
      sentAtMs: t0 + i, ackAtMs: t0 + i + 999, ms: 999, outcome: i % 5 ? 'ok' : 'refused', errorCode: 'TRADING_BAD_STOPS',
      dueAtMs: t0 - 40_000, evaluatedAtMs: t0 - 10 })
  }
  for (let i = 0; i < LATENESS_RING_SIZE; i++) noteDueLateness({ dueAtMs: t0, evaluatedAtMs: t0 + 43_050 + i, eligible: true })
  persistAmendLatency(db, { nowMs: t0, force: true })
  const bytes = Buffer.byteLength(getState(db, AMEND_LATENCY_KEY))
  assert.ok(bytes < 64 * 1024, `stored ${bytes} B`)
  // …and the packed form round-trips to the same entries.
  _resetAmendLatencyForTests()
  const before = JSON.parse(getState(db, AMEND_LATENCY_KEY)).entries.length
  loadAmendLatency(db)
  const back = _amendLatencyStateForTests().amends
  assert.equal(back.length, before)
  assert.equal(back[0].compositeMs, 40_000 - 10 + 10 + 999, 'derived fields are rebuilt on load')
  db.close()
})

test('pure helpers', () => {
  assert.equal(classifyAmendResult({}), 'ok')
  assert.equal(classifyAmendResult({ ok: false }), 'refused')
  assert.equal(classifyAmendResult({ rawError: 'x' }), 'refused')
  assert.equal(classifyAmendResult(null), 'empty')
  assert.equal(classifyAmendError(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout')
  assert.equal(classifyAmendError(new Error('book protection read deadline exceeded')), 'timeout')
  assert.equal(classifyAmendError(new Error('socket hang up')), 'error')
  assert.equal(errorCodeOf('nothing here 1.2345', 'MARKET_CLOSED now'), 'MARKET_CLOSED')
  assert.equal(errorCodeOf(undefined, 42), null)
  assert.equal(accountSuffix(null), null)
  assert.equal(accountSuffix(42993489), '…3489')
})
