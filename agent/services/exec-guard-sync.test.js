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
import { initDB, setState, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { desiredGuardFor, guardDiffers, syncExecGuard, resolveTickSymbolIds, resolveQuoteSymbols, tickSymbolNames, quoteSymbolNames, tickSymbolClassMap, TICK_COST_MAP_KEY, _resetTickResolveLogForTests, _resetTickClassLogForTests } from './exec-guard-sync.js'
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
  assert.deepEqual(Object.keys(g0), ['halt', 'haltAccounts', 'entryEpochs', 'tickRecord', 'tickShadow', 'tickShadowSim', 'tickEntryAccounts'])
  assert.deepEqual(g0.tickEntryAccounts, [], 'P6b: nobody places tick entries by default')
  {
    const { costs, ...flat } = g0.tickShadowSim
    assert.deepEqual(flat, { latencyMs: 250, slippage: 0, commissionPerSide: 0, targetR: 3, minTargetToCost: 3, maxHoldEvents: 0, maxHoldMs: 21600000 }, 'P6a: the repo\'s shadow sim rides the guard push')
    // PR-L: with RECORDING OFF there are no books, so the schedule is CLEARED
    // — an empty object, which main.cpp full-replaces to nothing. Leaving it
    // alone let a stale map stay installed while /health echoed a
    // legitimate-looking hash onto the evidence record (checker finding 6).
    assert.deepEqual(costs, { classes: {}, symbolClass: {}, fallbackClass: '' }, 'recording off clears the schedule rather than leaving a stale one')
    // the repo's own schedule, which the push carries once recording is on
    const { loadTickShadowSim } = await import('./exec-guard-sync.js')
    const repo = loadTickShadowSim().costs
    assert.deepEqual(Object.keys(repo.classes).sort(), ['commodity', 'crypto', 'fx', 'index_cfd', 'stock_hk', 'stock_us'])
    assert.equal(repo.fallbackClass, 'stock_hk', 'an unclassified symbol is charged the dearest class')
    assert.equal(repo.classes.stock_hk.commissionBpsPerSide, 15, 'MEASURED from the owner\'s statements')
    assert.equal(repo.classes.stock_us.commissionWirePerSide, 2000, 'MEASURED as a flat $0.02/share, not a rate')
    assert.equal(repo.classes.stock_us.commissionBpsPerSide, 0)
    // the legacy global pair stays 0 — it ADDS to the class row
    assert.equal(g0.tickShadowSim.slippage, 0); assert.equal(g0.tickShadowSim.commissionPerSide, 0)
  }
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
  // PR-L: the cost schedule travels WITH the symbols it prices — the keeper
  // is the only place that has both the name and this side's id, so the
  // id → class map is built here and stored per side for the shadow view.
  assert.deepEqual(pushes[0].tickShadowSim.costs.symbolClass, { 1: 'fx', 41: 'commodity' }, 'EURUSD is fx, XAUUSD is a commodity')
  assert.equal(pushes[0].tickShadowSim.costs.fallbackClass, 'stock_hk')
  assert.equal('tickCostUnclassified' in pushes[0], false, 'both names classified')
  {
    const stored = JSON.parse(getState(db, TICK_COST_MAP_KEY)).cpp_exec_demo
    assert.deepEqual(stored.symbolClass, { 1: 'fx', 41: 'commodity' })
    assert.match(stored.hash, /^[0-9a-f]{16}$/)
    assert.deepEqual(stored.unclassified, [])
  }
  // a name outside the taxonomy is REPORTED and charged the fallback — it is
  // not left out of the map and silently charged nothing.
  _resetTickClassLogForTests()
  const cls = tickSymbolClassMap([{ name: 'AAPL.US', id: 5 }, { name: 'SIE.DE', id: 6 }], pushes[0].tickShadowSim.costs, { name: 'cpp_exec_demo' })
  assert.deepEqual(cls.symbolClass, { 5: 'stock_us' })
  assert.deepEqual(cls.unclassified, ['SIE.DE'])
  assert.equal(cls.fallbackClass, 'stock_hk')
  // a sidecar running a different schedule is a difference the probe pushes
  const withCosts = { ...desired, tickShadowSim: pushes[0].tickShadowSim }
  const reportedSim = { ...pushes[0].tickShadowSim }
  assert.equal(guardDiffers(withCosts, { ...base, tick: { recording: true, subscribed: [1, 41], shadowSim: reportedSim } }), false, 'same schedule: converged')
  const drifted = { ...reportedSim, costs: { ...reportedSim.costs, classes: { ...reportedSim.costs.classes, fx: { commissionBpsPerSide: 99, slippageBpsPerSide: 0 } } } }
  assert.equal(guardDiffers(withCosts, { ...base, tick: { recording: true, subscribed: [1, 41], shadowSim: drifted } }), true, 'a different cost schedule is pushed')
  const unmapped = { ...reportedSim, costs: { ...reportedSim.costs, symbolClass: {} } }
  assert.equal(guardDiffers(withCosts, { ...base, tick: { recording: true, subscribed: [1, 41], shadowSim: unmapped } }), true, 'a sidecar pricing no symbol is pushed')
  const again = await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, {
    reportedGuard: base, reportedTick: { recording: true, subscribed: [1, 41] }, creds: { ready: true }, now, resolveSymbolId: resolve,
  })
  assert.equal(again.pushed, false, 'converged: no traffic')
})


