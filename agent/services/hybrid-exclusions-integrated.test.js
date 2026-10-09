// Codex · №12,559 · 2026-10-09; codex-footprint: hybrid-exclusion-verdicts.
// Actual Node enrolment/pass/configuration and SQLite, controlled broker replies.
// These cases establish diagnostic persistence, never production trade outcomes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initDB, getState, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { scene } from '../test-support/hybrid-scene.js'
import { readCappedHybridOwner, readCappedHybridVerdict } from './capped-hybrid-policy.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { readMomentumPartialPass, runMomentumPartialPass } from './momentum-partial-runtime.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { hybridGroups, startHybridTickController, HYBRID_TICK_STATUS } from './hybrid-tick-controller.js'
import { readHybridVerdicts } from './diagnostic-readout.js'

const owner = f => readCappedHybridOwner(f.db, '42', 7, '33', 2)
const verdict = f => readCappedHybridVerdict(f.db, '42', 7, '33', 2)
const monitor = f => f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
const stored = f => readMomentumPartialPass(f.db).cappedHybrid
const reopen = (f, path) => { f.db.close(); f.db = initDB(path) }
const enrol = f => enrolCappedHybrids(f.db, { credsFor: () => f.creds, now: () => f.at, transports: f.transports })

function exclusion(row, f, reason) {
  assert.ok(row, `missing exclusion ${reason}`)
  assert.equal(row.accountId, '42'); assert.equal(row.tradeId, 7); assert.equal(row.positionId, '33')
  assert.equal(row.stage, 'ownership'); assert.equal(row.reason, reason); assert.equal(row.observedAtMs, f.at)
}

test('external NAS-like monitor: real pass stores an owned exclusion across reopen without broker access or changed protection', async t => {
  const path = join(tempDir('hybrid-excluded-'), 'ledger.db'), f = scene(t, { path })
  // Keep the bot trade/intent internally consistent, but retain the actual
  // external monitor boundary that previously vanished before examined++.
  f.db.prepare("UPDATE trades SET symbol='NAS100' WHERE id=7").run()
  f.db.prepare("UPDATE entry_intents SET symbol='NAS100' WHERE id='entry-7'").run()
  f.db.prepare("UPDATE monitored_positions SET symbol='NAS100',source='external' WHERE id=8").run()
  const before = monitor(f), result = await f.pass()
  assert.equal(result.ok, true); assert.equal(result.cappedHybrid.examined, 0)
  exclusion(result.cappedHybrid.excluded[0], f, 'monitor_external')
  assert.deepEqual(result.cappedHybrid.enrolled, []); assert.deepEqual(result.cappedHybrid.deferred, [])
  assert.deepEqual(f.reads, []); assert.deepEqual(f.closes, []); assert.deepEqual(monitor(f), before)
  reopen(f, path)
  exclusion(stored(f).excluded[0], f, 'monitor_external')
  const projected = readHybridVerdicts(f.db).momentum_partial_pass_json.cappedHybrid
  exclusion(projected.excluded.rows[0], f, 'monitor_external')
  assert.deepEqual(monitor(f), before); assert.equal(f.events().length, 0)
})

test('ordinary pass logs a stored exclusion once, but a rejected SQLite write cannot claim the changed reason was stored', async t => {
  const f = scene(t), logs = []
  f.db.prepare("UPDATE monitored_positions SET source='external' WHERE id=8").run()
  const before = monitor(f), prefix = '[hybrid-enrolment] '
  const run = () => runMomentumPartialPass(f.db, { credsFor: () => f.creds, now: () => f.at,
    log: line => logs.push(line), deps: { hybridEnrolment: { transports: f.transports }, adapterFor: () => f.adapter() } })
  assert.equal((await run()).ok, true)
  const emitted = logs.filter(line => line.startsWith(prefix))
  assert.equal(emitted.length, 1)
  const claim = JSON.parse(emitted[0].slice(prefix.length))
  assert.equal(claim.stored, true); assert.equal(claim.rows[0].reason, 'monitor_external')
  exclusion(stored(f).excluded[0], f, 'monitor_external')
  f.at += 1000
  assert.equal((await run()).ok, true)
  assert.equal(logs.filter(line => line.startsWith(prefix)).length, 1, 'a newer observation with the same reason is not another changed verdict')
  const lastStored = getState(f.db, 'momentum_partial_pass_json')
  f.db.prepare("UPDATE trades SET origin='external' WHERE id=7").run()
  f.db.exec(`CREATE TRIGGER deny_hybrid_pass_record BEFORE UPDATE ON agent_state
    WHEN NEW.key='momentum_partial_pass_json'
    BEGIN SELECT RAISE(ABORT, 'controlled diagnostic storage failure'); END`)
  logs.length = 0; f.at += 1000
  const failed = await run()
  assert.equal(failed.ok, false)
  assert.ok(failed.errors.some(error => error.startsWith('record_write:')), JSON.stringify(failed.errors))
  exclusion(failed.cappedHybrid.excluded[0], f, 'trade_origin_not_bot')
  assert.equal(logs.some(line => line.startsWith(prefix)), false, 'an uncommitted verdict has no stored claim')
  assert.equal(getState(f.db, 'momentum_partial_pass_json'), lastStored, 'the last successful observation remains intact')
  assert.deepEqual(monitor(f), before); assert.deepEqual(f.reads, []); assert.equal(f.closes.length, 0)
  assert.equal(f.sl, before.current_sl); assert.equal(f.tp, before.current_tp); assert.equal(f.events().length, 0)
})

