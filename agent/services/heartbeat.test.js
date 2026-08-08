// node --test agent/services/heartbeat.test.js
//
// Controller heartbeats: beat lifecycle (ok/failure streaks), stall
// detection with an injected clock, once-per-stall alert + recovery, the
// failure-streak alert, the status view, and the cpp_exec probe.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  CONTROLLERS, beat, checkHeartbeats, heartbeatView, probeCppExec, rosterDrift, execSidesToProbe,
  checkAccountAuthorization,
  _resetBootStateForTests, OBSERVED_LOOP_CEIL_SEC, BOOT_GRACE_SEC,
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

// ---------------------------------------------------------------------------
// The observed-period expectation. Production 02-08-2026: loop_interval_min
// was 1 (60s) while cycles genuinely took ~3.5 minutes, so EIGHT loop-tied
// controllers sat permanently 'stalled' with consecutive_failures 0. A
// watchdog that is always red reports nothing.
// ---------------------------------------------------------------------------

test('loop-tied expectation follows the OBSERVED cycle, not the configured floor', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1')          // 60s configured…
  setState(db, 'last_loop_ms', String(210_000))   // …but cycles really take 3.5m
  beat(db, 'main_loop', { now: T0 })

  // 226s old — the exact production number. Under the configured floor this
  // was 60×3 = 180s and read 'stalled'; against the observed 220s period the
  // limit is 660s and it is simply a healthy loop mid-cycle.
  const v = heartbeatView(db, { now: plus(226) })
  const ml = v.find(x => x.name === 'main_loop')
  assert.equal(ml.status, 'ok', 'a loop beating on its real cadence is not stalled')
  assert.equal(ml.expected_sec, 220, '210s observed + loop.js 10s breather')

  // And the alerter agrees with the panel — that is the whole point of them
  // sharing one derivation.
  const alerts = []
  assert.deepEqual(checkHeartbeats(db, { now: plus(226), notify: (t) => alerts.push(t) }), [])
  assert.equal(alerts.length, 0)
})

test('a REAL hang still trips, because a hung cycle writes no new last_loop_ms', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1')
  setState(db, 'last_loop_ms', String(210_000))   // last HEALTHY cycle
  beat(db, 'main_loop', { now: T0 })

  // loop.js:3411 writes last_loop_ms only after a cycle COMPLETES, so a hang
  // leaves the expectation pinned at the last good period (220s) while the
  // age climbs past 220×3 = 660s.
  const alerts = []
  const ev = checkHeartbeats(db, { now: plus(700), notify: (t) => alerts.push(t) })
  assert.equal(ev[0]?.event, 'stalled')
  assert.match(alerts[0], /Main loop/)
})

test('loop-tied expectation falls back to the configured interval with no measurement', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1')
  beat(db, 'main_loop', { now: T0 })
  // No last_loop_ms at all (fresh DB, or a boot before the first cycle ends).
  assert.equal(heartbeatView(db, { now: plus(10) }).find(v => v.name === 'main_loop').expected_sec, 60)

  // Junk values are measurements too, and must not be trusted.
  for (const junk of ['0', '-1', 'nonsense', '']) {
    setState(db, 'last_loop_ms', junk)
    assert.equal(
      heartbeatView(db, { now: plus(10) }).find(v => v.name === 'main_loop').expected_sec, 60,
      `last_loop_ms=${JSON.stringify(junk)} must not move the expectation`)
  }
})

test('one pathological cycle cannot blind the watchdog forever', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '5')
  setState(db, 'last_loop_ms', String(3 * 3_600_000)) // a 3-hour cycle
  beat(db, 'main_loop', { now: T0 })
  const ml = heartbeatView(db, { now: plus(10) }).find(v => v.name === 'main_loop')
  assert.equal(ml.expected_sec, OBSERVED_LOOP_CEIL_SEC, 'capped, not 3 hours')
  // So the blind window stays bounded at ceiling × factor, not hours × factor.
  assert.equal(
    heartbeatView(db, { now: plus(OBSERVED_LOOP_CEIL_SEC * 3 + 60) })
      .find(v => v.name === 'main_loop').status, 'stalled')
})

test('an explicit loopSec still wins — callers asking for the configured number get it', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1')
  setState(db, 'last_loop_ms', String(210_000))
  beat(db, 'main_loop', { now: T0 })
  assert.equal(
    heartbeatView(db, { now: plus(10), loopSec: 300 }).find(v => v.name === 'main_loop').expected_sec, 300)
})

test('loopMultiplier composes with the observed period (weekend_bank runs every 3rd cycle)', () => {
  const db = initDB(':memory:')
  setState(db, 'loop_interval_min', '1')
  setState(db, 'last_loop_ms', String(210_000))   // 220s observed
  beat(db, 'weekend_bank', { now: T0 })
  const wb = heartbeatView(db, { now: plus(10) }).find(v => v.name === 'weekend_bank')
  assert.equal(wb.expected_sec, 660, '220s × 3 cycles')
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

  // Healthy = HTTP up AND broker session connected AND a fresh reconcile.
  const up = { execEngineMode: () => 'cpp', pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: true, lastReconcileAt: T0.getTime() - 30_000 }) }
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