// WHOLE-PLAN AUDIT 11-09-2026 (TM-10): a keeper that cannot read its own
// registry pushes a HALT, never an empty fence that requires no permit.
test('desiredGuardFor fails CLOSED when the registry is unreadable: halt true and the reason on the push', () => {
  const real = withAccounts(initDB(':memory:'))
  const broken = new Proxy(real, { get(t, k) { if (k === 'prepare') return (sql) => { if (/FROM accounts/.test(sql)) throw new Error('disk I/O error'); return t.prepare(sql) }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v } })
  const g = desiredGuardFor(broken, { isLive: null }, Date.now())
  assert.equal(g.halt, true)
  assert.match(g.degraded, /unreadable: disk I\/O error/)
  assert.deepEqual(g.entryEpochs, {})
  const ok = desiredGuardFor(real, { isLive: null }, Date.now())
  assert.equal(ok.halt, false); assert.equal('degraded' in ok, false)
})

test('P6b / PR-B: tickEntryAccounts lists every enabled account on the side whose EFFECTIVE mode is TICK_MOMENTUM and STABLE (live on its own side), and a sidecar reporting a different placing count is pushed', async () => {
  const { requestEntryMode, acknowledgeEntryEpochs, engineStatusFor } = await import('./entry-mode.js')
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: '46979908', isLive: false })
  upsertAccount(db, { accountId: '46130058', isLive: false })
  upsertAccount(db, { accountId: '42993489', isLive: true })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  const ready = () => ({ ready: true, blockedReasons: [] })
  const { profileHashFull, DEFAULT_PARAMS } = await import('../lib/tick-strategy.js')
  const { writeEngineStatus } = await import('./entry-mode.js')
  writeEngineStatus(db, { ...engineStatusFor(db, '46979908'), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: 1, updatedAt: new Date().toISOString() })
  const r = requestEntryMode(db, '46979908', 'TICK_MOMENTUM', { readiness: ready })
  assert.equal(r.ok, true)
  assert.deepEqual(desiredGuardFor(db, { isLive: false }).tickEntryAccounts, [], 'WARMING (not yet acknowledged) does not place')
  acknowledgeEntryEpochs(db, { 46979908: r.status.modeEpoch })
  assert.equal(engineStatusFor(db, '46979908').effectiveEntryMode, 'TICK_MOMENTUM')
  assert.deepEqual(desiredGuardFor(db, { isLive: false }).tickEntryAccounts, [46979908])
  assert.deepEqual(desiredGuardFor(db, { isLive: true }).tickEntryAccounts, [], 'the live side does not carry a demo account (routing)')
  // PR-B (owner principle 1): a live account in effective TICK_MOMENTUM is
  // listed on its own side. RED if the `is_live !== 1 && environment !== 'live'` term returns.
  writeEngineStatus(db, { ...engineStatusFor(db, '42993489'), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: 1, updatedAt: new Date().toISOString() })
  const rl = requestEntryMode(db, '42993489', 'TICK_MOMENTUM', { readiness: ready })
  assert.equal(rl.ok, true, `live admitted by readiness alone: ${rl.reason}`)
  acknowledgeEntryEpochs(db, { 42993489: rl.status.modeEpoch })
  assert.equal(engineStatusFor(db, '42993489').effectiveEntryMode, 'TICK_MOMENTUM')
  assert.deepEqual(desiredGuardFor(db, { isLive: true }).tickEntryAccounts, [42993489], 'the live side lists its own tick account')
  assert.deepEqual(desiredGuardFor(db, { isLive: null }).tickEntryAccounts, [42993489, 46979908])
  db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run('46979908')
  assert.deepEqual(desiredGuardFor(db, { isLive: false }).tickEntryAccounts, [], 'a disabled account leaves the list')
  const desired = { halt: false, haltAccounts: [], entryEpochs: {}, tickRecord: true, tickShadow: true, tickEntryAccounts: [46979908] }
  const reported = { halt: false, haltAccounts: [], entryEpochs: {}, tick: { recording: true, shadow: true, entry: { accounts: 0, places: false } } }
  assert.equal(guardDiffers(desired, reported), true, 'sidecar places for 0, keeper wants 1 → push')
  assert.equal(guardDiffers(desired, { ...reported, tick: { ...reported.tick, entry: { accounts: 1, places: true } } }), false)
  assert.equal(guardDiffers({ ...desired, tickEntryAccounts: [] }, { ...reported, tick: { ...reported.tick, entry: { accounts: 1, places: true } } }), true, 'sidecar still places for 1 after the account left → push clears it')
})

