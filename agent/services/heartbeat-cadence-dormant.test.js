// node --test agent/services/heartbeat-cadence-dormant.test.js
//
// V3 I2 (25-09-2026): truthful controllers.
//
// 1. The autopilot's record is judged by the SWEEP's cadence, not the
//    scheduler's. Measured on production: /state/heartbeats read autopilot
//    `warn` / `record_stale` ("RECORD 26m OLD — past the 3m limit") while
//    action_log showed a clean /evaluate every 10–11 min (busy) and 30–32 min
//    (calm). The sweep ran; the limit (loop 60 s × 3) was wrong.
// 2. A controller dormant by design says so, with its reason: the weekend
//    watch while the LLM is switched off, the autopilot while its mode is off.
// 3. A hung sweep still reads stale — the fix must not blind the check.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { CONTROLLERS, beat, heartbeatView, effectRecord, verdictOf } from './heartbeat.js'
import { goalTable } from './goal-table.js'

const at = (iso) => new Date(iso)
const viewAt = (db, now) => Object.fromEntries(heartbeatView(db, { now, loopSec: 60 }).map(v => [v.name, v]))

// The weekend-watch dormancy reads the LLM switch, which also honours the
// LLM_DISABLED env var. Pin the env for the duration of a test so a runner
// that happens to export it cannot flip the verdict.
function withoutLlmEnv(fn) {
  const saved = process.env.LLM_DISABLED
  delete process.env.LLM_DISABLED
  try { return fn() } finally { if (saved === undefined) delete process.env.LLM_DISABLED; else process.env.LLM_DISABLED = saved }
}

test('the production reading: a sweep stamped 26 min ago in a calm window is on schedule, not record_stale', () => {
  // hb.json, 25-09-2026 13:27:18Z: autopilot beat 13:26:30Z, record 13:01:27Z.
  // 13:xx UTC is London/Frankfurt with Tokyo at 22h — the 30-minute cadence.
  const db = initDB(':memory:')
  setState(db, 'autopilot_mode', 'auto')
  const now = at('2026-09-25T13:27:18.880Z')
  beat(db, 'autopilot', { now: at('2026-09-25T13:26:30.942Z') })
  setState(db, 'autopilot_last_run_ms', String(Date.parse('2026-09-25T13:01:27.755Z')))
  const v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'ok', `expected ok, got ${v.verdict}: ${v.work_product?.summary}`)
  assert.equal(v.status, 'ok')
  assert.equal(v.work_product.fresh, true)
  assert.equal(v.work_product.cadenceSec, 1800)
  assert.equal(v.work_product.maxAgeSec, 1800 + 60 * 3, 'the 30-min cadence plus the scheduler grace (60 s × 3)')
  assert.match(v.work_product.summary, /record 26m old \(limit 33m: a 30m cadence \+ 3m grace\)/)
})

test('a hung sweep still reads record_stale: the limit is the cadence plus one grace window, no more', () => {
  const db = initDB(':memory:')
  setState(db, 'autopilot_mode', 'auto')
  // Calm: 30 min + 3 min. A stamp 34 min old is overdue.
  let now = at('2026-09-25T12:00:00Z')
  beat(db, 'autopilot', { now: new Date(now.getTime() - 20_000) })
  setState(db, 'autopilot_last_run_ms', String(now.getTime() - 34 * 60_000))
  let v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'record_stale')
  assert.equal(v.status, 'warn', 'the runner beats, its product is not current')
  // Busy (NY open, 15:00Z): 10 min + 3 min. 12 min old is on schedule, 14 is not.
  now = at('2026-09-25T15:00:00Z')
  beat(db, 'autopilot', { now: new Date(now.getTime() - 20_000) })
  setState(db, 'autopilot_last_run_ms', String(now.getTime() - 12 * 60_000))
  assert.equal(viewAt(db, now).autopilot.verdict, 'ok')
  setState(db, 'autopilot_last_run_ms', String(now.getTime() - 14 * 60_000))
  v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'record_stale')
  assert.match(v.work_product.summary, /RECORD 14m OLD — past the 13m: a 10m cadence \+ 3m grace limit/)
})

test('the window edge: a calm-window stamp is judged by the calm cadence after the busy window opens', () => {
  // Measured 25-09: 13:33:39Z → 14:01:19Z (27.7 min) across the NY open.
  const db = initDB(':memory:')
  setState(db, 'autopilot_mode', 'auto')
  const now = at('2026-09-25T14:00:30Z')
  beat(db, 'autopilot', { now: new Date(now.getTime() - 10_000) })
  setState(db, 'autopilot_last_run_ms', String(Date.parse('2026-09-25T13:33:39Z')))
  const v = viewAt(db, now).autopilot
  assert.equal(v.work_product.cadenceSec, 1800, 'the larger of the cadence at the stamp (30m) and now (10m)')
  assert.equal(v.verdict, 'ok')
})

