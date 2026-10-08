// Codex · №12,324 · 2026-10-09; codex-footprint: actual tick/DB/broker-boundary tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { scene } from '../test-support/hybrid-scene.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { readPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { hybridSpec, hybridGroups, processHybridTick, startHybridTickController } from './hybrid-tick-controller.js'

async function prepare(t, options = {}) {
  const f = scene(t, options)
  const result = await enrolCappedHybrids(f.db, { credsFor: () => f.creds, now: () => f.at, transports: f.transports })
  assert.equal(result.enrolled.length, 1)
  f.spec = hybridSpec(readPartialPlan(f.db, '42', 7), f.at)
  f.event = { ...f.spec, kind: 'trigger', version: 1, eventId: 'a'.repeat(32) + ':1',
    bid: f.bid, ask: f.ask, receivedAtMs: f.at, observedAtMs: f.at, brokerAtMs: f.at,
    bidAtMs: f.at, askAtMs: f.at, bidBrokerAtMs: f.at, askBrokerAtMs: f.at,
    persistedAtMs: f.at, source: 'owned_native_spot_tick', feedGeneration: 1, decisionNs: 1234 }
  f.tick = (event = f.event) => processHybridTick(f.db, f.host, event,
    { now: () => f.at, credsFor: () => f.creds, transports: f.transports })
  return f
}
for (const live of [false, true]) for (const side of ['BUY', 'SELL']) {
  test(`${live ? 'live' : 'demo'} ${side}: actual enrolled plan, native tick, partial and residual survive DB reopen`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hybrid-tick-')), path = join(dir, 'ledger.db')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const f = await prepare(t, { live, side, path })
    const before = f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
    const wire = f.transports.close
    f.transports.close = async (...args) => {
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM hybrid_tick_receipts').get().n, 1, 'trigger committed before broker send')
      return wire(...args)
    }
    assert.equal((await f.tick()).state, 'CONFIRMED')
    assert.equal(f.closes.length, 1); assert.equal(f.closes[0].volume, 5000)
    const after = f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
    assert.equal(after.current_sl, before.current_sl); assert.equal(after.current_tp, before.current_tp)
    assert.equal(after.entry_price, before.entry_price); assert.equal(after.scaled_out, 1)
    f.db.close(); f.db = initDB(path)
    const receipt = f.db.prepare('SELECT * FROM hybrid_tick_receipts').get()
    assert.deepEqual(JSON.parse(receipt.raw_json), f.event)
    assert.equal(JSON.parse(receipt.wire_response_json).deal.dealId, '44')
    assert.equal(JSON.parse(receipt.outcome_json).state, 'CONFIRMED')
    const row = readPartialPlan(f.db, '42', 7)
    assert.equal(row.state, 'CONFIRMED'); assert.equal(f.events().length, 1)
    assert.equal(JSON.parse(f.events()[0].detail_json).residualEvidence.observation.volume, 5000)
    await f.tick(); assert.equal(f.closes.length, 1); assert.equal(f.events().length, 1)
  })
}

test('wrong host/account/symbol/position/plan and stale side clocks cannot send', async t => {
  for (const changed of [{ accountId: '43' }, { symbolId: '23' }, { positionId: '34' },
    { key: 'b'.repeat(64) }, { host: 'live.ctraderapi.com' },
    { bidAtMs: 1791460794000, observedAtMs: 1791460794000 },
    { bidBrokerAtMs: 1791460794000, brokerAtMs: 1791460794000 }]) {
    const f = await prepare(t)
    if (changed.host) await assert.rejects(f.tick({ ...f.event, ...changed }), /identity/)
    else assert.equal((await f.tick({ ...f.event, ...changed })).state, 'REFUSED')
    assert.equal(f.closes.length, 0)
  }
})

test('owner pause after enrolment removes subscriptions and refuses an already queued tick', async t => {
  const f = await prepare(t)
  assert.equal(hybridGroups(f.db, f.host, { now: () => f.at, credsFor: () => f.creds }).length, 1)
  f.db.prepare('UPDATE monitored_positions SET paused=1 WHERE id=8').run()
  assert.deepEqual(hybridGroups(f.db, f.host, { now: () => f.at, credsFor: () => f.creds }), [])
  assert.equal((await f.tick()).state, 'REFUSED'); assert.equal(f.closes.length, 0)
})