test('probeCppExec: an answering HTTP server no longer masks a dead broker session', async () => {
  // Owner saw "C++ exec engine" beating steadily while pending-order-manager
  // failed 14× in a row with "no reconcile data yet" — /health says ok:true
  // whenever the HTTP server is up, regardless of the broker WS behind it.
  const db = initDB(':memory:')
  const cases = [
    [{ ok: true, mode: 'cpp', connected: false, hasCredentials: false }, /no credentials/],
    [{ ok: true, mode: 'cpp', connected: false, hasCredentials: true }, /reconnecting/],
    [{ ok: true, mode: 'cpp', connected: true, lastReconcileAt: null }, /no reconcile pass/],
    [{ ok: true, mode: 'cpp', connected: true, lastReconcileAt: T0.getTime() - 10 * 60_000 }, /10m ago.*stalled/],
  ]
  for (const [health, errRe] of cases) {
    const exec = { execEngineMode: () => 'cpp', pingSidecar: async () => health }
    const r = await probeCppExec(db, { exec, now: T0 })
    assert.equal(r.ok, false, JSON.stringify(health))
    assert.match(r.error, errRe)
  }
  const row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'cpp_exec'`).get()
  assert.equal(row.consecutive_failures, cases.length)
  assert.match(row.last_error, /stalled/)
})

test('probeCppExec: credential-less live sidecar triggers a re-push (M4 self-heal)', async () => {
  // A sidecar that restarted alone loses its creds while the agent's push
  // memo still matches — the probe must force a re-push, or the broker
  // session never returns until the next agent redeploy.
  const db = initDB(':memory:')
  let pushedWith = null
  const exec = {
    execEngineMode: () => 'cpp',
    pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: false, hasCredentials: false }),
    pushSidecarSession: async (creds) => { pushedWith = creds; return true },
  }
  const r = await probeCppExec(db, { exec, now: T0 })
  assert.equal(r.ok, false)
  assert.match(r.error, /no credentials/)
  assert.match(r.error, /re-pushed/)
  assert.ok(pushedWith && typeof pushedWith === 'object', 'pushSidecarSession called with assembled creds')
  // The reconnecting case (creds present) must ALSO re-push — 02-08 incident:
  // the sidecar retried a STALE access token for 22 hours after Node rotated
  // it, and nothing re-pushed because this path only fired on missing creds.
  // Re-pushing an unchanged token is a cheap /connect no-op; a rotated one
  // revives the session within a probe interval.
  pushedWith = null
  exec.pingSidecar = async () => ({ ok: true, mode: 'cpp', connected: false, hasCredentials: true })
  await probeCppExec(db, { exec, now: T0 })
  assert.ok(pushedWith && typeof pushedWith === 'object', 're-push fires on stale-token reconnect loop too')
})

test('pingSidecar (exec-engine): js mode is trivially alive with no HTTP call', async () => {
  const { pingSidecar } = await import('../lib/exec-engine.js')
  delete process.env.EXEC_ENGINE
  assert.deepEqual(await pingSidecar(), { ok: true, mode: 'js' })
})

test('deploy grace window: one restart notice, silent recoveries, real stalls alert after grace', () => {
  _resetBootStateForTests()
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  // Two controllers whose last beat predates the "restart" by far.
  beat(db, 'main_loop', { now: T0 })
  beat(db, 'autopilot', { now: T0 })
  const bootMs = plus(2000).getTime() // process "booted" at T0+2000s

  // First watchdog pass 60s after boot (in grace): ONE restart notice, no
  // per-controller stall alerts, no stalled flags written.
  const ev1 = checkHeartbeats(db, { now: plus(2060), notify, loopSec: 300, bootMs })
  assert.equal(ev1.filter(e => e.event === 'restart_notice').length, 1)
  assert.equal(ev1.filter(e => e.event === 'stalled').length, 0)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /restarted/)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM controller_heartbeats WHERE stalled = 1`).get().n, 0)

  // Controllers resume inside grace → nothing further said.
  beat(db, 'main_loop', { now: plus(2100) })
  beat(db, 'autopilot', { now: plus(2100) })
  const ev2 = checkHeartbeats(db, { now: plus(2160), notify, loopSec: 300, bootMs })
  assert.deepEqual(ev2, [])
  assert.equal(alerts.length, 1)

  // A controller STILL dead after the grace window alerts normally.
  const ev3 = checkHeartbeats(db, { now: plus(2000 + 400 + 3000), notify, loopSec: 300, bootMs })
  assert.ok(ev3.some(e => e.event === 'stalled'))
  assert.ok(alerts.some(a => /STALLED/.test(a)))
})

// --- roster drift (2026-07-30) ---------------------------------------------

test('rosterDrift: set comparison, and the direction that matters', () => {
  // Same set, different order/types → no drift.
  assert.equal(rosterDrift([46130058, 46979908], ['46979908', '46130058']).drifted, false)

  // Sidecar authorised for an account the registry no longer enables. This is
  // the real case: the owner disabled 46979908 and the sidecar kept it.
  const d = rosterDrift([46130058, 46979908], ['46130058'])
  assert.equal(d.drifted, true)
  assert.deepEqual(d.extra, ['46979908'], 'extra = authorisation the owner revoked')
  assert.deepEqual(d.missing, [])

  // Newly enabled account not yet pushed.
  const d2 = rosterDrift([46130058], ['46130058', '43097342'])
  assert.equal(d2.drifted, true)
  assert.deepEqual(d2.missing, ['43097342'])
  assert.deepEqual(d2.extra, [])
})

test('rosterDrift: an unknown creds roster is NOT read as "should be empty"', () => {
  // getCtraderCreds returns accountIds: null on a DB with no accounts table.
  // Treating that as "the sidecar should hold nothing" would push an empty
  // roster and de-authorise a working session.
  for (const want of [null, undefined, []]) {
    assert.equal(rosterDrift([46130058, 46979908], want).drifted, false, String(want))
  }
  // A sidecar reporting nothing while the registry enables one IS drift.
  assert.equal(rosterDrift([], ['46130058']).drifted, true)
  // ...but a sidecar that reported NOTHING AT ALL is unknown, not empty. This
  // line used to assert `null` drifted too, conflating the two — and that
  // assertion is what let the real bug live: pingSidecar was dropping the
  // `accounts` field entirely, so production passed `undefined` here on every
  // probe and got `drifted: true` forever. See the dedicated tests below.
  assert.equal(rosterDrift(null, ['46130058']).drifted, false)
  assert.equal(rosterDrift(null, ['46130058']).unknown, true)
})

