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
import { desiredGuardFor, guardDiffers, syncExecGuard, resolveTickSymbolIds, tickSymbolNames, _resetTickResolveLogForTests } from './exec-guard-sync.js'
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
  assert.deepEqual(Object.keys(g0), ['halt', 'haltAccounts', 'entryEpochs', 'tickRecord', 'tickShadow'])
  assert.equal(g0.tickRecord, false, 'P3a: recording is off unless an account asks')
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

test('AUDIT 11-09-2026 (B05): halt accounts are compared by IDENTITY when the sidecar reports the list — two swapped for two others is a diff; an older sidecar reporting only the count is compared by count', () => {
  const desired = { halt: false, haltAccounts: [111, 222] }
  assert.equal(guardDiffers(desired, { halt: false, haltAccounts: [222, 111] }), false, 'order does not matter')
  assert.equal(guardDiffers(desired, { halt: false, haltAccounts: [111, 333] }), true, 'same count, different account')
  assert.equal(guardDiffers(desired, { halt: false, haltAccounts: [111] }), true)
  assert.equal(guardDiffers(desired, { halt: false, haltAccounts: ['111', '222'], haltAccountCount: 2 }), false, 'the list wins over the count, as numbers')
  assert.equal(guardDiffers(desired, { halt: false, haltAccountCount: 2 }), false, 'count only: the old comparison')
})

test('AUDIT 11-09-2026 (plan §3.6): the sidecar\'s echoed epochs ACKNOWLEDGE a WARMING account on the probe and on the push\'s own reply; force pushes even when nothing differs', async () => {
  const db = withAccounts(initDB(':memory:'))
  const { requestEntryMode, engineStatusFor } = await import('./entry-mode.js')
  requestEntryMode(db, '111', 'STOPPED')
  const r = requestEntryMode(db, '111', 'TIME_BASED', { expectedRevision: 1 })
  assert.equal(r.status.transitionState, 'WARMING'); assert.equal(r.status.modeEpoch, 2)
  const pushes = []
  // the sidecar's /config reply echoes the epochs it bound
  const exec = { setExecGuard: async (_creds, cfg) => { pushes.push(cfg); return { ok: true, entryEpochs: cfg.entryEpochs } } }
  const side = { isLive: false, name: 'cpp_exec_demo' }
  // 1. a probe whose report already carries the epoch acknowledges without a push
  const probe = await syncExecGuard(db, exec, side, { reportedGuard: { halt: false, haltAccounts: [], entryEpochs: { 111: 2, 333: 0 } }, creds: { ready: true } })
  assert.equal(probe.pushed, false); assert.equal(probe.acked.length, 1); assert.equal(probe.acked[0].transitionState, 'STABLE')
  assert.equal(engineStatusFor(db, '111').effectiveEntryMode, 'TIME_BASED'); assert.equal(engineStatusFor(db, '111').fenceAckEpoch, 2)
  // 2. a new switch: the route's forced push binds it from the reply
  const rev = () => engineStatusFor(db, '111').configRevision
  const r2 = requestEntryMode(db, '111', 'STOPPED', { expectedRevision: rev() })
  assert.equal(r2.ok, true)
  const r3 = requestEntryMode(db, '111', 'TIME_BASED', { expectedRevision: rev() })
  assert.equal(r3.status.transitionState, 'WARMING'); assert.equal(r3.status.modeEpoch, 4)
  const pushed = await syncExecGuard(db, exec, side, { reportedGuard: null, creds: { ready: true }, force: true })
  assert.equal(pushed.pushed, true); assert.deepEqual(pushed.echoed, pushes[0].entryEpochs)
  assert.equal(pushed.acked.length, 1); assert.equal(pushed.acked[0].epoch, 4); assert.equal(pushed.acked[0].transitionState, 'STABLE')
  assert.equal(engineStatusFor(db, '111').effectiveEntryMode, 'TIME_BASED')
  // 3. force pushes an in-sync guard too; nothing left to acknowledge
  const forced = await syncExecGuard(db, exec, side, { reportedGuard: { halt: false, haltAccounts: [], entryEpochs: pushes[0].entryEpochs }, creds: { ready: true }, force: true })
  assert.equal(forced.pushed, true); assert.equal(forced.acked.length, 0); assert.equal(pushes.length, 2)
  // 4. a JS-mode push (no sidecar to bind) counts as acknowledged for what it was asked to set
  requestEntryMode(db, '111', 'STOPPED', { expectedRevision: rev() })
  const r5 = requestEntryMode(db, '111', 'TIME_BASED', { expectedRevision: rev() })
  assert.equal(r5.status.transitionState, 'WARMING')
  const js = await syncExecGuard(db, { setExecGuard: async () => ({ ok: true, mode: 'js' }) }, side, { reportedGuard: null, creds: { ready: true }, force: true })
  assert.equal(js.acked.length, 1); assert.equal(engineStatusFor(db, '111').transitionState, 'STABLE')
  // 5. a refused push acknowledges nothing and reports the error
  requestEntryMode(db, '111', 'STOPPED', { expectedRevision: rev() })
  assert.equal(requestEntryMode(db, '111', 'TIME_BASED', { expectedRevision: rev() }).ok, true)
  const bad = await syncExecGuard(db, { setExecGuard: async () => ({ ok: false, error: '502' }) }, side, { reportedGuard: null, creds: { ready: true }, force: true })
  assert.equal(bad.pushed, false); assert.equal(bad.error, '502'); assert.equal(engineStatusFor(db, '111').transitionState, 'WARMING')
})

