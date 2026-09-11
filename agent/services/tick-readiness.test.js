// agent/services/tick-readiness.test.js — P5: the per-account readiness read.
//
// Every check carries the READINESS_CHECK contract (what, ok, source,
// observed, at, class, remedy); a default account is NOT ready and says why
// in the plan's five classes; a fully evidenced demo account IS ready; a
// stale sidecar status or a wrong horizon flips one named check. Derived on
// every read: the tests write records and read again, nothing is cached.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, setState } from '../db.js'
import { upsertAccount, getAccountState } from './account-registry.js'
import { engineStatusFor, requestTickObservation, writeEngineStatus, ENGINE_STATUS_KEY } from './entry-mode.js'
import { setAccountHorizon } from './account-horizon.js'
import { READINESS_CHECK_SHAPE, BLOCK_CLASSES } from '../lib/entry-contracts.js'
import { profileHash, profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { importTickTrial } from './tick-research.js'
import { tickReadinessFor, tickReadinessView, tickSignalsView, RECORDER_STATUS_MAX_AGE_MS } from './tick-readiness.js'

const DEMO = '46979908', LIVE = '42993489'
const NOW = new Date('2026-09-11T06:00:00Z')
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  return db
}
function recorder(db, { side = 'cpp_exec_demo', at = NOW.toISOString(), state = 'RECORDING', recording = true, shadow = true, profile = profileHash(DEFAULT_PARAMS), usagePct = 12, dropped = 0, gaps = 1 } = {}) {
  setState(db, `${side}_tick_json`, JSON.stringify({ at, side, status: { enabled: true, state, recording, disk: { usagePct, availBytes: 40e9 }, events: { total: 1000, gaps, dropped }, strategy: { id: 'tick_momentum_breakout', version: 'v1', profileHash: profile, shadow, places: false } } }))
}
function pin(db, accountId, stage = 'SHADOW_PASSED') {
  writeEngineStatus(db, { ...engineStatusFor(db, accountId), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: stage, configRevision: engineStatusFor(db, accountId).configRevision + 1, updatedAt: NOW.toISOString() })
  importTickTrial(db, { trialId: 't1', strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: profileHash(DEFAULT_PARAMS), params: DEFAULT_PARAMS, sim: {}, manifest: {}, summary: { trades: 40 }, blocks: [] })
}

test('a default account is not ready, every check carries the contract, the reasons are classed, and reading writes nothing', () => {
  const db = fresh()
  const r = tickReadinessFor(db, DEMO, { now: NOW })
  assert.equal(r.ready, false)
  assert.equal(r.accountId, '…9908'); assert.equal(r.environment, 'demo'); assert.equal(r.side, 'cpp_exec_demo')
  for (const c of r.readiness) {
    for (const k of Object.keys(READINESS_CHECK_SHAPE)) assert.ok(k in c, `${c.check} lacks ${k}`)
    assert.equal(typeof c.ok, 'boolean')
    if (!c.ok) { assert.ok(BLOCK_CLASSES.includes(c.blockClass), `${c.check} class ${c.blockClass}`); assert.ok(c.remedy, `${c.check} names no remedy`) }
    else { assert.equal(c.blockClass, null); assert.equal(c.remedy, null) }
  }
  for (const want of ['observation_active', 'symbols_declared', 'recorder_status_fresh', 'recorder_recording', 'profile_pinned', 'replay_evidence', 'validation_stage']) assert.ok(r.blockedReasons.includes(want), want)
  for (const ok of ['account_registered', 'account_enabled', 'global_halt_clear', 'engine_record_valid', 'transition_stable', 'no_unknown_entries', 'horizon_admits_tick']) assert.ok(!r.blockedReasons.includes(ok), `${ok} should pass by default`)
  assert.ok(r.byClass.missing_evidence.includes('validation_stage'))
  assert.ok(r.byClass.infrastructure.includes('recorder_status_fresh'))
  assert.ok(r.byClass.operator_policy.includes('observation_active'))
  assert.equal(getAccountState(db, DEMO, ENGINE_STATUS_KEY), null, 'a read never writes')
  const v = tickReadinessView(db, { now: NOW })
  assert.equal(v.accounts.length, 2); assert.equal(v.readyCount, 0)
})