test('probeCppExec: a connected sidecar with a stale roster is re-pushed', async () => {
  // The gap this closes: ensureSidecarSession only runs on exec paths (order/
  // amend/close/cancel/reconcile), so with autotrade off a disabled account
  // stayed authorised at the sidecar indefinitely. Observed live on staging.
  const db = initDB(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY, is_live INTEGER, enabled INTEGER, mode TEXT)`)
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,?,?)')
    .run('46130058', 0, 1, 'active')
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'ctrader_access_token', 'tok')

  let pushedWith = null
  const exec = {
    execEngineMode: () => 'cpp',
    // Sidecar still holds the DISABLED account.
    pingSidecar: async () => ({
      ok: true, mode: 'cpp', connected: true, hasCredentials: true,
      accounts: [46130058, 46979908], lastReconcileAt: T0.getTime(),
    }),
    pushSidecarSession: async (creds) => { pushedWith = creds; return true },
  }
  const r = await probeCppExec(db, { exec, now: T0 })
  // The heartbeat stays GREEN: the engine is healthy and the drift self-heals.
  assert.equal(r.ok, true)
  assert.ok(pushedWith, 'a drifted roster forces a re-push')
  assert.deepEqual(pushedWith.accountIds, ['46130058'], 'pushes the ENABLED roster')

  // Matching roster → no push at all.
  pushedWith = null
  exec.pingSidecar = async () => ({
    ok: true, mode: 'cpp', connected: true, hasCredentials: true,
    accounts: [46130058], lastReconcileAt: T0.getTime(),
  })
  await probeCppExec(db, { exec, now: T0 })
  assert.equal(pushedWith, null, 'no drift, no push')
})

test('probeCppExec: roster drift does not mask a stalled reconcile', async () => {
  const db = initDB(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY, is_live INTEGER, enabled INTEGER, mode TEXT)`)
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,?,?)')
    .run('46130058', 0, 1, 'active')
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'ctrader_access_token', 'tok')
  const exec = {
    execEngineMode: () => 'cpp',
    pingSidecar: async () => ({
      ok: true, mode: 'cpp', connected: true, hasCredentials: true,
      accounts: [46130058, 46979908],
      lastReconcileAt: T0.getTime() - 20 * 60_000,   // 20m stale
    }),
    pushSidecarSession: async () => true,
  }
  const r = await probeCppExec(db, { exec, now: T0 })
  assert.equal(r.ok, false, 'a stale reconcile still fails the heartbeat')
  assert.match(r.error, /engine loop looks stalled/)
})

test('rosterDrift: an UNREPORTED roster is unknown, not empty', () => {
  // This is the bug that made the drift check a no-op dressed as a check. While
  // pingSidecar was dropping `accounts`, undefined normalised to the empty set,
  // so `missing` was the whole registry and drift was true on EVERY probe —
  // re-pushing the session every ~2 minutes and never once detecting the
  // revoked-authorisation direction.
  for (const nothing of [undefined, null]) {
    const d = rosterDrift(nothing, ['46130058'])
    assert.equal(d.drifted, false, `sidecarAccounts=${nothing}`)
    assert.equal(d.unknown, true)
    assert.deepEqual(d.missing, [])
    assert.deepEqual(d.extra, [])
  }
})

test('rosterDrift: an EMPTY roster is real information and DOES drift', () => {
  // "I hold nothing" differs from "I did not say" — the sidecar reporting []
  // while the registry enables an account is exactly the case a re-push fixes.
  const d = rosterDrift([], ['46130058'])
  assert.equal(d.drifted, true)
  assert.deepEqual(d.missing, ['46130058'])
  assert.deepEqual(d.extra, [])
})

test('rosterDrift: a REVOKED account shows up as extra', () => {
  // The direction that matters: still authorised at the sidecar after the owner
  // disabled it. Unreachable in production until pingSidecar surfaced accounts.
  const d = rosterDrift([46130058, 46979908], ['46130058'])
  assert.equal(d.drifted, true)
  assert.deepEqual(d.extra, ['46979908'])
  assert.deepEqual(d.missing, [])
})

test('probeCppExec persists the roster for the read path', async () => {
  // /state/account-engineering must never call the sidecar itself — an external
  // HTTP hop inside a cached GET is how read routes get slow. The probe already
  // runs every ~2 min, so it records what it saw.
  const db = initDB(':memory:')
  const exec = {
    execEngineMode: () => 'cpp',
    pingSidecar: async () => ({
      ok: true, mode: 'cpp', connected: true, hasCredentials: true,
      lastReconcileAt: T0.getTime() - 30_000, accounts: [46130058],
    }),
    pushSidecarSession: async () => false,
  }
  await probeCppExec(db, { exec, now: T0 })
  const saved = JSON.parse(getState(db, 'cpp_exec_health_json'))
  assert.deepEqual(saved.accounts, ['46130058'], 'ids normalised to strings for the UI')
  assert.equal(saved.connected, true)
  assert.equal(saved.ok, true)
  assert.equal(saved.at, T0.toISOString())
})

// ---------------------------------------------------------------------------
// A RESOLVED ERROR IS NOT A CURRENT ONE (owner, 04-08-2026, reading the panel:
// "ATR baseline refresh {hasn't refresh since 9 AM yesterday}").
//
// beat() deliberately keeps last_error across a later success. The panel then
// printed it in the same red as a live failure, so `atr_refresh` advertised
// `unknown period "D1"` — a bug fixed the day before, 185/185 symbols updated
// on its next run — as though it were happening now.
// ---------------------------------------------------------------------------
test('the view says whether the stored error is still happening', () => {
  const db = initDB(':memory:')
  beat(db, 'atr_refresh', { ok: false, error: 'unknown period "D1"' })
  let row = heartbeatView(db).find(c => c.name === 'atr_refresh')
  assert.equal(row.error_is_current, true)
  assert.match(row.last_error, /D1/)

  // …then it runs clean. The text stays for forensics; the claim does not.
  beat(db, 'atr_refresh', { ok: true })
  row = heartbeatView(db).find(c => c.name === 'atr_refresh')
  assert.equal(row.error_is_current, false, 'no longer a current failure')
  assert.match(row.last_error, /D1/, 'but still readable')
  assert.equal(row.consecutive_failures, 0)
})

// ---------------------------------------------------------------------------
// ACCOUNT AUTHORISATION WATCH — the check that would have caught 05-08-2026.
//
// Four enabled demo accounts sat outside the sidecar's authorised roster for
// twelve hours. `cpp_exec` stayed green (the sidecar WAS alive) and rosterDrift
// stayed quiet (it compares against a side-filtered set the accounts were never
// in). Nothing alerted. These tests pin the dwell, the de-duplication and — most
// importantly — the rule that "we cannot tell" never alerts.
// ---------------------------------------------------------------------------

/** Registry + persisted sidecar health, the two inputs the check reads. */
function seedAuth(db, { roster, atMs = T0.getTime(), accounts = null }) {
  const rows = accounts ?? [
    { id: '42993489', login: '1251247', live: 1 },
    { id: '43097342', login: '5067353', live: 0 },
  ]
  for (const a of rows) {
    db.prepare(
      'INSERT OR REPLACE INTO accounts (account_id, trader_login, is_live, enabled) VALUES (?, ?, ?, 1)'
    ).run(a.id, a.login, a.live)
  }
  // connected+ok on purpose: the check treats a DOWN session as "cannot tell",
  // matching sidecarRoster (exec-engine.js:244).
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: roster, connected: true, ok: true, at: new Date(atMs).toISOString(),
  }))
}

