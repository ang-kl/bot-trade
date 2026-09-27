// The main loop's consecutive-failure breaker, driven the way runLoop drives
// it: beginCycle → (recordFailure on a throw) → endCycle unless it backed off.
//
// 27-09-2026: loop.js zeroed the counter after every cycle that fell through
// the catch, so it never passed 1 and neither the backoff (5) nor the breaker
// (10) could fire. These tests exercise the sequencing that makes them
// reachable, with the loop's own values.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoopBreaker, clearStaleTripStampAtBoot } from './loop-breaker.js'

const MAX = 10
const BACKOFF_AFTER = 5
const CAP = 15 * 60_000
const INTERVAL = 5 * 60_000

const make = () => createLoopBreaker({ maxConsecutive: MAX, backoffAfter: BACKOFF_AFTER, backoffCapMs: CAP })

/** One cycle as runLoop runs it. Returns the failure verdict or the end verdict. */
function cycle(b, fails) {
  if (b.isTripped()) return { halted: true }
  b.beginCycle()
  if (fails) {
    const f = b.recordFailure(INTERVAL)
    if (f.backoffMs > 0) return { failure: f }   // runLoop returns before endCycle
    return { failure: f, end: b.endCycle() }
  }
  return { end: b.endCycle() }
}

test('a failing cycle below the backoff threshold keeps its count through endCycle', () => {
  const b = make()
  const r = cycle(b, true)
  assert.equal(r.failure.count, 1)
  assert.equal(r.end.clean, false)
  assert.equal(r.end.reset, false)
  assert.equal(b.count, 1, 'the failing cycle fell through to endCycle and must not be cleared by it')
})

test('N-1 consecutive failing cycles do not trip the breaker', () => {
  const b = make()
  for (let i = 0; i < MAX - 1; i++) cycle(b, true)
  assert.equal(b.count, MAX - 1)
  assert.equal(b.isTripped(), false)
  assert.equal(cycle(b, false).halted, undefined, 'the next cycle still runs')
})

test('N consecutive failing cycles trip the breaker and halt the next cycle', () => {
  const b = make()
  let last
  for (let i = 0; i < MAX; i++) last = cycle(b, true)
  assert.equal(last.failure.count, MAX)
  assert.equal(last.failure.tripped, true)
  assert.equal(b.isTripped(), true)
  assert.deepEqual(cycle(b, false), { halted: true })
})

test('the backoff starts at the 5th consecutive failing cycle, capped at 15 min', () => {
  const b = make()
  const sleeps = []
  for (let i = 0; i < MAX; i++) sleeps.push(cycle(b, true).failure.backoffMs)
  assert.deepEqual(sleeps.slice(0, BACKOFF_AFTER - 1), [0, 0, 0, 0])
  // 5 × 5 min = 25 min, above the cap: every backoff at the default interval is the cap.
  assert.ok(sleeps.slice(BACKOFF_AFTER - 1).every(ms => ms === CAP))

  const fast = make()
  const s1 = []
  for (let i = 0; i < 7; i++) { fast.beginCycle(); s1.push(fast.recordFailure(60_000).backoffMs) }
  assert.deepEqual(s1, [0, 0, 0, 0, 5 * 60_000, 6 * 60_000, 7 * 60_000])
})

test('one clean cycle resets the streak and says so', () => {
  const b = make()
  for (let i = 0; i < 3; i++) cycle(b, true)
  const r = cycle(b, false)
  assert.equal(r.end.clean, true)
  assert.equal(r.end.reset, true)
  assert.equal(r.end.was, 3)
  assert.equal(b.count, 0)
})

test('a clean cycle with no streak is not reported as a reset', () => {
  const b = make()
  const r = cycle(b, false)
  assert.equal(r.end.clean, true)
  assert.equal(r.end.reset, false)
})