test('a fully evidenced account in SHADOW with a fresh recording sidecar on the same profile is ready — on demo AND on live, the same bar (PR-B)', () => {
  const db = fresh()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD', 'XAUUSD']))
  requestTickObservation(db, DEMO, 'SHADOW', { now: NOW })
  pin(db, DEMO, 'SHADOW_PASSED')
  recorder(db)
  const r = tickReadinessFor(db, DEMO, { now: NOW })
  assert.deepEqual(r.blockedReasons, [], JSON.stringify(r.readiness.filter(c => !c.ok)))
  assert.equal(r.ready, true)
  assert.equal(r.profileHash, profileHash(DEFAULT_PARAMS)); assert.equal(r.sidecarProfileHash, profileHash(DEFAULT_PARAMS))
  // live side: the same evidence IS enough (owner principle 1). RED if the
  // live → typed-approval clause returns to the validation_stage check.
  requestTickObservation(db, LIVE, 'SHADOW', { now: NOW })
  pin(db, LIVE, 'SHADOW_PASSED')
  recorder(db, { side: 'cpp_exec' })
  const l = tickReadinessFor(db, LIVE, { now: NOW })
  assert.deepEqual(l.blockedReasons, [], JSON.stringify(l.readiness.filter(c => !c.ok)))
  assert.equal(l.ready, true); assert.equal(l.side, 'cpp_exec', 'the side is routing, not policy')
  // REPLAY_PASSED is under the bar on both; TRADED_PASSED clears it on both; the remedy names no environment
  for (const id of [DEMO, LIVE]) {
    pin(db, id, 'REPLAY_PASSED')
    const under = tickReadinessFor(db, id, { now: NOW })
    assert.deepEqual(under.blockedReasons, ['validation_stage'])
    assert.doesNotMatch(under.readiness.find(c => c.check === 'validation_stage').remedy, /LIVE_APPROVED|DEMO_PASSED|live account/)
    pin(db, id, 'TRADED_PASSED')
    assert.equal(tickReadinessFor(db, id, { now: NOW }).ready, true)
  }
})