test('account auth: silent before the dwell, ONE alert after, never repeats', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })            // demo 43097342 missing

  // Inside the 5-minute dwell: the timer starts, nothing is said. A sidecar
  // restart re-authorises within a probe interval, so alerting instantly would
  // page the owner for every deploy.
  assert.deepEqual(checkAccountAuthorization(db, { now: T0, notify }).events, [])
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(120), notify }).events, [])
  assert.equal(alerts.length, 0)

  // Past it: exactly one alert, naming the account and the side. The health
  // snapshot is refreshed as the 120s probe would — a snapshot left to go stale
  // reads as "cannot tell", which is a different test (below).
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  const fired = checkAccountAuthorization(db, { now: plus(301), notify })
  assert.deepEqual(fired.events.map(e => [e.accountId, e.event]), [['43097342', 'unauthorized']])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /43097342/)
  assert.match(alerts[0], /Demo 5067353/)

  // Still down 20 minutes later: silence. This is the property that keeps the
  // alert worth reading — cf. 32,115 identical vetoes in one week.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(1200).toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(1201), notify }).events, [])
  assert.equal(alerts.length, 1)
})

test('account auth: recovery is announced once, and only to someone who heard the alarm', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  checkAccountAuthorization(db, { now: plus(301), notify })   // alerted
  assert.equal(alerts.length, 1)

  // Back on the roster.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489', '43097342'], connected: true, ok: true, at: plus(400).toISOString(),
  }))
  const back = checkAccountAuthorization(db, { now: plus(401), notify })
  assert.deepEqual(back.events.map(e => e.event), ['reauthorized'])
  assert.equal(alerts.length, 2)
  assert.match(alerts[1], /REAUTHORISED/)

  // …and it does not keep saying so.
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(500), notify }).events, [])
  assert.equal(alerts.length, 2)
})

test('account auth: a brief recovery that was never alerted stays silent both ways', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })          // timer starts, no alert
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489', '43097342'], connected: true, ok: true, at: plus(60).toISOString(),
  }))
  // Recovered inside the dwell: nobody was told it was down, so nobody is told
  // it is back. A monitor that narrates every blip is noise.
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(61), notify }).events, [])
  assert.equal(alerts.length, 0)
})

test('account auth: UNKNOWN never alerts — a null roster and a stale snapshot are both "cannot tell"', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)

  // null roster (js mode, or a sidecar that did not report one).
  seedAuth(db, { roster: null })
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3600), notify }).events, [])

  // A snapshot older than the probe's own stall threshold says nothing about now.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: T0.toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3600), notify }).events, [])
  assert.equal(alerts.length, 0)

  // No health state at all.
  setState(db, 'cpp_exec_health_json', '')
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3600), notify }).events, [])
  assert.equal(alerts.length, 0)
})

test('account auth: an unknown WINDOW does not restart the dwell', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })          // t=0, timer starts

  // Health goes unknown for a while — the account is no less unreachable.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: null, connected: false, ok: false, at: plus(120).toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(121), notify }).events, [])

  // Known again, still absent. Measured from t=0 this is past the dwell, so it
  // alerts NOW rather than starting a fresh five minutes.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(301).toISOString(),
  }))
  const fired = checkAccountAuthorization(db, { now: plus(302), notify })
  assert.deepEqual(fired.events.map(e => e.event), ['unauthorized'])
  assert.equal(alerts.length, 1)
})

test('account auth: DISABLED accounts are not watched — absence is the intent', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run('43097342')
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3600), notify }).events, [])
  assert.equal(alerts.length, 0)
})

test('account auth: every enabled account is checked, with NO side filter', () => {
  // The blind spot in rosterDrift was exactly a side filter: the missing
  // accounts were never in the comparison set. This check must have no such
  // notion — a live roster leaves four demo accounts unauthorised and it says so
  // for all four.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, {
    roster: ['42993489'],
    accounts: [
      { id: '42993489', login: '1251247', live: 1 },
      { id: '43097342', login: '5067353', live: 0 },
      { id: '46130058', login: '5203012', live: 0 },
      { id: '46979908', login: '5268549', live: 0 },
      { id: '47790949', login: '5306502', live: 0 },
    ],
  })
  checkAccountAuthorization(db, { now: T0, notify })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  const fired = checkAccountAuthorization(db, { now: plus(301), notify })
  assert.deepEqual(
    fired.events.map(e => e.accountId).sort(),
    ['43097342', '46130058', '46979908', '47790949'],
  )
  assert.equal(alerts.length, 4)
})

test('account auth: a DOWN broker session is unknown, not four false alarms', () => {
  // The 02-08 shape: sidecar HTTP alive, broker session gone. GET /health still
  // answers ok:true with an EMPTY accounts array (main.cpp:272,289), so a naive
  // read calls every enabled account unauthorised. But sidecarRoster returns
  // null in that state, so loop.js:1173 gates nobody — the alert would assert
  // something the code is not doing, and cpp_exec is already red with the right
  // cause. That incident held this state for 22 HOURS.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: [], connected: false, ok: false, at: T0.toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(60), notify }).events, [])
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: [], connected: false, ok: false, at: plus(3600).toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3601), notify }).events, [])
  assert.equal(alerts.length, 0, 'a down session must never produce an authorisation alert')
})

test('account auth: the alert does not claim entries are skipped — the query is wider than the entry roster', () => {
  // `enabled = 1` also covers manage_only accounts, which never reach the
  // connectivity gate for ENTRIES at all. The wide query is correct (such an
  // account cannot receive closes either) but the sentence must stay true for
  // every account it can name.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  checkAccountAuthorization(db, { now: plus(301), notify })
  assert.equal(alerts.length, 1)
  assert.doesNotMatch(alerts[0], /entries/i)
  assert.match(alerts[0], /No order can be built/)
})

test('account auth: watch state is cleared when no account is enabled', () => {
  const db = initDB(':memory:')
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0 })
  assert.notEqual(getState(db, 'account_auth_watch_json'), '{}')
  db.prepare('UPDATE accounts SET enabled = 0').run()
  checkAccountAuthorization(db, { now: plus(60) })
  assert.equal(getState(db, 'account_auth_watch_json'), '{}', 'stale entries must not linger')
})

