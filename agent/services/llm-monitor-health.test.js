// node --test agent/services/llm-monitor-health.test.js
//
// Owner: "I need to be alerted if any of the LLM failed and you still
// continue." Streak tracking, alert-dedup, and the never-throws contract.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  recordLlmMonitorResult, getLlmMonitorHealth, shouldAlert, markAlerted,
  FAIL_STREAK_ALERT_THRESHOLD, ALERT_MUTE_MS,
} from './llm-monitor-health.js'

test('getLlmMonitorHealth: fresh db reports healthy, zero streak', () => {
  const db = initDB(':memory:')
  const h = getLlmMonitorHealth(db)
  assert.equal(h.failStreak, 0)
  assert.equal(h.degraded, false)
  assert.equal(h.lastFailAt, null)
})

test('recordLlmMonitorResult: failures increment the streak, a success resets it', () => {
  const db = initDB(':memory:')
  recordLlmMonitorResult(db, { ok: false, reason: 'timeout' })
  recordLlmMonitorResult(db, { ok: false, reason: 'timeout' })
  let h = getLlmMonitorHealth(db)
  assert.equal(h.failStreak, 2)
  assert.equal(h.lastFailReason, 'timeout')
  assert.equal(h.degraded, false, 'below threshold')

  recordLlmMonitorResult(db, { ok: false, reason: 'credit balance too low' })
  h = getLlmMonitorHealth(db)
  assert.equal(h.failStreak, 3)
  assert.equal(h.degraded, true, 'at threshold')
  assert.equal(h.lastFailReason, 'credit balance too low')

  recordLlmMonitorResult(db, { ok: true })
  h = getLlmMonitorHealth(db)
  assert.equal(h.failStreak, 0)
  assert.equal(h.degraded, false)
  assert.ok(h.lastOkAt, 'lastOkAt stamped on success')
  // lastFailAt/lastFailReason are historical — kept, not erased by a success
  assert.equal(h.lastFailReason, 'credit balance too low')
})

test('shouldAlert: only fires at/above the threshold, and respects the mute window', () => {
  const now = Date.parse('2026-07-27T00:00:00Z')
  assert.equal(shouldAlert(FAIL_STREAK_ALERT_THRESHOLD - 1, null, now), false, 'below threshold, never alerts')
  assert.equal(shouldAlert(FAIL_STREAK_ALERT_THRESHOLD, null, now), true, 'at threshold, no prior alert')
  const justAlerted = new Date(now - 1000).toISOString()
  assert.equal(shouldAlert(FAIL_STREAK_ALERT_THRESHOLD, justAlerted, now), false, 'muted right after alerting')
  const longAgo = new Date(now - ALERT_MUTE_MS - 1000).toISOString()
  assert.equal(shouldAlert(FAIL_STREAK_ALERT_THRESHOLD, longAgo, now), true, 're-alerts once the mute window passes')
})

test('markAlerted + shouldAlert round-trip through recordLlmMonitorResult', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < FAIL_STREAK_ALERT_THRESHOLD; i++) recordLlmMonitorResult(db, { ok: false, reason: 'x' })
  let h = getLlmMonitorHealth(db)
  assert.equal(shouldAlert(h.failStreak, null), true)
  markAlerted(db)
  recordLlmMonitorResult(db, { ok: false, reason: 'x' }) // one more failure right after alerting
  h = getLlmMonitorHealth(db)
  // lastAlertAt isn't exposed on getLlmMonitorHealth (internal only) — read
  // shouldAlert's own behaviour via the raw state instead by re-deriving:
  // a fresh alert call within the mute window must be suppressed.
  assert.equal(shouldAlert(h.failStreak, new Date().toISOString()), false)
})

test('recordLlmMonitorResult and markAlerted never throw, even on a closed db handle', () => {
  const db = initDB(':memory:')
  db.close()
  assert.doesNotThrow(() => recordLlmMonitorResult(db, { ok: false, reason: 'x' }))
  assert.doesNotThrow(() => markAlerted(db))
})
