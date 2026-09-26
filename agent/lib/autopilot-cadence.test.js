// node --test agent/lib/autopilot-cadence.test.js
//
// V3 I2: the autopilot's cadence moved out of services/strategy-autopilot.js
// so the heartbeat can read it without an import cycle. These pin that the
// move changed nothing for the evaluator and that the new instant-aware
// questions answer for the instant asked, not the clock.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  BUSY_MS, CALM_MS, autopilotMode, isBusyWindow, autopilotIntervalMs,
  autopilotRecordCadenceSec, autopilotDormantReason, hourInTz,
} from './autopilot-cadence.js'
import * as evaluator from '../services/strategy-autopilot.js'
import { getActiveSessions } from './sessions.js'

test('strategy-autopilot re-exports the very same functions — one cadence, not two', () => {
  assert.equal(evaluator.autopilotIntervalMs, autopilotIntervalMs)
  assert.equal(evaluator.isBusyWindow, isBusyWindow)
  assert.equal(evaluator.autopilotMode, autopilotMode)
})

test('autopilotIntervalMs answers for the instant asked: NY busy, Tokyo 08–13 JST busy, otherwise calm', () => {
  const db = initDB(':memory:')
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T15:00:00Z') }), BUSY_MS)  // NY
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T02:00:00Z') }), BUSY_MS)  // 11:00 JST
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T10:00:00Z') }), CALM_MS)  // London, 19:00 JST
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T13:27:00Z') }), CALM_MS)  // before the NY open
  // Injected sessions / hour still win over `now`, as before the move.
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T10:00:00Z'), sessions: [{ label: 'New York' }], tokyoHour: 3 }), BUSY_MS)
  setState(db, 'autopilot_interval_ms', String(45 * 60_000))
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T15:00:00Z') }), 45 * 60_000)
  setState(db, 'autopilot_interval_ms', String(60_000)) // below the 5-min floor: ignored
  assert.equal(autopilotIntervalMs(db, { now: new Date('2026-09-25T15:00:00Z') }), BUSY_MS)
})

test('getActiveSessions and hourInTz take an instant and still default to the clock', () => {
  const labels = getActiveSessions(new Date('2026-09-25T15:00:00Z')).map(s => s.label)
  assert.deepEqual(labels.sort(), ['London', 'New York'])
  assert.equal(hourInTz('Asia/Tokyo', new Date('2026-09-25T02:00:00Z')), 11)
  assert.deepEqual(getActiveSessions().map(s => s.label), getActiveSessions(new Date()).map(s => s.label))
})

test('autopilotRecordCadenceSec takes the larger of the cadence at the stamp and now', () => {
  const db = initDB(':memory:')
  const calm = Date.parse('2026-09-25T13:33:39Z')
  const busy = Date.parse('2026-09-25T14:00:30Z')
  assert.equal(autopilotRecordCadenceSec(db, { nowMs: busy, recordAtMs: calm }), 1800)   // calm stamp, busy now
  assert.equal(autopilotRecordCadenceSec(db, { nowMs: calm, recordAtMs: busy - 3600_000 }), 1800)
  assert.equal(autopilotRecordCadenceSec(db, { nowMs: busy + 600_000, recordAtMs: busy }), 600) // both busy
  assert.equal(autopilotRecordCadenceSec(db, { nowMs: busy, recordAtMs: 0 }), 600, 'a 0 stamp is judged by now')
  assert.equal(autopilotRecordCadenceSec(db, { nowMs: busy, recordAtMs: null }), 600)
})

test('autopilotDormantReason: only the owner mode off is dormant', () => {
  const db = initDB(':memory:')
  assert.match(autopilotDormantReason(db), /autopilot_mode is off/)
  setState(db, 'autopilot_mode', 'auto')
  assert.equal(autopilotDormantReason(db), null)
  setState(db, 'autopilot_mode', 'suggest')
  assert.equal(autopilotDormantReason(db), null)
})