test('account auth: a STALLED reconcile must not silence the alert — persisted ok is not the gate', () => {
  // The divergence that matters. sidecarRoster reads the RAW http-level ok
  // (exec-engine.js:197); the snapshot's `ok` is probeCppExec's verdict, which
  // it sets false while connected===true on a stale reconcile (heartbeat.js:466).
  //
  // In this state sidecarRoster returns the roster, so loop.js:1173 IS skipping
  // all four demo accounts — and cpp_exec goes red naming the loop, not the
  // accounts. Gating on the persisted `ok` would make this check silent through
  // exactly the outage it was written for.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  const stalled = (atMs) => setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: false,   // ok=false: reconcile stale
    lastReconcileAt: T0.getTime() - 600_000, at: new Date(atMs).toISOString(),
  }))
  stalled(T0.getTime())
  assert.deepEqual(checkAccountAuthorization(db, { now: T0, notify }).events, [])
  stalled(plus(300).getTime())
  const fired = checkAccountAuthorization(db, { now: plus(301), notify })
  assert.deepEqual(fired.events.map(e => e.event), ['unauthorized'])
  assert.equal(alerts.length, 1, 'a stalled engine loop must not buy silence on unreachable accounts')
})

test('account auth: an EMPTY roster on a live session alerts — the gate skips everyone there too', () => {
  // roster [] is truthy, so `if (sidecarAccounts && …)` at loop.js:1173 gates
  // EVERY account. Reading [] as "cannot tell" would go quiet while the gate is
  // at its most aggressive.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: [] })
  checkAccountAuthorization(db, { now: T0, notify })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: [], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  const fired = checkAccountAuthorization(db, { now: plus(301), notify })
  assert.equal(fired.events.length, 2, 'both enabled accounts are unreachable')
  assert.equal(alerts.length, 2)
})

test('account auth: a failed registry read must not wipe the dwell or the alerted flag', () => {
  // `next` is built from the account list, so an empty list persists {} over the
  // watch state. An already-alerted, still-down account would then restart its
  // dwell and alert a SECOND time for one continuous outage — the exact
  // repeat-alert shape the de-dup exists to prevent, triggered by an unrelated
  // SQLITE_BUSY. "Read failed" and "nothing is enabled" are different states.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(300).toISOString(),
  }))
  checkAccountAuthorization(db, { now: plus(301), notify })
  assert.equal(alerts.length, 1)
  const saved = getState(db, 'account_auth_watch_json')

  // Simulate the read throwing on one tick.
  const realPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (String(sql).includes('FROM accounts')) throw new Error('SQLITE_BUSY')
    return realPrepare(sql)
  }
  checkAccountAuthorization(db, { now: plus(360), notify })
  db.prepare = realPrepare

  assert.equal(getState(db, 'account_auth_watch_json'), saved, 'watch state survived the failed read')
  // Still down on the next good tick: silence, not a duplicate page.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(900).toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(901), notify }).events, [])
  assert.equal(alerts.length, 1, 'one outage, one alert')
})

test('account auth: a LONG blind window re-arms the dwell; a short one does not', () => {
  // Flip EXEC_ENGINE to js overnight and the roster goes unknown while trading
  // is fine — there is no gate in js mode. Coming back must not page instantly
  // with "absent for 720m"; the grace exists so a restarting sidecar can
  // re-authorise first, and a deploy is the noisiest moment to have spent it.
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  seedAuth(db, { roster: ['42993489'] })
  checkAccountAuthorization(db, { now: T0, notify })            // timer starts

  // Blind for an hour (>> the 5-minute dwell).
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: null, connected: null, ok: false, at: plus(60).toISOString(),
  }))
  checkAccountAuthorization(db, { now: plus(61), notify })

  // Roster returns, still absent. The dwell restarts rather than firing at once.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(3600).toISOString(),
  }))
  assert.deepEqual(checkAccountAuthorization(db, { now: plus(3601), notify }).events, [],
    'a blind hour must not spend the grace period')
  assert.equal(alerts.length, 0)

  // Five minutes of CONFIRMED absence later, it alerts — and reports minutes it
  // actually observed, not the hour it could not see.
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: plus(3900).toISOString(),
  }))
  const fired = checkAccountAuthorization(db, { now: plus(3902), notify })
  assert.deepEqual(fired.events.map(e => e.event), ['unauthorized'])
  assert.ok(fired.events[0].downSec < 400, `reported ${fired.events[0].downSec}s — observed, not wall clock`)
})

// ---------------------------------------------------------------------------
// PHASE 2 — ONE SIDECAR PER BROKER HOST.
//
// `rosterDrift` was STRUCTURALLY BLIND to the 05-08 outage. It compared one
// sidecar's roster against `getCtraderCreds(db).accountIds`, which is filtered
// `WHERE enabled = 1 AND is_live = ?` off the single global `ctrader_is_live`
// flag. With that flag on LIVE, the comparison set was {live account} — which
// matched — so four disconnected demo accounts could never register as drift.
// The self-heal that should have caught the outage was incapable of seeing it.
//
// The property under test is not "it now works with two sidecars". It is that
// with ONE base configured NOTHING CHANGES, and that with two, no check ever
// measures one sidecar's roster against the other side's registry.
// ---------------------------------------------------------------------------

const HOSTS = { EXEC_HOST_LIVE: 'live.ctraderapi.com', EXEC_HOST_DEMO: 'demo.ctraderapi.com' }
/** A fake exec module whose execBaseFor mirrors the real resolver. */
function execWithBases({ dflt = 'http://one:8091', live = null, demo = null } = {}) {
  return {
    ...HOSTS,
    execEngineMode: () => 'cpp',
    execBaseFor: (h) => {
      const host = String(typeof h === 'string' ? h : h?.host || '').toLowerCase()
      if (host === HOSTS.EXEC_HOST_LIVE) return live || dflt
      if (host === HOSTS.EXEC_HOST_DEMO) return demo || dflt
      return dflt
    },
  }
}

test('execSidesToProbe: ONE probe when both sides resolve to the same base', () => {
  // The migration property. With only EXEC_URL set there is exactly one sidecar
  // and exactly one thing to be right about, so splitting the probe would invent
  // a second controller that can only ever duplicate the first.
  const sides = execSidesToProbe(execWithBases())
  assert.equal(sides.length, 1)
  assert.equal(sides[0].name, 'cpp_exec')
  assert.equal(sides[0].isLive, null, 'null = serves whichever side the global flag names')
})