// CHECKER BLOCKER 2: an empty symbolClass is not "no opinion" — main.cpp
// full-replaces it, so every book then charges the fallback (15 bps HK), the
// cost screen refuses nearly every signal, and the shadow stops recording.
// Worse, it OVERWRITES a correct map the sidecar already holds. Both ways in
// are reachable and silent: `tick_symbols_json` empty is the documented
// default, and creds that are not ready resolve nothing.
test('PR-L: a push with no resolved symbol OMITS the cost schedule rather than sending an empty map', async () => {
  const db = withAccounts(initDB(':memory:'))
  const { requestTickObservation } = await import('./entry-mode.js')
  requestTickObservation(db, '111', 'SHADOW')
  const side = { name: 'cpp_exec_demo', isLive: false }
  const now = Date.now()
  const base = { halt: false, haltAccountCount: 0, entryEpochs: { 111: 0, 333: 0 } }
  const resolve = async (_db, _creds, name) => ({ id: name === 'EURUSD' ? 1 : 41, source: 'account' })
  _resetTickResolveLogForTests(); _resetTickClassLogForTests()

  // (a) the documented default: tick_symbols_json empty → nothing resolves
  setState(db, 'tick_symbols_json', JSON.stringify([]))
  const pushes = []
  const exec = { setExecGuard: async (_c, cfg) => { pushes.push(cfg); return { ok: true } } }
  const r1 = await syncExecGuard(db, exec, side, { reportedGuard: base, reportedTick: { recording: false, subscribed: [] }, creds: { ready: true }, now, resolveSymbolId: resolve, force: true })
  assert.equal(r1.pushed, true)
  assert.equal('costs' in pushes[0].tickShadowSim, false, 'no resolved symbol → the schedule is not pushed at all')
  assert.match(r1.desired.tickCostUnpriced, /no symbol resolved/)
  assert.equal(getState(db, TICK_COST_MAP_KEY), null, 'and nothing is stored as if it had been')

  // (b) creds not ready — same path, and it must NOT overwrite a good map the
  //     sidecar is already holding
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD', 'XAUUSD']))
  const good = await syncExecGuard(db, exec, side, { reportedGuard: base, reportedTick: { recording: false, subscribed: [] }, creds: { ready: true }, now, resolveSymbolId: resolve, force: true })
  assert.deepEqual(good.desired.tickShadowSim.costs.symbolClass, { 1: 'fx', 41: 'commodity' })
  const stored = JSON.parse(getState(db, TICK_COST_MAP_KEY)).cpp_exec_demo
  const r2 = await syncExecGuard(db, exec, side, { reportedGuard: base, reportedTick: { recording: true, subscribed: [1, 41], shadowSim: good.desired.tickShadowSim }, creds: { ready: false }, now, resolveSymbolId: resolve, force: true })
  assert.equal('costs' in r2.desired.tickShadowSim, false, 'unready creds must not push an empty map over a good one')
  assert.deepEqual(JSON.parse(getState(db, TICK_COST_MAP_KEY)).cpp_exec_demo, stored, 'the stored map is untouched')
  // and a push carrying no schedule is never a DIFFERENCE, so it does not flap
  assert.equal(guardDiffers(r2.desired, { ...base, tick: { recording: true, subscribed: [1, 41], shadowSim: good.desired.tickShadowSim } }), false)
})