test('one stale or wrong input flips exactly its own check: recorder age, profile mismatch, shadow switch not converged, dropped events, the disk reserve, a swing horizon, a global halt, an UNKNOWN entry', () => {
  const db = fresh()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD']))
  requestTickObservation(db, DEMO, 'SHADOW', { now: NOW })
  pin(db, DEMO)
  const only = (r) => r.blockedReasons
  recorder(db, { at: new Date(NOW.getTime() - RECORDER_STATUS_MAX_AGE_MS - 1000).toISOString() })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['recorder_status_fresh'])
  recorder(db, { profile: '0000000000000000' })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['profile_matches_sidecar'])
  recorder(db, { shadow: false })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['shadow_strategy_running'])
  recorder(db, { dropped: 7 })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['feed_continuity'])
  recorder(db, { usagePct: 91 })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['disk_reserve_clear'])
  recorder(db, { state: 'PAUSED_RESERVE', recording: true })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })).sort(), ['disk_reserve_clear', 'recorder_recording'])
  recorder(db)
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), [])
  setAccountHorizon(db, DEMO, { horizon: 'swing' })
  const h = tickReadinessFor(db, DEMO, { now: NOW })
  assert.deepEqual(only(h), ['horizon_admits_tick'])
  assert.match(h.readiness.find(c => c.check === 'horizon_admits_tick').observed, /swing/)
  setAccountHorizon(db, DEMO, { horizon: 'intraday' })
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), [])
  setState(db, 'exec_guard_json', JSON.stringify({ halt: true }))
  assert.deepEqual(only(tickReadinessFor(db, DEMO, { now: NOW })), ['global_halt_clear'])
  setState(db, 'exec_guard_json', JSON.stringify({ halt: false }))
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, producer_id, basis, mode_epoch, config_revision, permit_id, permit_expires_at, state, created_at, updated_at)
              VALUES ('i1', ?, 'demo', 'EURUSD', 1, 'BUY', 'MARKET', 1000, 'scan_dispatch', 'bar', 0, 0, 'p1', ?, 'UNKNOWN', ?, ?)`).run(DEMO, NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
  const u = tickReadinessFor(db, DEMO, { now: NOW })
  assert.deepEqual(only(u), ['no_unknown_entries'])
  assert.equal(u.entryCounts.unknown, 1)
})

test('PR-H checker m-2: a live account in SHADOW whose sidecar reports enabled:false (no TICK_SPOOL_PATH) is told to set the spool path, not to wait for the guard sync to converge', () => {
  const db = fresh()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD']))
  requestTickObservation(db, LIVE, 'SHADOW', { now: NOW })
  pin(db, LIVE)
  setState(db, 'cpp_exec_tick_json', JSON.stringify({ at: NOW.toISOString(), side: 'cpp_exec', status: { enabled: false, reason: 'TICK_SPOOL_PATH not set' } }))
  const r = tickReadinessFor(db, LIVE, { now: NOW })
  const byName = Object.fromEntries(r.readiness.map(c => [c.check, c]))
  assert.equal(byName.shadow_strategy_running.ok, false)
  assert.match(byName.shadow_strategy_running.remedy, /no TICK_SPOOL_PATH/); assert.match(byName.shadow_strategy_running.remedy, /TM-27/); assert.doesNotMatch(byName.shadow_strategy_running.remedy, /check the next probe/)
  assert.equal(byName.shadow_strategy_running.blockClass, 'infrastructure')
  assert.match(byName.profile_matches_sidecar.remedy, /no TICK_SPOOL_PATH/); assert.equal(byName.profile_matches_sidecar.blockClass, 'infrastructure')
  assert.match(byName.recorder_recording.observed, /no TICK_SPOOL_PATH/)
  assert.equal(r.ready, false)
  // the same account against a sidecar WITH a spool whose switch has not converged keeps the probe remedy
  recorder(db, { side: 'cpp_exec', shadow: false })
  const c = tickReadinessFor(db, LIVE, { now: NOW }).readiness.find(x => x.check === 'shadow_strategy_running')
  assert.match(c.remedy, /check the next probe/); assert.equal(c.blockClass, 'integration_defect')
})

test('the signals view parses what the sidecar rang, names the symbol when the hours table knows the id, and counts per profile', () => {
  const db = fresh()
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id) VALUES ('EURUSD', 1)`).run()
  const prefix = profileHash(DEFAULT_PARAMS)
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES ('2026-09-11 05:00:00', 'cpp_exec_demo', 'b1', 1, 1000, 'tick', 'signal', 1, 'BUY', ?)`)
    .run(`shadow trigger2=1.1050 stop=0.000400 V=0.52 E=0.71 setup=3 profile=${prefix}`)
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES ('2026-09-11 05:01:00', 'cpp_exec_demo', 'b1', 2, 2000, 'tick', 'signal', 2, 'SELL', ?)`)
    .run('shadow trigger2=2 stop=0.1 V=0.4 E=0.6 setup=4 profile=ffffffffffffffff')
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES ('2026-09-11 05:02:00', 'cpp_exec_demo', 'b1', 3, 3000, 'tick', 'recording_changed', 0, 'on', 'x')`).run()
  const v = tickSignalsView(db)
  assert.equal(v.count, 2)
  const s = v.signals.find(x => x.symbolId === 1)
  assert.equal(s.symbol, 'EURUSD'); assert.equal(s.direction, 'BUY'); assert.equal(s.trigger2, 1.105); assert.equal(s.stopDistance, 0.0004); assert.equal(s.V, 0.52); assert.equal(s.E, 0.71); assert.equal(s.setupId, 3); assert.equal(s.profile, prefix)
  assert.equal(v.signals.find(x => x.symbolId === 2).symbol, null)
  assert.equal(v.byProfile[prefix], 1); assert.equal(v.byProfile.ffffffffffffffff, 1)
})