test('execSidesToProbe: two probes, each responsible for its OWN side', () => {
  const sides = execSidesToProbe(execWithBases({ live: 'http://live:8091', demo: 'http://demo:8091' }))
  assert.deepEqual(sides.map(s => [s.name, s.base, s.isLive]), [
    ['cpp_exec', 'http://live:8091', true],
    ['cpp_exec_demo', 'http://demo:8091', false],
  ])
})

test('probeCppExec split: each sidecar beats its own controller and writes its own snapshot', async () => {
  const db = initDB(':memory:')
  const seen = []
  const exec = {
    ...execWithBases({ live: 'http://live:8091', demo: 'http://demo:8091' }),
    pingSidecar: async ({ base } = {}) => {
      seen.push(base)
      return base === 'http://live:8091'
        ? { ok: true, mode: 'cpp', connected: true, accounts: [42993489], lastReconcileAt: T0.getTime() - 30_000 }
        : { ok: false, mode: 'cpp', error: 'demo sidecar unreachable' }
    },
  }
  await probeCppExec(db, { exec, now: T0 })

  assert.deepEqual(seen, ['http://live:8091', 'http://demo:8091'], 'both bases probed, neither twice')
  const live = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'cpp_exec'`).get()
  const demo = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'cpp_exec_demo'`).get()
  assert.equal(live.consecutive_failures, 0)
  assert.equal(demo.consecutive_failures, 1, 'a dead demo sidecar must not be masked by a healthy live one')
  assert.equal(demo.last_error, 'demo sidecar unreachable')

  // Two snapshots, each labelled with the side it can answer for.
  const l = JSON.parse(getState(db, 'cpp_exec_health_json'))
  const d = JSON.parse(getState(db, 'cpp_exec_demo_health_json'))
  assert.deepEqual(l.accounts, ['42993489'])
  assert.equal(l.side, 'live')
  assert.equal(d.side, 'demo')
})

test('probeCppExec single sidecar: still ONE snapshot, side null, no demo controller row', async () => {
  // The regression guard for today's deployment. A stray cpp_exec_demo row would
  // show up in the Controllers panel as a controller that does not exist.
  const db = initDB(':memory:')
  const exec = {
    ...execWithBases(),
    pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: true, accounts: [1], lastReconcileAt: T0.getTime() - 30_000 }),
  }
  await probeCppExec(db, { exec, now: T0 })
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM controller_heartbeats WHERE name = 'cpp_exec_demo'`).get().n, 0)
  assert.equal(getState(db, 'cpp_exec_demo_health_json'), null)
  assert.equal(JSON.parse(getState(db, 'cpp_exec_health_json')).side, null)
})

// ---------------------------------------------------------------------------
// DORMANT SIDES (08-08-2026). Owner, reading the panel: "C++ exec engine —
// ERROR, 630 failing" while every live account was disabled and the demo
// sidecar was perfectly healthy. Not one trade was lost; the counter was
// measuring "asked a question that has no answer" and calling it a breakage.
// ---------------------------------------------------------------------------

/** A split deployment whose sidecars answer however the test says. */
const splitExec = (ping) => ({
  ...execWithBases({ live: 'http://live:8091', demo: 'http://demo:8091' }),
  pingSidecar: ping,
})
const enable = (db, id, isLive, enabled = 1) =>
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?,?,?)').run(String(id), isLive ? 1 : 0, enabled)

test('THE POINT: a side with no enabled account is idle, not a climbing failure count', async () => {
  const db = initDB(':memory:')
  enable(db, 46130058, false)             // demo enabled — the real deployment
  enable(db, 42993489, true, 0)           // live present but DISABLED
  const probed = []
  const exec = splitExec(async ({ base } = {}) => {
    probed.push(base)
    return { ok: true, mode: 'cpp', connected: true, accounts: [46130058], lastReconcileAt: T0.getTime() - 30_000 }
  })

  await probeCppExec(db, { exec, now: T0 })

  assert.deepEqual(probed, ['http://demo:8091'], 'the live sidecar is not asked a question it cannot answer')
  const view = heartbeatView(db, { now: T0 }).find(c => c.name === 'cpp_exec')
  assert.equal(view.status, 'idle', 'NOT error — this was the bug')
  assert.equal(view.dormant, true)
  assert.match(view.last_error, /nothing for this sidecar to serve/)
  assert.equal(view.error_is_current, false)
  assert.equal(heartbeatView(db, { now: T0 }).find(c => c.name === 'cpp_exec_demo').status, 'ok')
})

test('a dormant side stops alerting — no row means checkHeartbeats has nothing to shout about', async () => {
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  enable(db, 42993489, true, 0)
  // The state production was in: 630 failures already banked on the live side.
  for (let i = 0; i < 5; i++) beat(db, 'cpp_exec', { ok: false, error: 'broker session down', now: plus(i * 120) })
  assert.equal(db.prepare(`SELECT consecutive_failures f FROM controller_heartbeats WHERE name='cpp_exec'`).get().f, 5)

  const exec = splitExec(async () => ({ ok: true, mode: 'cpp', connected: true, accounts: [46130058], lastReconcileAt: T0.getTime() - 30_000 }))
  await probeCppExec(db, { exec, now: T0 })

  // The row is DELETED rather than left to age, because a stale row reads as
  // STALLED — which claims the engine died, the opposite of the truth.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM controller_heartbeats WHERE name='cpp_exec'`).get().n, 0)
  _resetBootStateForTests(plus(100_000).getTime() - BOOT_GRACE_SEC * 1000 - 1000)
  const alerts = []
  checkHeartbeats(db, { now: plus(100_000), notify: (t) => alerts.push(t) })
  // The demo row DOES go stale over that jump and alerts, which is correct — it
  // has work. The live side, having none, must stay silent.
  assert.deepEqual(
    alerts.filter(a => /exec engine/i.test(a) && !/\(demo\)/.test(a)),
    [], 'a side with nothing to serve never alerts')
})