test('P3a: an account in RECORD switches its side on; the names resolve to ids per side; the diff reads the sidecar\'s tick object', async () => {
  const db = withAccounts(initDB(':memory:'))
  const now = Date.now()
  const { requestTickObservation } = await import('./entry-mode.js')
  assert.equal(desiredGuardFor(db, { isLive: false }, now).tickRecord, false)
  const r = requestTickObservation(db, '111', 'RECORD')
  assert.equal(r.ok, true); assert.equal(r.status.tickObservation, 'RECORD'); assert.equal(r.status.modeEpoch, 0, 'observation moves no entry epoch')
  assert.equal(desiredGuardFor(db, { isLive: false }, now).tickRecord, true, 'the demo side records')
  assert.equal(desiredGuardFor(db, { isLive: true }, now).tickRecord, false, 'the live side does not')
  assert.equal(desiredGuardFor(db, { isLive: null }, now).tickRecord, true)
  db.prepare("UPDATE accounts SET enabled = 0 WHERE account_id = '111'").run()
  assert.equal(desiredGuardFor(db, { isLive: false }, now).tickRecord, false, 'a disabled account asks for nothing')
  db.prepare("UPDATE accounts SET enabled = 1 WHERE account_id = '111'").run()

  // names → ids with an injected resolver (the real one reads the broker's symbol map)
  setState(db, 'tick_symbols_json', JSON.stringify(['eurusd', 'XAUUSD', 'nope', 'EURUSD']))
  assert.deepEqual(tickSymbolNames(db), ['EURUSD', 'XAUUSD', 'NOPE'])
  _resetTickResolveLogForTests()
  const seen = []
  const resolve = async (_db, _creds, name) => { seen.push(name); return name === 'NOPE' ? { id: null } : { id: name === 'EURUSD' ? 1 : 41, source: 'account' } }
  const ids = await resolveTickSymbolIds(db, { ready: true }, { name: 'cpp_exec_demo' }, { resolveSymbolId: resolve })
  assert.deepEqual(ids, [1, 41])
  assert.deepEqual(seen, ['EURUSD', 'XAUUSD', 'NOPE'])
  assert.deepEqual(await resolveTickSymbolIds(db, { ready: false }, { name: 'x' }, { resolveSymbolId: resolve }), [], 'no creds, no ids')

  // the diff: only against a sidecar that reports a recorder
  const desired = { halt: false, haltAccounts: [], entryEpochs: { 111: 0, 333: 0 }, tickRecord: true, tickSymbolIds: [1, 41] }
  const base = { halt: false, haltAccountCount: 0, entryEpochs: { 111: 0, 333: 0 } } // the demo side's two registry rows, epoch 0
  assert.equal(guardDiffers(desired, { ...base, tick: null }), false, 'no recorder on that sidecar → nothing to converge')
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: false, subscribed: [1, 41] } }), true, 'switch differs')
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: true, subscribed: [1] } }), true, 'a wanted symbol is not carried')
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: true, subscribed: [1, 41, 7] } }), false, 'in sync (extra carried symbols are fine)')
  assert.equal(guardDiffers({ ...desired, tickRecord: false, tickSymbolIds: [] }, { ...base, tick: { recording: false, subscribed: [] } }), false)
  // P4: the shadow switch converges the same way
  assert.equal(guardDiffers({ ...desired, tickShadow: true }, { ...base, tick: { recording: true, shadow: false, subscribed: [1, 41] } }), true)
  assert.equal(guardDiffers({ ...desired, tickShadow: true }, { ...base, tick: { recording: true, shadow: true, subscribed: [1, 41] } }), false)
  requestTickObservation(db, '111', 'SHADOW')
  const gs = desiredGuardFor(db, { isLive: false }, now)
  assert.equal(gs.tickRecord, true); assert.equal(gs.tickShadow, true, 'SHADOW records and shadows')

  // the sync pushes the resolved ids with the switch
  const pushes = []
  const exec = { setExecGuard: async (_c, cfg) => { pushes.push(cfg); return { ok: true } } }
  const out = await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, {
    reportedGuard: base, reportedTick: { recording: false, subscribed: [] }, creds: { ready: true }, now, resolveSymbolId: resolve,
  })
  assert.equal(out.pushed, true)
  assert.equal(pushes[0].tickRecord, true); assert.deepEqual(pushes[0].tickSymbolIds, [1, 41])
  const again = await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, {
    reportedGuard: base, reportedTick: { recording: true, subscribed: [1, 41] }, creds: { ready: true }, now, resolveSymbolId: resolve,
  })
  assert.equal(again.pushed, false, 'converged: no traffic')
})