const gates = [
  ['trade_origin_not_bot', f => f.db.prepare("UPDATE trades SET origin='external' WHERE id=7").run()],
  ['monitor_external', f => f.db.prepare("UPDATE monitored_positions SET source='external' WHERE id=8").run()],
  ['monitor_paused', f => f.db.prepare('UPDATE monitored_positions SET paused=1 WHERE id=8').run()],
  ['entry_intent_missing', f => f.db.prepare("DELETE FROM entry_intents WHERE id='entry-7'").run()],
  ['strategy_not_momentum', f => {
    f.db.prepare("UPDATE trades SET strategy='rsi2_reversion',label_strategy='rsi2_reversion' WHERE id=7").run()
    f.db.prepare("UPDATE monitored_positions SET strategy='rsi2_reversion' WHERE id=8").run()
  }],
  ['competing_profit_policy', f => setState(f.db, 'managed_exit_json', JSON.stringify({ on: true, takeAtR: 1, takeAtRFamilies: ['trend'] }))],
]
for (const [reason, change] of gates) test(`actual ownership gate ${reason} stays closed and becomes a stored explanation`, async t => {
  const f = scene(t)
  assert.ok(owner(f)); assert.deepEqual(verdict(f).owner, owner(f)); assert.equal(verdict(f).reason, null)
  change(f)
  const before = monitor(f)
  assert.equal(owner(f), null); assert.equal(verdict(f).owner, null); assert.equal(verdict(f).reason, reason)
  const result = await f.pass()
  assert.equal(result.cappedHybrid.examined, 0)
  exclusion(stored(f).excluded.find(r => r.tradeId === 7), f, reason)
  exclusion(readHybridVerdicts(f.db).momentum_partial_pass_json.cappedHybrid.excluded.rows[0], f, reason)
  assert.deepEqual(f.reads, []); assert.equal(f.closes.length, 0); assert.equal(f.events().length, 0)
  assert.deepEqual(monitor(f), before)
})

for (const [side, live] of [['BUY', false], ['SELL', true]]) test(`${side} ${live ? 'live' : 'demo'}: existing and completed plans are delegated, with one unchanged half fill`, async t => {
  const path = join(tempDir('hybrid-delegated-'), 'ledger.db'), f = scene(t, { path, side, live })
  const before = monitor(f)
  // First enrol at a quote short of the trigger. The real partial manager
  // owns the later fill; diagnostic delegation must not create another plan.
  f.bid = 100; f.ask = 100.1
  assert.equal((await f.pass()).cappedHybrid.enrolled.length, 1)
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'ARMED')
  const armed = await f.pass(), delegated = armed.cappedHybrid.delegated[0]
  assert.equal(delegated.reason, 'existing_partial_plan'); assert.equal(delegated.planState, 'ARMED')
  assert.deepEqual(armed.cappedHybrid.excluded, []); assert.deepEqual(armed.cappedHybrid.enrolled, [])
  f.at += 61_000; f.bid = side === 'BUY' ? 120 : 79.9; f.ask = side === 'BUY' ? 120.1 : 80
  await f.pass()
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
  assert.equal(f.closes.length, 1); assert.equal(f.closes[0].volume, 5000); assert.equal(f.volume, 5000)
  const done = await f.pass()
  assert.equal(done.cappedHybrid.delegated[0].planState, 'CONFIRMED')
  assert.equal(done.cappedHybrid.delegated[0].reason, 'existing_partial_plan')
  assert.deepEqual(done.cappedHybrid.excluded, []); assert.deepEqual(done.cappedHybrid.enrolled, [])
  reopen(f, path)
  assert.equal(stored(f).delegated[0].planState, 'CONFIRMED')
  assert.equal(readHybridVerdicts(f.db).momentum_partial_pass_json.cappedHybrid.delegated.rows[0].reason, 'existing_partial_plan')
  assert.equal(f.events().length, 1); assert.equal(f.closes.length, 1)
  assert.deepEqual(monitor(f), { ...before, scaled_out: 1 })
  assert.equal(f.sl, before.current_sl); assert.equal(f.tp, before.current_tp)
})