test('the override cadence is honoured, and a stamp of 0 (runNow) is "no dated record", not 1970', () => {
  const db = initDB(':memory:')
  setState(db, 'autopilot_mode', 'auto')
  setState(db, 'autopilot_interval_ms', String(60 * 60_000))
  const nowMs = Date.parse('2026-09-25T15:00:00Z')
  setState(db, 'autopilot_last_run_ms', String(nowMs - 50 * 60_000))
  const r = effectRecord(db, 'autopilot', { nowMs, loopSec: 60 })
  assert.equal(r.cadenceSec, 3600)
  assert.equal(r.fresh, true)
  setState(db, 'autopilot_last_run_ms', '0')
  const z = effectRecord(db, 'autopilot', { nowMs, loopSec: 60 })
  assert.equal(z.hasRecord, false)
  assert.equal(z.at, null)
  assert.match(z.summary, /^no record at autopilot_last_run_ms/)
})

test('a controller without a cadence keeps the plain window and the old summary text', () => {
  const db = initDB(':memory:')
  const nowMs = Date.parse('2026-09-25T15:00:00Z')
  setState(db, 'decision_audit_last_json', JSON.stringify({ at: new Date(nowMs - 120_000).toISOString() }))
  const r = effectRecord(db, 'decision_audit', { nowMs, loopSec: 60 })
  assert.equal(r.maxAgeSec, 180)
  assert.equal('cadenceSec' in r, false)
  assert.equal(r.summary, 'record 2m old (limit 3m)')
})

test('autopilot_mode off is dormant by design, with its reason; the same state in auto is record_stale', () => {
  const db = initDB(':memory:')
  const now = at('2026-09-25T15:00:00Z')
  beat(db, 'autopilot', { now: new Date(now.getTime() - 20_000) })
  setState(db, 'autopilot_last_run_ms', String(now.getTime() - 5 * 3600_000))
  // No autopilot_mode stored = 'off' (autopilotMode's default).
  let v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'dormant')
  assert.equal(v.status, 'ok', 'the scheduler beat is healthy; the aging record is not a warning')
  assert.equal(v.dormant, true)
  assert.match(v.dormant_reason, /autopilot_mode is off/)
  setState(db, 'autopilot_mode', 'auto')
  v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'record_stale')
  assert.equal(v.dormant, undefined)
})

test('a dormant controller whose runner has stalled keeps the stalled verdict and stays judged', () => {
  const db = initDB(':memory:')
  const now = at('2026-09-25T15:00:00Z')
  beat(db, 'autopilot', { now: new Date(now.getTime() - 3600_000) }) // 1 h silent, limit 60 s × 3
  const v = viewAt(db, now).autopilot
  assert.equal(v.verdict, 'stalled')
  assert.equal(v.dormant, undefined, 'a stalled runner is not hidden as dormant')
  assert.equal(verdictOf('warn', { fresh: false }, true), 'warn', 'a warning runner keeps its word')
  assert.equal(verdictOf('idle', null, true), 'dormant')
  assert.equal(verdictOf('idle', null), 'never_ran')
})

test('weekend_watch reads dormant with the LLM switch as its reason, and never_ran when the LLM is on', () => withoutLlmEnv(() => {
  const db = initDB(':memory:')
  const now = at('2026-09-25T15:00:00Z')
  assert.equal(viewAt(db, now).weekend_watch.verdict, 'never_ran')
  setState(db, 'llm_disabled', '1')
  const v = viewAt(db, now).weekend_watch
  assert.equal(v.verdict, 'dormant')
  assert.equal(v.status, 'idle')
  assert.equal(v.dormant, true)
  assert.match(v.dormant_reason, /LLM switched off \(llm_disabled state key\)/)
  assert.equal(typeof CONTROLLERS.weekend_watch.dormantWhen, 'function')
}))

test('the goal table leaves a dormant controller out of controllers_ok and records_fresh', async () => withoutLlmEnv(async () => {
  const db = initDB(':memory:')
  const nowMs = Date.parse('2026-09-25T15:00:00Z')
  beat(db, 'autopilot', { now: new Date(nowMs - 20_000) })
  setState(db, 'autopilot_last_run_ms', String(nowMs - 5 * 3600_000))
  beat(db, 'decision_audit', { now: new Date(nowMs - 20_000) })
  setState(db, 'decision_audit_last_json', JSON.stringify({ at: new Date(nowMs - 20_000).toISOString() }))
  // autopilot_mode unset → off → dormant: not stale, not counted.
  let rows = Object.fromEntries((await goalTable(db, { now: nowMs })).goals.map(r => [r.id, r]))
  assert.doesNotMatch(rows.records_fresh.note, /autopilot/, rows.records_fresh.note)
  assert.equal(rows.records_fresh.verdict, 'on_track')
  assert.doesNotMatch(rows.controllers_ok.note, /autopilot/)
  // Switched on with the same 5-hour-old record: now it is stale and named.
  setState(db, 'autopilot_mode', 'auto')
  rows = Object.fromEntries((await goalTable(db, { now: nowMs })).goals.map(r => [r.id, r]))
  assert.match(rows.records_fresh.note, /autopilot/)
  assert.equal(rows.records_fresh.verdict, 'off_track')
}))
