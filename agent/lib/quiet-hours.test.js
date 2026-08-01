// node --test agent/lib/quiet-hours.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekendQuietNow, quietUntilMs, recommendableToday } from './quiet-hours.js'

// SGT = UTC+8. Helper: an SGT wall-clock instant as ms epoch.
const sgt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

test('weekend quiet spans Saturday 00:00 SGT to Monday 01:00 SGT', () => {
  assert.equal(weekendQuietNow(sgt(2026, 7, 31, 23, 59)), false) // Friday night
  assert.equal(weekendQuietNow(sgt(2026, 8, 1, 0, 0)), true)     // Saturday 00:00
  assert.equal(weekendQuietNow(sgt(2026, 8, 1, 12, 0)), true)    // Saturday noon
  assert.equal(weekendQuietNow(sgt(2026, 8, 2, 23, 0)), true)    // Sunday evening
  assert.equal(weekendQuietNow(sgt(2026, 8, 3, 0, 59)), true)    // Monday 00:59
  assert.equal(weekendQuietNow(sgt(2026, 8, 3, 1, 0)), false)    // Monday 01:00 — Sydney prep
  assert.equal(weekendQuietNow(sgt(2026, 8, 5, 12, 0)), false)   // Wednesday
})

test('quietUntilMs answers Monday 01:00 SGT from anywhere in the window', () => {
  const mondayOne = sgt(2026, 8, 3, 1, 0)
  assert.equal(quietUntilMs(sgt(2026, 8, 1, 5, 0)), mondayOne)   // from Saturday
  assert.equal(quietUntilMs(sgt(2026, 8, 2, 22, 0)), mondayOne)  // from Sunday
  assert.equal(quietUntilMs(sgt(2026, 8, 3, 0, 30)), mondayOne)  // from Monday 00:30
  assert.equal(quietUntilMs(sgt(2026, 8, 4, 10, 0)), null)       // Tuesday: not quiet
})

test('recommendableToday: open now, opens today, opens tomorrow, unknown', () => {
  const now = sgt(2026, 8, 3, 9, 0) // Monday 09:00 SGT
  assert.equal(recommendableToday({ open: true }, now), true)
  // NYSE-style: opens Monday 21:30 SGT — same SGT day → recommendable.
  assert.equal(recommendableToday({ open: false, next_open_at: sgt(2026, 8, 3, 21, 30) }, now), true)
  // Market shut until Tuesday → not recommendable today.
  assert.equal(recommendableToday({ open: false, next_open_at: sgt(2026, 8, 4, 9, 0) }, now), false)
  // Unknown hours fail OPEN — never silently mute a symbol forever.
  assert.equal(recommendableToday(null, now), true)
  assert.equal(recommendableToday({ open: false }, now), true)
  assert.equal(recommendableToday({ open: false, nextOpenAt: '2026-08-03T13:30:00Z' }, now), true) // ISO string, 21:30 SGT
})