test('19-09-2026 (checker SHOULD 2): the open positions\' symbols are pushed as a SEPARATE quotes-only list per side; the configured list is untouched; guardDiffers diffs both', async () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD', 'XAUUSD']))
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, created_at)
                          VALUES (?, 'BUY', 1, 0.9, 1.2, 0.1, ?, ?, 'trend', ?, datetime('now'))`)
  ins.run('gbpusd', 'active', 'autopilot', '111')   // demo, open
  ins.run('USDJPY', 'active', 'autopilot', '222')   // live, open
  ins.run('AUDUSD', 'active', 'autopilot', null)    // no account row → both sides
  ins.run('NZDUSD', 'closed', 'autopilot', '111')   // closed → not carried
  ins.run('USDCAD', 'active', 'external', '111')    // observe-only → not priced, not carried
  ins.run('EURUSD', 'active', 'autopilot', '111')   // also configured → dropped from the quote list by id below
  assert.deepEqual(tickSymbolNames(db), ['EURUSD', 'XAUUSD'], 'the readiness page, the permit feeder and the state route see the configured list only')
  assert.deepEqual(quoteSymbolNames(db, { isLive: false }), ['GBPUSD', 'AUDUSD', 'EURUSD'])
  assert.deepEqual(quoteSymbolNames(db, { isLive: true }), ['USDJPY', 'AUDUSD'])
  assert.deepEqual(quoteSymbolNames(db, { isLive: null }), ['GBPUSD', 'USDJPY', 'AUDUSD', 'EURUSD'], 'one sidecar for both sides carries every open symbol')
  // the push: two lists, the quote list minus the configured ids
  _resetTickResolveLogForTests()
  const ids = { EURUSD: 1, XAUUSD: 41, GBPUSD: 2, AUDUSD: 3, USDJPY: 4 }
  const resolve = async (_db, _creds, name) => ({ id: ids[name] ?? null, source: 'account' })
  const { requestTickObservation } = await import('./entry-mode.js')
  requestTickObservation(db, '111', 'RECORD')
  let sent = null
  const exec = { setExecGuard: async (_c, body) => { sent = body; return { ok: true } } }
  const seenCreds = new Set()
  const resolveRec = async (creds, ...rest) => { seenCreds.add(String(creds?.accountId)); return resolve(null, creds, ...rest) }
  const r = await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, { creds: { ready: true, accountId: '111' }, resolveSymbolId: (_db, creds, name) => resolveRec(creds, name), reportedGuard: null })
  assert.equal(r.pushed, true)
  assert.deepEqual([...seenCreds], ['111'], 'no feed account reported → resolved under sideCreds, as before')
  assert.deepEqual(sent.tickSymbolIds, [1, 41], 'the configured universe — the recorder and the strategy read this and only this')
  assert.deepEqual(sent.quoteSymbolIds, [2, 3], 'the open positions, quotes-only; EURUSD (1) already configured is not repeated')
  assert.deepEqual(await resolveQuoteSymbols(db, { ready: false }, { isLive: false }, { resolveSymbolId: resolve }), [], 'no creds, no ids')
  // checker round 2: the sidecar reports the FEED account (the first /connect on the side, kept while in
  // the roster) — the ids are resolved in THAT account's space, not sideCreds' primary
  seenCreds.clear()
  const r2 = await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, { creds: { ready: true, accountId: '111' }, resolveSymbolId: (_db, creds, name) => resolveRec(creds, name), reportedGuard: { halt: false, haltAccountCount: 0, tick: { recording: true, feedAccountId: 333, subscribed: [] } }, force: true })
  assert.equal(r2.pushed, true)
  assert.deepEqual([...seenCreds], ['333'], 'resolved with the feed account\'s creds')
  seenCreds.clear()
  await syncExecGuard(db, exec, { name: 'cpp_exec_demo', isLive: false }, { creds: { ready: true, accountId: '111' }, resolveSymbolId: (_db, creds, name) => resolveRec(creds, name), reportedGuard: { halt: false, haltAccountCount: 0 }, reportedTick: { recording: true, feedAccountId: '333', subscribed: [] }, force: true })
  assert.deepEqual([...seenCreds], ['333'], 'reportedTick carries it too')
  // a side with tick observation OFF pushes no quote list (its positions stay on the broker path)
  const live = desiredGuardFor(db, { isLive: true }, Date.now())
  assert.equal(live.tickRecord, false)
  let sentLive = null
  await syncExecGuard(db, { setExecGuard: async (_c, body) => { sentLive = body; return { ok: true } } }, { name: 'cpp_exec', isLive: true }, { creds: { ready: true, accountId: '222' }, resolveSymbolId: resolve, reportedGuard: null })
  assert.equal(sentLive.quoteSymbolIds, undefined)
  assert.equal(sentLive.tickSymbolIds, undefined)
  // the diff: an uncarried symbol on EITHER list is a push; both carried → quiet
  const desired = { halt: false, haltAccounts: [], entryEpochs: { 111: 0, 333: 0 }, tickRecord: true, tickSymbolIds: [1, 41], quoteSymbolIds: [2, 3] }
  const base = { halt: false, haltAccountCount: 0, entryEpochs: { 111: 0, 333: 0 } }
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: true, subscribed: [1, 41] } }), true, 'an open position\'s symbol not carried → push')
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: true, subscribed: [1, 2, 3] } }), true, 'a configured symbol not carried → push')
  assert.equal(guardDiffers(desired, { ...base, tick: { recording: true, subscribed: [1, 41, 2, 3, 7] } }), false, 'both carried → quiet (unchanged → no push)')
})
