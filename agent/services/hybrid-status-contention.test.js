// Codex · №12,611 · 2026-10-09; codex-footprint: hybrid-status-contention.
// Actual controller and file SQLite; only native/broker boundaries are controlled.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { getState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { scene } from '../test-support/hybrid-scene.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { hybridSpec, HYBRID_TICK_STATUS, startHybridTickController } from './hybrid-tick-controller.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function instrument(t, f) {
  const attempts = [], probe = f.db.prepare('SELECT 1'), proto = Object.getPrototypeOf(probe), run = proto.run
  proto.run = function (...args) {
    if (this.database !== f.db || !this.source.startsWith('INSERT INTO agent_state') || args[0] !== HYBRID_TICK_STATUS)
      return Reflect.apply(run, this, args)
    const row = { code: null }; attempts.push(row)
    try { return Reflect.apply(run, this, args) } catch (error) { row.code = error.code; throw error }
  }
  t.after(() => { proto.run = run })
  return attempts
}
async function consumer(t, f, extra = {}) {
  const timers = [], logs = [], observed = { reads: 0, configs: 0, acks: 0 }
  const stop = startHybridTickController(f.db, { now: () => f.at, credsFor: () => f.creds,
    transports: f.transports, log: value => logs.push(value),
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
    transport: {
      configure: async () => { observed.configs++ },
      events: async () => { observed.reads++; return { ready: true, events: [] } },
      acknowledge: async () => { observed.acks++ }, ...extra,
    } })
  t.after(stop)
  await settle()
  return { timers, logs, observed, stop, async round(ms) {
    f.at += ms
    const pending = timers.splice(0)
    for (const timer of pending) timer.fn()
    await settle()
  } }
}
const fixture = t => scene(t, { path: join(tempDir('hybrid-status-'), 'ledger.db') })

test('empty native polls retain both host outcomes but coalesce file-backed status commits across hosts', async t => {
  const f = fixture(t), attempts = instrument(t, f), c = await consumer(t, f)
  assert.equal(attempts.length, 1, 'one initial snapshot contains both hosts')
  assert.equal(Object.keys(JSON.parse(getState(f.db, HYBRID_TICK_STATUS)).hosts).length, 2)
  for (let i = 0; i < 40; i++) await c.round(25)
  assert.equal(c.observed.reads, 82, 'tick event polling cadence is unchanged')
  assert.equal(c.observed.configs, 2)
  assert.equal(attempts.length, 2, 'one shared heartbeat commit per second, not 80 empty-poll writes')
  assert.equal(f.closes.length, 0); assert.equal(c.observed.acks, 0)
})

test('a real competing WAL writer causes one status attempt, retains its code/stage, then recovers without losing the refusal', async t => {
  const f = fixture(t), attempts = instrument(t, f), c = await consumer(t, f)
  f.db.pragma('busy_timeout=25')
  const peer = new Database(f.db.name, { fileMustExist: true, timeout: 0 })
  t.after(() => peer.close())
  peer.exec('BEGIN IMMEDIATE')
  peer.prepare("INSERT INTO agent_state(key,value) VALUES('controlled_status_holder','held')").run()
  attempts.length = 0; f.at += 1000
  c.timers.shift().fn(); await settle()
  assert.equal(attempts.length, 1, 'a failed status write is not synchronously retried in catch')
  assert.equal(attempts[0].code, 'SQLITE_BUSY')
  assert.match(c.logs.at(-1), /stage=status_write.*storageCode=SQLITE_BUSY/)
  assert.equal(c.timers.at(-1).ms, 5000)
  peer.exec('ROLLBACK')
  c.timers.shift().fn(); await settle()
  assert.equal(attempts.length, 1, 'the other host shares the failed-attempt cadence')
  await c.round(1000)
  const status = JSON.parse(getState(f.db, HYBRID_TICK_STATUS))
  const failed = Object.values(status.hosts).find(host => host.errors === 1)
  assert.deepEqual(failed.lastError, { at: f.at - 1000, stage: 'status_write', storageCode: 'SQLITE_BUSY' })
  assert.equal(failed.error, null, 'successful read can recover without deleting the retained failure')
  assert.equal(f.closes.length, 0)
})

