// node --test agent/services/heartbeat.test.js
//
// Controller heartbeats: beat lifecycle (ok/failure streaks), stall
// detection with an injected clock, once-per-stall alert + recovery, the
// failure-streak alert, the status view, and the cpp_exec probe.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  CONTROLLERS, beat, checkHeartbeats, heartbeatView, probeCppExec,
} from './heartbeat.js'

const T0 = new Date('2026-07-17T12:00:00Z')
const plus = (sec) => new Date(T0.getTime() + sec * 1000)

test('beat: upserts, counts runs, tracks ok/error and failure streaks', () => {
  const db = initDB(':memory:')
  beat(db, 'main_loop', { now: T0 })
  beat(db, 'main_loop', { ok: false, error: 'boom', now: plus(300) })
  beat(db, 'main_loop', { ok: false, error: 'boom2', now: plus(600) })
  const row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'main_loop'`).get()
  assert.equal(row.runs, 3)
  assert.equal(row.consecutive_failures, 2)
  assert.equal(row.last_error, 'boom2')
  assert.equal(row.last_ok_at, T0.toISOString())     // ok stamp survives failures
  assert.equal(row.last_run_at, plus(600).toISOString())

  beat(db, 'main_loop', { now: plus(900) })          // recovery resets the streak
  const row2 = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'main_loop'`).get()
  assert.equal(row2.consecutive_failures, 0)
  assert.equal(row2.last_ok_at, plus(900).toISOString())
})

test('checkHeartbeats: fresh beats raise nothing; stall alerts ONCE, then recovery once', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  beat(db, 'main_loop', { now: T0 })

  // Fresh (loop tied to 300s × factor 3 = 900s limit): quiet.
  assert.deepEqual(checkHeartbeats(db, { now: plus(600), notify, loopSec: 300 }), [])

  // Past the limit: one stall event + one alert…
  const ev1 = checkHeartbeats(db, { now: plus(1000), notify, loopSec: 300 })
  assert.equal(ev1.length, 1)
  assert.equal(ev1[0].event, 'stalled')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /STALLED/)
  assert.match(alerts[0], /Main loop/)

  // …and NOT again on the next check.
  assert.deepEqual(checkHeartbeats(db, { now: plus(1060), notify, loopSec: 300 }), [])
  assert.equal(alerts.length, 1)

  // It beats again → one recovery event, then quiet.
  beat(db, 'main_loop', { now: plus(1100) })
  const ev2 = checkHeartbeats(db, { now: plus(1130), notify, loopSec: 300 })
  assert.equal(ev2.length, 1)
  assert.equal(ev2[0].event, 'recovered')
  assert.equal(alerts.length, 2)
  assert.deepEqual(checkHeartbeats(db, { now: plus(1160), notify, loopSec: 300 }), [])
})

test('checkHeartbeats: 3 consecutive failures alert once per streak, recovery clears', () => {
  const db = initDB(':memory:')
  const alerts = []
  beat(db, 'burn_in', { ok: false, error: 'x', now: T0 })
  beat(db, 'burn_in', { ok: false, error: 'x', now: plus(300) })
  assert.deepEqual(checkHeartbeats(db, { now: plus(310), notify: (t) => alerts.push(t), loopSec: 300 }), [])

  beat(db, 'burn_in', { ok: false, error: 'ws timeout', now: plus(600) })
  const ev = checkHeartbeats(db, { now: plus(610), notify: (t) => alerts.push(t), loopSec: 300 })
  assert.equal(ev[0].event, 'failing')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /failed 3×/)
  assert.match(alerts[0], /ws timeout/)

  // Still failing → no re-alert.
  beat(db, 'burn_in', { ok: false, error: 'ws timeout', now: plus(900) })
  assert.deepEqual(checkHeartbeats(db, { now: plus(910), notify: (t) => alerts.push(t), loopSec: 300 }), [])

  // Success clears the streak → one recovery event.
  beat(db, 'burn_in', { now: plus(1200) })
  const ev2 = checkHeartbeats(db, { now: plus(1210), notify: (t) => alerts.push(t), loopSec: 300 })
  assert.equal(ev2[0].event, 'failure_recovered')
})

test('checkHeartbeats: loop-tied limits follow loop_interval_min from the db', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1') // 60s loop → limit 180s
  const alerts = []
  beat(db, 'main_loop', { now: T0 })
  const ev = checkHeartbeats(db, { now: plus(200), notify: (t) => alerts.push(t) })
  assert.equal(ev[0]?.event, 'stalled')
})

test('heartbeatView: idle when never beaten, ok/warn/error/stalled otherwise', () => {
  const db = initDB(':memory:')
  beat(db, 'main_loop', { now: T0 })
  beat(db, 'fast_monitor', { ok: false, error: 'y', now: T0 })
  beat(db, 'burn_in', { ok: false, error: 'z', now: T0 })
  beat(db, 'burn_in', { ok: false, error: 'z', now: T0 })
  beat(db, 'burn_in', { ok: false, error: 'z', now: T0 })

  const view = heartbeatView(db, { now: plus(30), loopSec: 300 })
  const by = Object.fromEntries(view.map(v => [v.name, v]))
  assert.equal(view.length, Object.keys(CONTROLLERS).length) // registry-complete
  assert.equal(by.main_loop.status, 'ok')
  assert.equal(by.fast_monitor.status, 'warn')     // 1 failure, still fresh
  assert.equal(by.burn_in.status, 'error')         // 3 failures
  assert.equal(by.cpp_exec.status, 'idle')         // never probed (js mode)
  assert.equal(by.main_loop.age_sec, 30)

  const stale = heartbeatView(db, { now: plus(1000), loopSec: 300 })
  assert.equal(stale.find(v => v.name === 'main_loop').status, 'stalled')
})

test('probeCppExec: no-op in js mode; records ok/failed beats in cpp mode', async () => {
  const db = initDB(':memory:')
  const jsExec = { execEngineMode: () => 'js', pingSidecar: async () => { throw new Error('must not be called') } }
  assert.equal(await probeCppExec(db, { exec: jsExec }), null)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM controller_heartbeats WHERE name = 'cpp_exec'`).get().n, 0)

  const up = { execEngineMode: () => 'cpp', pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: true }) }
  const r1 = await probeCppExec(db, { exec: up, now: T0 })
  assert.equal(r1.ok, true)
  let row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'cpp_exec'`).get()
  assert.equal(row.consecutive_failures, 0)

  const down = { execEngineMode: () => 'cpp', pingSidecar: async () => ({ ok: false, mode: 'cpp', error: 'fetch failed' }) }
  const r2 = await probeCppExec(db, { exec: down, now: plus(120) })
  assert.equal(r2.ok, false)
  row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'cpp_exec'`).get()
  assert.equal(row.consecutive_failures, 1)
  assert.equal(row.last_error, 'fetch failed')
})

test('pingSidecar (exec-engine): js mode is trivially alive with no HTTP call', async () => {
  const { pingSidecar } = await import('../lib/exec-engine.js')
  delete process.env.EXEC_ENGINE
  assert.deepEqual(await pingSidecar(), { ok: true, mode: 'js' })
})
