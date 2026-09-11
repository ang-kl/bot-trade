// node --test agent/services/exec-guard-sync.test.js
//
// Declarative convergence of the C++ order guard (2026-08-31 supervision
// plan). The load-bearing properties: the derivation is a pure truth table
// over durable state; per-account halts stay per-account and SELF-CLEAR at
// the FX-day rollover; the performance breaker's default-off stays inert (a
// mutation test asserting ABSENCE of a halt); and the sync pushes only on a
// real diff — an in-sync sidecar gets no traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { desiredGuardFor, guardDiffers, syncExecGuard } from './exec-guard-sync.js'
import { trippedKey } from './equity-stop.js'
import { fxDayOpenMs } from '../lib/volume-structure.js'

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('333','3',0,0,'active')`).run() // disabled
  return db
}

test('derivation truth table: stored guard, 5A halt, equity trips per side', async () => {
  const db = withAccounts(initDB(':memory:'))
  const now = Date.now()

  // Nothing stored, nothing tripped → open guard, empty set. P2a: every
  // registry account's entry epoch rides along (0 until a switch), scoped
  // to the side asked for.
  const g0 = desiredGuardFor(db, { isLive: null }, now)
  assert.equal(g0.halt, false); assert.deepEqual(g0.haltAccounts, [])
  assert.ok('111' in g0.entryEpochs, 'the demo account is fenced from epoch 0')
  assert.ok(Object.values(g0.entryEpochs).every(e => e === 0))
  assert.deepEqual(Object.keys(g0), ['halt', 'haltAccounts', 'entryEpochs'])
  {
    const { requestEntryMode } = await import('./entry-mode.js')
    requestEntryMode(db, '111', 'STOPPED')
    assert.equal(desiredGuardFor(db, { isLive: null }, now).entryEpochs['111'], 1, 'a switch moves the pushed epoch')
    assert.equal(desiredGuardFor(db, { isLive: false }, now).entryEpochs['111'], 1)
    assert.ok(!('111' in desiredGuardFor(db, { isLive: true }, now).entryEpochs), 'the live side does not carry a demo account')
    requestEntryMode(db, '111', 'TIME_BASED', { expectedRevision: 1 })
  }

  // Stored knobs pass through; halt from exec_guard_json binds.
  setState(db, 'exec_guard_json', JSON.stringify({ halt: true, requireBracket: true, maxOrderVolume: 5 }))
  let g = desiredGuardFor(db, { isLive: null }, now)
  assert.equal(g.halt, true)
  assert.equal(g.requireBracket, true)
  assert.equal(g.maxOrderVolume, 5)

  // 5A portfolio halt binds even with the stored guard open.
  setState(db, 'exec_guard_json', '{}')
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))
  assert.equal(desiredGuardFor(db, { isLive: null }, now).halt, true)
  setState(db, 'global_guards_json', '{}')

  // An equity-stop trip TODAY puts that account — and only it — in the set,
  // scoped to its own side.
  setState(db, trippedKey('111'), new Date(now).toISOString())
  g = desiredGuardFor(db, { isLive: null }, now)
  assert.deepEqual(g.haltAccounts, [111])
  assert.equal(g.halt, false, 'a per-account trip must NOT become a process halt')
  assert.deepEqual(desiredGuardFor(db, { isLive: false }, now).haltAccounts, [111], 'demo side sees its trip')
  assert.deepEqual(desiredGuardFor(db, { isLive: true }, now).haltAccounts, [], 'live side does not')

  // Disabled accounts never enter the set.
  setState(db, trippedKey('333'), new Date(now).toISOString())
  assert.deepEqual(desiredGuardFor(db, { isLive: null }, now).haltAccounts, [111])
})

test('the un-halt is automatic: a trip from BEFORE the FX-day open ages out', () => {
  const db = withAccounts(initDB(':memory:'))
  const now = Date.now()
  const dayOpen = fxDayOpenMs(now)
  setState(db, trippedKey('111'), new Date(dayOpen - 60_000).toISOString()) // last FX day
  assert.deepEqual(desiredGuardFor(db, { isLive: null }, now).haltAccounts, [],
    'FX-day rollover empties the derived set — no imperative un-halt to forget')
})

test('performance breaker default-off contributes NOTHING (absence asserted)', () => {
  const db = withAccounts(initDB(':memory:'))
  // Master autotrade off + breaker at defaults (autoDisarm OFF, owner order):
  // the halt must stay false — mirroring an unarmed breaker would invent an
  // automatic stop the owner explicitly declined twice.
  setState(db, 'autotrade_enabled', 'false')
  assert.equal(desiredGuardFor(db, { isLive: null }).halt, false)
  // Armed breaker + master off → the machine was authorized to stop, mirror it.
  setState(db, 'performance_breaker_json', JSON.stringify({ autoDisarm: true }))
  assert.equal(desiredGuardFor(db, { isLive: null }).halt, true)
  // Armed breaker + master ON → trading, no halt.
  setState(db, 'autotrade_enabled', 'true')
  assert.equal(desiredGuardFor(db, { isLive: null }).halt, false)
})

test('guardDiffers: unknown pushes, in-sync stays quiet, each field can trip it', () => {
  const desired = { halt: false, haltAccounts: [111], requireBracket: true }
  assert.equal(guardDiffers(desired, null), true, 'no reported guard → push')
  const inSync = { halt: false, haltAccountCount: 1, requireBracket: true, requireTarget: true, maxOrderVolume: 0 }
  assert.equal(guardDiffers(desired, inSync), false)
  assert.equal(guardDiffers(desired, { ...inSync, halt: true }), true)
  assert.equal(guardDiffers(desired, { ...inSync, haltAccountCount: 0 }), true)
  assert.equal(guardDiffers(desired, { ...inSync, requireBracket: false }), true)
  assert.equal(guardDiffers({ ...desired, maxOrderVolume: 5 }, inSync), true)
})

test('syncExecGuard pushes on diff, logs GUARD_SYNC, and stays silent in sync', async () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, trippedKey('111'), new Date().toISOString())
  const pushes = []
  const exec = { setExecGuard: async (_creds, cfg) => { pushes.push(cfg); return { ok: true } } }

  const r1 = await syncExecGuard(db, exec, { isLive: false, name: 'cpp_exec_demo' },
    { reportedGuard: { halt: false, haltAccountCount: 0 }, creds: { ready: true } })
  assert.equal(r1.pushed, true)
  assert.deepEqual(pushes[0].haltAccounts, [111])
  assert.equal(pushes[0].entryEpochs['111'], 0, 'P2a: the entry epochs ride on the same push')
  const audit = db.prepare(`SELECT method, path FROM action_log WHERE method = 'GUARD_SYNC'`).all()
  assert.equal(audit.length, 1)

  // Sidecar now reports the converged guard → NO push (absence asserted).
  const r2 = await syncExecGuard(db, exec, { isLive: false, name: 'cpp_exec_demo' },
    { reportedGuard: { halt: false, haltAccountCount: 1, entryEpochs: pushes[0].entryEpochs }, creds: { ready: true } })
  assert.equal(r2.pushed, false)
  assert.equal(pushes.length, 1, 'an in-sync sidecar gets no traffic')

  // An older sidecar that reports no epochs, or one holding a stale epoch, is pushed.
  const r3 = await syncExecGuard(db, exec, { isLive: false, name: 'cpp_exec_demo' },
    { reportedGuard: { halt: false, haltAccountCount: 1, entryEpochs: { ...pushes[0].entryEpochs, 111: 5 } }, creds: { ready: true } })
  assert.equal(r3.pushed, true)
  assert.equal(pushes.length, 2)
})