// Copy controlled ledger rows, preserving their real ownership relationships.
// No production records, diagnostic verdicts or broker outcomes are seeded.
function duplicateOwner(f, tradeId) {
  const copy = (table, key, value, changed) => {
    const row = { ...f.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value), ...changed }
    const columns = Object.keys(row)
    f.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k]))
  }
  const intent = `entry-${tradeId}`, position = String(1000 + tradeId)
  copy('entry_intents', 'id', 'entry-7', { id: intent, permit_id: `permit-${tradeId}`, broker_position_id: position, broker_order_id: String(2000 + tradeId) })
  copy('trades', 'id', 7, { id: tradeId, ctrader_position_id: position, intent_id: intent })
  copy('monitored_positions', 'id', 8, { id: tradeId + 1000, trade_id: tradeId })
}

for (const outsideCandidateQuery of [true, false]) test(`128-record diagnostic bound reports ${outsideCandidateQuery ? 'unseen open coverage' : 'dropped observed exclusions'} without broker work`, async t => {
  const f = scene(t)
  for (let tradeId = 100; tradeId < 228; tradeId++) duplicateOwner(f, tradeId)
  if (outsideCandidateQuery) f.db.prepare('UPDATE monitored_positions SET paused=1').run()
  else {
    f.db.prepare("UPDATE trades SET strategy='rsi2_reversion',label_strategy='rsi2_reversion'").run()
    f.db.prepare("UPDATE monitored_positions SET strategy='rsi2_reversion'").run()
  }
  const result = (await f.pass()).cappedHybrid
  assert.equal(result.coverage.limit, 128); assert.equal(result.coverage.openTradesSampled, 128)
  assert.equal(result.coverage.openTradesTruncated, true); assert.equal(result.excluded.length, 128)
  assert.equal(result.excludedTruncated, !outsideCandidateQuery)
  assert.equal(new Set(result.excluded.map(r => `${r.accountId}:${r.tradeId}`)).size, 128)
  assert.equal(result.examined, 0); assert.deepEqual(f.reads, []); assert.equal(f.closes.length, 0)
  const projected = readHybridVerdicts(f.db).momentum_partial_pass_json.cappedHybrid
  assert.equal(projected.excluded.truncated, true, 'the private projection also discloses its smaller row bound')
})