test('transport failure inside the coalesced interval remains recorded in the next successful snapshot', async t => {
  const f = fixture(t), attempts = instrument(t, f)
  let fail = false
  const c = await consumer(t, f, { events: async host => {
    if (fail && host === f.host) throw Error('controlled native read unavailable')
    return { ready: true, events: [] }
  } })
  fail = true; await c.round(25)
  const failedAt = f.at
  assert.equal(attempts.length, 1, 'diagnostic error does not add writes inside the cadence')
  fail = false; await c.round(1000)
  const pending = JSON.parse(getState(f.db, HYBRID_TICK_STATUS)).hosts[f.host]
  assert.equal(pending.lastError.stage, 'events_read', 'peer snapshot retains the failure before this host recovers')
  await c.round(1000)
  const host = JSON.parse(getState(f.db, HYBRID_TICK_STATUS)).hosts[f.host]
  assert.equal(host.error, null)
  assert.equal(host.errors, 1)
  assert.deepEqual(host.lastError, { at: failedAt, stage: 'events_read', storageCode: null })
})

test('a pending peer cannot indefinitely prevent the healthy host from recording status', async t => {
  const f = fixture(t), attempts = instrument(t, f)
  let release
  const pending = new Promise(resolve => { release = resolve })
  const c = await consumer(t, f, { events: host => host === f.host ? pending : Promise.resolve({ ready: true, events: [] }) })
  assert.equal(attempts.length, 0, 'initial host snapshots can coalesce briefly')
  await c.round(1000)
  assert.equal(attempts.length, 1)
  const status = JSON.parse(getState(f.db, HYBRID_TICK_STATUS))
  assert.equal(status.hosts['live.ctraderapi.com'].lastReadAt, f.at)
  assert.equal(status.hosts[f.host].lastReadAt, undefined, 'do not invent a pending peer read')
  c.stop(); release({ ready: true, events: [] }); await settle()
})

test('coalesced status cannot defer the durable trigger, claim, wire, residual or scale-out journal', async t => {
  const f = fixture(t)
  assert.equal((await enrolCappedHybrids(f.db, { now: () => f.at, credsFor: () => f.creds, transports: f.transports })).enrolled.length, 1)
  const attempts = instrument(t, f)
  let offered = false, event, acknowledged = 0
  const c = await consumer(t, f, { events: async host => {
    const events = event && !offered && host === f.host ? [event] : []
    if (events.length) offered = true
    return { ready: true, events }
  }, acknowledge: async (_, id) => {
    assert.equal(id, event.eventId)
    const row = f.db.prepare('SELECT * FROM hybrid_tick_receipts WHERE event_id=?').get(id)
    assert.equal(JSON.parse(row.outcome_json).state, 'CONFIRMED')
    assert.ok(row.wire_response_json)
    assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
    assert.equal(f.events().length, 1)
    acknowledged++
  } })
  const before = f.db.prepare('SELECT current_sl,current_tp,entry_price FROM monitored_positions WHERE id=8').get()
  const spec = hybridSpec(readPartialPlan(f.db, '42', 7), f.at)
  event = { ...spec, kind: 'trigger', version: 1, eventId: 'd'.repeat(32) + ':1',
    bid: f.bid, ask: f.ask, receivedAtMs: f.at, observedAtMs: f.at, brokerAtMs: f.at,
    bidAtMs: f.at, askAtMs: f.at, bidBrokerAtMs: f.at, askBrokerAtMs: f.at,
    persistedAtMs: f.at, source: 'owned_native_spot_tick' }
  await c.round(25)
  assert.equal(attempts.length, 1, 'status is still coalesced')
  assert.equal(acknowledged, 1); assert.equal(f.closes.length, 1)
  assert.equal(readPartialPlan(f.db, '42', 7).evidence.observation.volume, 5000)
  assert.deepEqual(f.db.prepare('SELECT current_sl,current_tp,entry_price FROM monitored_positions WHERE id=8').get(), before)
  c.stop(); f.db.close(); f.db = new Database(f.db.name, { fileMustExist: true })
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
  assert.equal(f.events().length, 1)
})
