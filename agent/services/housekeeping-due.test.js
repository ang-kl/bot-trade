// node --test agent/services/housekeeping-due.test.js
//
// The condition these tests replace could not be tested at all: it read
// `loopCount % 100 === 0` against module state inside a 4,000-line loop. It
// looked right, it reviewed clean, and it had not fired in production for long
// enough that 54,815 risk_events sat unsettled and a 90-day retention cutoff
// had never deleted a row.
//
// So the tests worth having here are about the RESTART, which is the whole bug.
import test from 'node:test'
import assert from 'node:assert/strict'
import { housekeepingDue, DEFAULT_INTERVAL_MS, LAST_RUN_KEY } from './housekeeping-due.js'

const NOW = Date.parse('2026-08-06T06:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

test('a restart does NOT reset the schedule — the bug, stated directly', () => {
  // THE REGRESSION. Under `loopCount % 100`, a process that restarted 2 hours
  // ago had loopCount ≈ 25 and would wait ~6 more hours; restart again and the
  // wait begins again, forever. Here the answer depends only on when the pass
  // last RAN, so a restart is invisible to it.
  const lastRan = ago(7 * 60 * 60 * 1000)          // 7h ago — not due yet
  assert.equal(housekeepingDue(lastRan, NOW), false)

  // …and the same stamp an hour later IS due, regardless of how many times the
  // process bounced in between.
  assert.equal(housekeepingDue(lastRan, NOW + 60 * 60 * 1000), true)
})

test('a database that has never run one runs immediately', () => {
  // Fresh install, and also the case this fix exists for: a backlog that
  // accumulated precisely because the pass never fired. Waiting another eight
  // hours to begin clearing it would be a strange reading of "due".
  assert.equal(housekeepingDue(null, NOW), true)
  assert.equal(housekeepingDue(undefined, NOW), true)
  assert.equal(housekeepingDue('', NOW), true)
})

test('the boundary is inclusive at exactly one interval', () => {
  assert.equal(housekeepingDue(ago(DEFAULT_INTERVAL_MS), NOW), true)
  assert.equal(housekeepingDue(ago(DEFAULT_INTERVAL_MS - 1), NOW), false)
})

test('an unreadable stamp runs rather than skips', () => {
  // Asymmetric failure modes, chosen deliberately. Treating junk as "just ran"
  // reproduces the original bug — silently never fires again. Treating it as
  // "never ran" costs one extra pass and self-corrects on the next write.
  for (const junk of ['not a date', '{}', 'null', '0000-13-45']) {
    assert.equal(housekeepingDue(junk, NOW), true, `junk=${junk}`)
  }
})

test('a stamp in the future runs rather than waiting for the future to arrive', () => {
  // Clocks move backwards — a container that booted with a fast clock, wrote a
  // stamp, then had it corrected would otherwise disable housekeeping until
  // real time caught up. That is the same silent-forever shape as the bug.
  assert.equal(housekeepingDue(new Date(NOW + 86400_000).toISOString(), NOW), true)
})

test('the interval is configurable and honoured', () => {
  const oneHour = 60 * 60 * 1000
  assert.equal(housekeepingDue(ago(90 * 60 * 1000), NOW, oneHour), true)
  assert.equal(housekeepingDue(ago(30 * 60 * 1000), NOW, oneHour), false)
})

test('the state key is exported so the caller cannot drift from it', () => {
  // Two spellings of this key would look identical in review and would mean
  // "never ran" on every single loop — a busy-loop over the retention deletes.
  assert.equal(LAST_RUN_KEY, 'housekeeping_last_at')
  assert.equal(DEFAULT_INTERVAL_MS, 8 * 60 * 60 * 1000)
})

test('the OLD condition would have failed the restart case', () => {
  // Pinned as documentation, not as a live code path: this is the arithmetic
  // that produced the outage. loopCount is 0 at import and the pass runs on
  // `% 100`, so with a ~5-minute cycle nothing fires inside eight hours of
  // uptime — and production uptime on the day this was found was 7,505s.
  const CYCLE_MIN = 5
  const uptimeSec = 7505
  const loopCountAfterRestart = Math.floor((uptimeSec / 60) / CYCLE_MIN)
  assert.ok(loopCountAfterRestart < 100, 'a 2h-old process never reaches loop 100')
  assert.notEqual(loopCountAfterRestart % 100, 0, 'so the old condition was false')
  // The replacement is true for that same process, because it asks a different
  // question: not "how long have I been up" but "when did this last happen".
  assert.equal(housekeepingDue(null, NOW), true)
})