for (const configureFails of [false, true]) test(`gateway ${configureFails ? 'failed' : 'successful'} configuration retains ownership diagnostics and ordinary routing to the other host`, async t => {
  const path = join(tempDir('hybrid-config-excluded-'), 'ledger.db'), f = scene(t, { path })
  assert.equal((await enrol(f)).enrolled.length, 1)
  f.db.prepare('UPDATE monitored_positions SET paused=1 WHERE id=8').run()
  f.reads.length = 0
  const own = {}, other = {}, otherHost = 'live.ctraderapi.com'
  assert.deepEqual(hybridGroups(f.db, f.host, { now: () => f.at, credsFor: () => f.creds, diagnostics: own }), [])
  assert.equal(own.excluded[0].reason, 'monitor_paused')
  assert.deepEqual(hybridGroups(f.db, otherHost, { now: () => f.at, credsFor: () => f.creds, diagnostics: other }), [])
  assert.deepEqual(other.excluded, []); assert.equal(other.routedElsewhere, 1)
  const configurations = [], timers = []
  const stop = startHybridTickController(f.db, { now: () => f.at, credsFor: () => f.creds, log: () => {},
    setTimer: fn => { const timer = { fn }; timers.push(timer); return timer }, clearTimer: timer => { timer.cleared = true },
    transport: {
      configure: async (host, groups) => {
        configurations.push({ host, groups })
        if (configureFails && host === f.host) throw Error('controlled configuration unavailable')
      },
      events: async () => ({ ready: true, events: [] }), acknowledge: async () => assert.fail('no event was offered'),
    } })
  t.after(stop)
  for (let i = 0; i < 100 && timers.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
  stop()
  assert.equal(configurations.length, 2); assert.ok(configurations.every(c => c.groups.length === 0))
  assert.ok(timers.every(timer => timer.cleared))
  reopen(f, path)
  const status = JSON.parse(getState(f.db, HYBRID_TICK_STATUS))
  assert.equal(status.hosts[f.host].configuration.excluded[0].reason, 'monitor_paused')
  assert.deepEqual(status.hosts[otherHost].configuration.excluded, [])
  assert.equal(status.hosts[otherHost].configuration.routedElsewhere, 1)
  assert.equal(status.hosts[f.host].error, configureFails ? 'controlled configuration unavailable' : null)
  assert.equal(status.hosts[otherHost].error, null)
  const projected = readHybridVerdicts(f.db).hybrid_tick_controller_json.hosts.find(h => h.host === f.host)
  assert.equal(projected.configuration.excluded.rows[0].reason, 'monitor_paused')
  assert.deepEqual(f.reads, []); assert.equal(f.closes.length, 0); assert.equal(f.events().length, 0)
})

for (const reason of ['plan_invalid', 'plan_ownership_mismatch', 'own_credentials_unavailable']) test(`gateway configuration explains ${reason} without changing the saved plan`, async t => {
  const f = scene(t)
  assert.equal((await enrol(f)).enrolled.length, 1)
  let credsFor = () => f.creds
  if (reason === 'plan_invalid') {
    const plan = readPartialPlan(f.db, '42', 7).plan
    f.db.prepare('UPDATE momentum_partial_plans SET plan_json=?').run(JSON.stringify({ ...plan, trigger: plan.trigger + 1 }))
  } else if (reason === 'plan_ownership_mismatch') {
    const identity = readPartialPlan(f.db, '42', 7).identity
    f.db.prepare('UPDATE momentum_partial_plans SET identity_json=?').run(JSON.stringify({ ...identity, symbolId: '23' }))
  } else credsFor = () => null
  const before = readPartialPlan(f.db, '42', 7), diagnostics = {}
  f.reads.length = 0
  assert.deepEqual(hybridGroups(f.db, f.host, { now: () => f.at, credsFor, diagnostics }), [])
  assert.equal(diagnostics.excluded[0].reason, reason)
  assert.deepEqual(readPartialPlan(f.db, '42', 7), before)
  assert.deepEqual(f.reads, []); assert.equal(f.closes.length, 0)
})

for (const reason of ['existing_tp_caps_before_runner', 'half_and_runner_not_representable']) test(`later broker-read refusal ${reason} retains its owned inputs and existing protection`, async t => {
  const f = scene(t, reason === 'half_and_runner_not_representable' ? { volume: 300, step: 100 } : {})
  if (reason === 'existing_tp_caps_before_runner') {
    f.tp = 120
    f.db.prepare('UPDATE trades SET tp_price=120 WHERE id=7').run()
    f.db.prepare('UPDATE monitored_positions SET current_tp=120 WHERE id=8').run()
  }
  const before = monitor(f), protection = { sl: f.sl, tp: f.tp }
  const result = (await f.pass()).cappedHybrid
  assert.equal(result.examined, 1); assert.deepEqual(result.excluded, []); assert.deepEqual(result.enrolled, [])
  const refused = result.deferred.find(r => r.tradeId === 7)
  assert.equal(refused.reason, reason)
  assert.deepEqual({ accountId: refused.volumeInputs.accountId, positionId: refused.volumeInputs.positionId,
    volume: refused.volumeInputs.volume, halfVolume: refused.volumeInputs.halfVolume, minVolume: refused.volumeInputs.minVolume,
    stepVolume: refused.volumeInputs.stepVolume, units: refused.volumeInputs.units },
  { accountId: '42', positionId: '33', volume: f.volume, halfVolume: f.volume / 2, minVolume: 100, stepVolume: 100, units: 'ctrader_protocol_volume' })
  assert.deepEqual(stored(f).deferred, result.deferred)
  assert.deepEqual(monitor(f), before); assert.deepEqual({ sl: f.sl, tp: f.tp }, protection)
  assert.equal(f.closes.length, 0); assert.equal(f.events().length, 0)
})
