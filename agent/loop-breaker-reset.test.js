// B2 (27-09-2026): a manual breaker reset must resume the parked loop without
// the watchdog exiting the process. The tripped path never stamps loop
// activity, so after 30+ min parked a reset that only cleared the count left
// the watchdog reading "idle past the limit" and calling process.exit(1).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resetCircuitBreaker, loopActivityAt, loopBreakerForTest, watchdogVerdict } from './loop.js'

const MID = 12 * 60_000
const IDLE = 30 * 60_000

test('a reset after 31 min parked resumes the loop and the watchdog stays quiet', () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-27T06:00:00Z') })
  try {
    let parkedFired = false
    // The real re-check is 30 min; a longer one here so moving the clock past
    // 30 min does not fire it before the reset gets to cancel it.
    const parkedTimer = setTimeout(() => { parkedFired = true }, 120 * 60_000)
    loopBreakerForTest.park(parkedTimer)
    const parkedAt = Date.now()
    mock.timers.setTime(parkedAt + 31 * 60_000)

    // Before the reset: the watchdog's reading of this state, untripped, is an exit.
    const before = watchdogVerdict({ quietMs: Date.now() - Math.min(loopActivityAt(), parkedAt), loopRunning: false, midCycleMs: MID, idleMs: IDLE, tripped: false })
    assert.equal(before, 'exit', 'precondition: an idle loop past 30 min with the breaker cleared is an exit')

    let scheduled = 0
    const r = resetCircuitBreaker({ schedule: () => { scheduled++ } })
    assert.equal(r.resumed, true)
    assert.equal(scheduled, 1, 'the parked loop is resumed promptly')
    const quiet = Date.now() - loopActivityAt()
    assert.ok(quiet < 1000, `loop activity refreshed by the reset (quiet ${quiet}ms)`)
    assert.equal(watchdogVerdict({ quietMs: quiet, loopRunning: false, midCycleMs: MID, idleMs: IDLE, tripped: loopBreakerForTest.isTripped() }), 'ok')
    mock.timers.tick(180 * 60_000)
    assert.equal(parkedFired, false, 'the parked re-check was cancelled, not left as a second chain')
  } finally {
    mock.timers.reset()
  }
})

test('a reset while the loop is not parked does not start a second cycle chain', () => {
  let scheduled = 0
  const r = resetCircuitBreaker({ schedule: () => { scheduled++ } })
  assert.equal(r.resumed, false)
  assert.equal(scheduled, 0)
})

test('the watchdog holds while this process is tripped, exits on a real stall', () => {
  assert.equal(watchdogVerdict({ quietMs: 45 * 60_000, loopRunning: false, midCycleMs: MID, idleMs: IDLE, tripped: true }), 'tripped')
  assert.equal(watchdogVerdict({ quietMs: 45 * 60_000, loopRunning: false, midCycleMs: MID, idleMs: IDLE, tripped: false }), 'exit')
  assert.equal(watchdogVerdict({ quietMs: 13 * 60_000, loopRunning: true, midCycleMs: MID, idleMs: IDLE, tripped: false }), 'exit')
  assert.equal(watchdogVerdict({ quietMs: 11 * 60_000, loopRunning: true, midCycleMs: MID, idleMs: IDLE, tripped: false }), 'ok')
})

// Re-check of 27a5b2b: park() ran only after `await hbeat` / `await
// notifyBreaker`, so a reset during the announcement found nothing parked and
// did not resume. The announcement below is held open until after the reset.
test('a reset issued while the trip announcement is pending still resumes the loop', async () => {
  const { mkdtempSync } = await import('./test-support/temp-dir.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const { initDB, getState } = await import('./db.js')
  const { parkTripped } = await import('./loop.js')
  const db = initDB(path.join(mkdtempSync(path.join(os.tmpdir(), 'loopbrk-')), 'agent.db'))

  loopBreakerForTest.reset()
  loopBreakerForTest.unpark()
  for (let i = 0; i < 10; i++) { loopBreakerForTest.beginCycle(); loopBreakerForTest.recordFailure(60_000) }
  assert.equal(loopBreakerForTest.isTripped(), true)

  let releaseBeat
  const beatHeld = new Promise(resolve => { releaseBeat = resolve })
  const notes = []
  let parkedFired = false
  const pending = parkTripped(db, {
    beat: () => beatHeld,
    notify: (t) => { notes.push(t); return new Promise(() => {}) },   // Telegram that never answers
    reschedule: () => setTimeout(() => { parkedFired = true }, 50),
  })

  // The announcement is in flight: the stamp is written, the beat has not returned.
  assert.ok(getState(db, 'circuit_breaker_tripped_at'), 'the trip was stamped')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /CIRCUIT BREAKER/)

  let scheduled = 0
  const r = resetCircuitBreaker({ schedule: () => { scheduled++ } })
  assert.equal(r.resumed, true, 'the reset found the parked timer')
  assert.equal(scheduled, 1, 'and resumed the loop')

  releaseBeat()
  await pending   // resolves although notify never does: Telegram is not awaited
  assert.equal(loopBreakerForTest.unpark(), null, 'nothing is left parked after the gate finishes')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(parkedFired, false, 'the parked re-check was cancelled')
  db.close()
})