test('a failure after a reset starts from 1', () => {
  const b = make()
  for (let i = 0; i < MAX - 1; i++) cycle(b, true)
  cycle(b, false)
  const r = cycle(b, true)
  assert.equal(r.failure.count, 1)
  assert.equal(r.failure.backoffMs, 0)
  assert.equal(b.count, 1)
})

test('a clean cycle after a backed-off failure resets (beginCycle clears the failed flag)', () => {
  const b = make()
  for (let i = 0; i < BACKOFF_AFTER; i++) cycle(b, true)   // last one backed off, never reached endCycle
  const r = cycle(b, false)
  assert.equal(r.end.clean, true)
  assert.equal(r.end.was, BACKOFF_AFTER)
  assert.equal(b.count, 0)
})

test('manual reset clears a tripped breaker', () => {
  const b = make()
  for (let i = 0; i < MAX; i++) cycle(b, true)
  assert.equal(b.isTripped(), true)
  b.reset()
  assert.equal(b.isTripped(), false)
  assert.equal(cycle(b, true).failure.count, 1)
})

// ---- B1: a restart must not leave a stale stamp that silences the next trip

/** The trip gate as runLoop runs it: announce (stamp) or stay silent. */
function gate(b, store, nowIso) {
  if (!b.isTripped()) return 'run'
  if (b.tripNeedsAnnouncing(store.stamp)) { store.stamp = nowIso; return 'announced' }
  return 'silent'
}

test('restart then re-trip: the boot clear lets the next trip alert again', () => {
  const store = { stamp: null }
  const p1 = make()
  for (let i = 0; i < MAX; i++) p1.recordFailure(INTERVAL, Date.parse('2026-09-27T01:00:00Z') + i)
  assert.equal(gate(p1, store, '2026-09-27T03:00:00Z'), 'announced')
  // deploy: a new process, count 0, the stamp still persisted
  const p2 = make()
  const logs = []
  const cleared = clearStaleTripStampAtBoot({ getStamp: () => store.stamp, clearStamp: () => { store.stamp = null }, log: (m) => logs.push(m) })
  assert.equal(cleared, '2026-09-27T03:00:00Z')
  assert.equal(store.stamp, null)
  assert.match(logs[0], /cleared a trip stamp/)
  for (let i = 0; i < MAX; i++) cycle(p2, true)
  assert.equal(gate(p2, store, new Date().toISOString()), 'announced', 'the second trip must stamp and alert')
})

test('boot with no stamp clears nothing and logs nothing', () => {
  const logs = []
  assert.equal(clearStaleTripStampAtBoot({ getStamp: () => null, clearStamp: () => assert.fail('cleared'), log: (m) => logs.push(m) }), null)
  assert.equal(logs.length, 0)
})

test('a stamp older than the current streak does not silence the trip', () => {
  const b = make()
  const t0 = Date.parse('2026-09-27T05:00:00Z')
  for (let i = 0; i < MAX; i++) b.recordFailure(INTERVAL, t0 + i * 60_000)
  const store = { stamp: '2026-09-27T03:00:00Z' }   // an earlier trip's
  assert.equal(gate(b, store, '2026-09-27T06:00:00Z'), 'announced')
})

test('the same trip is announced once, not on every 30-min re-check', () => {
  const b = make()
  const t0 = Date.parse('2026-09-27T05:00:00Z')
  for (let i = 0; i < MAX; i++) b.recordFailure(INTERVAL, t0 + i * 60_000)
  const store = { stamp: null }
  assert.equal(gate(b, store, '2026-09-27T06:00:00Z'), 'announced')
  assert.equal(gate(b, store, '2026-09-27T06:30:00Z'), 'silent')
  assert.equal(gate(b, store, '2026-09-27T07:00:00Z'), 'silent')
})

test('park / unpark hands back the parked timer once', () => {
  const b = make()
  assert.equal(b.unpark(), null)
  b.park(42)
  b.reset()
  assert.equal(b.unpark(), 42, 'reset leaves the parked timer for the caller to cancel')
  assert.equal(b.unpark(), null)
})