test('ordinary manager racing the native tick shares one durable close claim', async t => {
  const f = await prepare(t)
  await Promise.all([f.tick(), runPartialPlan(f.db, f.creds, 7, f.adapter())])
  assert.equal(f.closes.length, 1); assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
  await f.tick(); assert.equal(f.closes.length, 1)
})

test('trigger persistence failure prevents any broker close', async t => {
  const f = await prepare(t)
  // Create the receipt schema through a refused event, then fail the actual insert.
  await f.tick({ ...f.event, key: 'b'.repeat(64), eventId: 'a'.repeat(32) + ':2' })
  f.db.exec("CREATE TRIGGER no_tick BEFORE INSERT ON hybrid_tick_receipts BEGIN SELECT RAISE(ABORT,'disk unavailable'); END")
  await assert.rejects(f.tick(), /disk unavailable/); assert.equal(f.closes.length, 0)
})

test('raw broker response write failure leaves ambiguous intent and never resends', async t => {
  const f = await prepare(t)
  await f.tick({ ...f.event, key: 'b'.repeat(64), eventId: 'a'.repeat(32) + ':2' })
  f.db.exec("CREATE TRIGGER no_wire BEFORE UPDATE OF wire_response_json ON hybrid_tick_receipts BEGIN SELECT RAISE(ABORT,'disk unavailable'); END")
  assert.equal((await f.tick()).state, 'AMBIGUOUS')
  assert.equal(f.closes.length, 1); await f.tick(); assert.equal(f.closes.length, 1)
  assert.equal(f.events().length, 0)
})

test('closing-history request cannot ask beyond the current broker-read clock', async t => {
  const f = await prepare(t), bounds = []
  const read = f.transports.deals
  f.transports.deals = async (...args) => { bounds.push(args[6]); return read(...args) }
  await f.adapter().readClosingDeals(f.creds, '33')
  assert.deepEqual(bounds, [f.at])
})

test('both host consumers configure, process durable events, and acknowledge after the stored verdict', async t => {
  const f = await prepare(t, { live: true }), configurations = [], timers = [], logs = [], acknowledged = []
  let delivered = false
  const stop = startHybridTickController(f.db, { now: () => f.at, credsFor: () => f.creds,
    transports: f.transports, log: x => logs.push(x),
    setTimer: fn => { const timer = { fn }; timers.push(timer); return timer }, clearTimer: timer => { timer.cleared = true },
    transport: {
      configure: async (host, groups) => configurations.push({ host, groups }),
      events: async host => { const events = host === f.host && !delivered ? [f.event] : []; if (events.length) delivered = true; return { ready: true, events } },
      acknowledge: async (host, eventId) => {
        assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
        assert.equal(JSON.parse(f.db.prepare('SELECT outcome_json FROM hybrid_tick_receipts WHERE event_id=?').get(eventId).outcome_json).state, 'CONFIRMED')
        acknowledged.push({ host, eventId })
      },
    } })
  for (let i = 0; i < 100 && timers.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
  stop()
  assert.equal(configurations.length, 2); assert.equal(configurations.find(c => c.host === f.host).groups.length, 1)
  assert.equal(configurations.find(c => c.host !== f.host).groups.length, 0)
  assert.deepEqual(acknowledged, [{ host: f.host, eventId: f.event.eventId }])
  assert.equal(f.closes.length, 1); assert.ok(timers.every(x => x.cleared))
  const proof = JSON.parse(logs.find(x => x.startsWith('[hybrid-tick-proof] ')).slice('[hybrid-tick-proof] '.length))
  assert.equal(proof.wireStored, true); assert.equal(proof.receipt.dealId, '44')
  assert.deepEqual(proof.residual, readPartialPlan(f.db, '42', 7).evidence)
  assert.equal(proof.journalId, f.events()[0].id)
})