test('THE COUNTERWEIGHT: enabling a live account makes the side answerable again', async () => {
  // The dangerous half of this change. If dormancy outlived the condition, the
  // live sidecar would sit silently "idle" through a real outage on the very
  // day it starts carrying money.
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  enable(db, 42993489, true, 0)
  const exec = splitExec(async () => ({ ok: false, mode: 'cpp', error: 'live sidecar unreachable' }))
  await probeCppExec(db, { exec, now: T0 })
  assert.equal(heartbeatView(db, { now: T0 }).find(c => c.name === 'cpp_exec').status, 'idle')

  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run('42993489')
  await probeCppExec(db, { exec, now: plus(120) })

  const row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name='cpp_exec'`).get()
  assert.equal(row.consecutive_failures, 1, 'the probe is live again and the failure is real')
  assert.equal(row.last_error, 'live sidecar unreachable')
  const view = heartbeatView(db, { now: plus(120) }).find(c => c.name === 'cpp_exec')
  assert.equal(view.dormant, undefined, 'the dormancy note must not outlive the dormancy')
  assert.equal(view.error_is_current, true)
})

test('dormancy is the narrowest claim: it needs accounts enabled on the OTHER side', async () => {
  // Three ways this could have silenced a probe that should be shouting.
  const probedWith = async (seed) => {
    const db = initDB(':memory:')
    seed(db)
    const probed = []
    const exec = splitExec(async ({ base } = {}) => {
      probed.push(base)
      return { ok: true, mode: 'cpp', connected: true, accounts: [1], lastReconcileAt: T0.getTime() - 30_000 }
    })
    await probeCppExec(db, { exec, now: T0 })
    return probed
  }
  // An empty registry is an UNCONFIGURED agent, not a side with no work.
  assert.equal((await probedWith(() => {})).length, 2, 'empty registry: both sides still probed')
  // Nothing enabled anywhere is the same situation with rows present.
  assert.equal((await probedWith((db) => { enable(db, 1, true, 0); enable(db, 2, false, 0) })).length, 2)
  // And a single sidecar (isLive null) serves whichever side the flag names, so
  // it can never be dormant however the registry looks.
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  const single = { ...execWithBases(), pingSidecar: async () => ({ ok: false, mode: 'cpp', error: 'down' }) }
  await probeCppExec(db, { exec: single, now: T0 })
  assert.equal(db.prepare(`SELECT consecutive_failures f FROM controller_heartbeats WHERE name='cpp_exec'`).get().f, 1)
})

test('checkAccountAuthorization: a demo account is judged by the DEMO sidecar, not the live one', () => {
  // THE FAKE-ALARM CASE. This check reads the registry with NO side filter — that
  // blindness is deliberate, and it is what made rosterDrift useless. But it means
  // a single roster measured against both sides would report every account on the
  // other side as disconnected while its own sidecar was perfectly healthy: the
  // alarm built for the 05-08 outage manufacturing one.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('900', 1, 1)`).run()
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('100', 0, 1)`).run()
  // Snapshot stamped AT the check time. A snapshot older than the 5-minute
  // staleness window reads as `unknown`, which would make this test pass
  // whatever the code did — the first draft did exactly that.
  const snap = (when) => {
    const at = when.toISOString()
    setState(db, 'cpp_exec_health_json', JSON.stringify({ accounts: ['900'], connected: true, at, side: 'live' }))
    setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ accounts: ['100'], connected: true, at, side: 'demo' }))
  }
  const notes = []
  snap(T0);        checkAccountAuthorization(db, { now: T0, notify: (t) => notes.push(t) })
  snap(plus(400)); const r = checkAccountAuthorization(db, { now: plus(400), notify: (t) => notes.push(t) })
  assert.deepEqual(notes, [], 'both accounts are on their own sidecar — nothing to alert')
  assert.deepEqual(r.events, [])
  // Positive control: the harness CAN see a disconnect. Drop 100 from the demo
  // roster and the very same call alerts.
  const demoDown = (when) => setState(db, 'cpp_exec_demo_health_json',
    JSON.stringify({ accounts: [], connected: true, at: when.toISOString(), side: 'demo' }))
  // Each observation carries a FRESH snapshot. A stale one reads as `unknown`,
  // and a long enough unknown window deliberately re-arms the dwell — correct
  // behaviour, and it silently ate the first version of this control.
  demoDown(plus(500)); checkAccountAuthorization(db, { now: plus(500), notify: (t) => notes.push(t) })
  assert.equal(notes.length, 0, 'dwell starts at the first disconnected observation')
  demoDown(plus(700)); checkAccountAuthorization(db, { now: plus(700), notify: (t) => notes.push(t) })
  assert.equal(notes.length, 0, 'still inside the 5-minute dwell')
  demoDown(plus(900)); checkAccountAuthorization(db, { now: plus(900), notify: (t) => notes.push(t) })
  assert.equal(notes.length, 1, 'and it DOES alert once the dwell is spent — the harness is not blind')
  assert.match(notes[0], /100/)
})

test('checkAccountAuthorization: a genuinely absent demo account still alerts under a split', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('900', 1, 1)`).run()
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('100', 0, 1)`).run()
  const snap = (when) => {
    const at = when.toISOString()
    setState(db, 'cpp_exec_health_json', JSON.stringify({ accounts: ['900'], connected: true, at, side: 'live' }))
    // Demo sidecar is up and holds NOTHING — the real outage shape.
    setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ accounts: [], connected: true, at, side: 'demo' }))
  }
  const notes = []
  snap(T0)
  checkAccountAuthorization(db, { now: T0, notify: (t) => notes.push(t) })
  assert.deepEqual(notes, [], 'silent before the dwell')
  snap(plus(400))
  const r = checkAccountAuthorization(db, { now: plus(400), notify: (t) => notes.push(t) })
  assert.equal(notes.length, 1)
  assert.match(notes[0], /100/)
  assert.ok(!notes[0].includes('900'), 'the healthy live account must not be dragged into it')
  assert.deepEqual(r.events.map(e => [e.accountId, e.event]), [['100', 'unauthorized']])
})

test('checkAccountAuthorization: with no demo snapshot, both sides use the single one (today)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('900', 1, 1)`).run()
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('100', 0, 1)`).run()
  const snap = (when) => setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['900'], connected: true, at: when.toISOString(), side: null,
  }))
  const notes = []
  snap(T0)
  checkAccountAuthorization(db, { now: T0, notify: (t) => notes.push(t) })
  snap(plus(400))
  const r = checkAccountAuthorization(db, { now: plus(400), notify: (t) => notes.push(t) })
  // 100 is absent from the ONE roster — which is exactly the 05-08 outage, and
  // it must still alert. Unchanged from #660.
  assert.equal(notes.length, 1)
  assert.match(notes[0], /100/)
  assert.deepEqual(r.events.map(e => e.accountId), ['100'])
})

test('probeCppExec: the credential-less self-heal pushes REAL creds, not a pending Promise', async () => {
  // REGRESSION, introduced by me in the Phase 2 refactor and caught against
  // production. `sideCreds` became async; this call site kept the old
  // synchronous shape, so `pushSidecarSession` received a PROMISE. It does not
  // throw on one — it reads `creds?.ready`, gets `undefined`, and returns false.
  //
  // Silent, and on the worst possible path: this is the M4 self-heal that
  // revives a sidecar which restarted and lost its credentials. Nothing else
  // re-pushes, because ensureSidecarSession memoises on an unchanged key. The
  // failure mode is a sidecar that stays dead until the AGENT restarts.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, is_live, enabled) VALUES ('100', 0, 1)`).run()
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '100')
  setState(db, 'ctrader_is_live', 'false')
  process.env.CTRADER_CLIENT_ID = 'ci'
  process.env.CTRADER_CLIENT_SECRET = 'cs'

  let pushedArg = 'NEVER CALLED'
  const exec = {
    ...execWithBases(),
    // A live HTTP server whose broker session is down and holds no credentials
    // — the exact shape that arms the self-heal.
    pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: false, hasCredentials: false }),
    pushSidecarSession: async (creds) => { pushedArg = creds; return !!creds?.ready },
  }
  await probeCppExec(db, { exec, now: T0 })

  assert.notEqual(pushedArg, 'NEVER CALLED', 'the self-heal must fire on a credential-less sidecar')
  assert.ok(!(pushedArg instanceof Promise), 'a Promise reaches pushSidecarSession as `ready: undefined` and pushes NOTHING')
  assert.equal(pushedArg.ready, true, 'and the resolved creds must actually be ready to push')
  assert.equal(pushedArg.host, 'demo.ctraderapi.com')
})

test('REVIEW FINDING: a side the global flag names is never dormant, however the registry reads', async () => {
  // The dangerous one. getCtraderCreds prepends the selected account with no
  // enabled test and takes its host from ctrader_is_live, so with the flag on
  // `live` and a DISABLED live account selected, trade guards / profit keeper /
  // the protection audit all keep dispatching to the live sidecar — while
  // enabledOnSide(true) is empty. Calling that side dormant would delete the
  // heartbeat of a sidecar carrying stop amendments: no beat, no probe, no
  // watchdog, under a panel saying it has nothing to serve.
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  enable(db, 42993489, true, 0)
  setState(db, 'ctrader_is_live', 'true')
  setState(db, 'ctrader_account_id', '42993489')

  const probed = []
  const exec = splitExec(async ({ base } = {}) => {
    probed.push(base)
    return { ok: false, mode: 'cpp', error: 'live sidecar unreachable' }
  })
  await probeCppExec(db, { exec, now: T0 })

  assert.ok(probed.includes('http://live:8091'), 'the side being written to is still probed')
  const row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name='cpp_exec'`).get()
  assert.equal(row.consecutive_failures, 1, 'and its failure is real, not silenced')

  // Flag pointing the other way, same registry → dormancy applies again.
  const db2 = initDB(':memory:')
  enable(db2, 46130058, false)
  enable(db2, 42993489, true, 0)
  setState(db2, 'ctrader_is_live', 'false')
  setState(db2, 'ctrader_account_id', '46130058')
  await probeCppExec(db2, { exec: splitExec(async () => ({ ok: true, mode: 'cpp', connected: true, accounts: [46130058], lastReconcileAt: T0.getTime() - 30_000 })), now: T0 })
  assert.equal(heartbeatView(db2, { now: T0 }).find(c => c.name === 'cpp_exec').status, 'idle')
})

test('REVIEW FINDING: the dormancy note expires — it is only as current as its probe', async () => {
  // Nothing clears the flag but a later probe of the same side, and EXEC_ENGINE=js
  // or a collapse back to one sidecar both stop that call happening at all. A
  // reason that cannot go stale is the same defect as an error that cannot go
  // away, which is what this whole change is against.
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  enable(db, 42993489, true, 0)
  await probeCppExec(db, {
    exec: splitExec(async () => ({ ok: true, mode: 'cpp', connected: true, accounts: [46130058], lastReconcileAt: T0.getTime() - 30_000 })),
    now: T0,
  })
  assert.equal(heartbeatView(db, { now: T0 }).find(c => c.name === 'cpp_exec').dormant, true)

  // Past the probe's own stall threshold, the specific claim is withdrawn and
  // the row falls back to a plain idle.
  const stale = heartbeatView(db, { now: plus(6 * 60) }).find(c => c.name === 'cpp_exec')
  assert.equal(stale.status, 'idle', 'still idle — the row is genuinely absent')
  assert.equal(stale.dormant, undefined, 'but it no longer asserts a current reason')
  assert.equal(stale.last_error, undefined)
})

test('the selected-account check resolves like getCtraderCreds — state key OR env', async () => {
  // Note 2 of the review: reading only the state key agrees today (index.js
  // seeds it from env at boot) and would disagree the moment that changes.
  // Matching the resolution makes the drift impossible rather than absent.
  const db = initDB(':memory:')
  enable(db, 46130058, false)
  enable(db, 42993489, true, 0)
  setState(db, 'ctrader_is_live', 'true')          // flag names live, state key EMPTY
  const prev = process.env.CTRADER_ACCOUNT_ID
  process.env.CTRADER_ACCOUNT_ID = '42993489'
  try {
    await probeCppExec(db, {
      exec: splitExec(async () => ({ ok: false, mode: 'cpp', error: 'live sidecar unreachable' })),
      now: T0,
    })
    const row = db.prepare(`SELECT * FROM controller_heartbeats WHERE name='cpp_exec'`).get()
    assert.ok(row, 'an env-selected account still counts as traffic on that side')
    assert.equal(row.consecutive_failures, 1)
  } finally {
    if (prev === undefined) delete process.env.CTRADER_ACCOUNT_ID
    else process.env.CTRADER_ACCOUNT_ID = prev
  }
})
