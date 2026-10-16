// Claude · № 15,144 16-Oct (owner: "C·2 Policy, build class-aware routing"
// after § 15,128; claude-builder). node --test agent/services/class-routing-view.test.js
//
// The read-only view and its route, against a real in-memory database, the
// real loader (the checked-in policy) and a primed class map. The expected
// classes are the broker's (see lib/asset-class.test.js); the routed row is
// shaped as runFibScan writes it.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stateRouter from '../routes/state.js'
import { classRoutingView, scanUniverse } from './class-routing-view.js'
import { primeAssetClasses, _resetAssetClassesForTests } from '../lib/asset-class.js'
import { _resetClassRoutingForTests } from '../lib/class-routing.js'
import { accountSignals } from './account-signals.js'
import { upsertAccount } from './account-registry.js'
import { writeWatchlist } from './watchlists.js'

const TREE = { builtAt: '2026-10-15T06:40:32.557Z', classes: [
  { name: 'Energies (Spot)', categories: [{ name: 'Default Category', symbols: ['NATGAS', 'SPOTCRUDE'] }] },
  { name: 'Forex (Spot)', categories: [{ name: 'FX Majors', symbols: ['EURUSD'] }] },
  { name: 'Crypto Currency (Spot)', categories: [{ name: 'Default Category', symbols: ['BTCUSD'] }] },
  { name: 'US Equities (CFDs)', categories: [{ name: 'US Equities', symbols: ['AAPL.US'] }] },
] }

function seed(t) {
  _resetAssetClassesForTests(); _resetClassRoutingForTests()
  primeAssetClasses(TREE)
  const db = initDB(':memory:'); t.after(() => { db.close(); _resetAssetClassesForTests() })
  setState(db, 'autopilot_symbols_json', JSON.stringify([
    { symbol: 'NATGAS', enabled: true }, { symbol: 'natgas', enabled: true }, { symbol: 'SPOTCRUDE', enabled: true },
    'EURUSD', { symbol: 'BTCUSD', enabled: true }, { symbol: 'AAPL.US', enabled: false }, { symbol: 'AUS200', enabled: true }, { symbol: 'HK50', force_skip: true },
  ]))
  const ins = db.prepare('INSERT INTO scans (symbol, bias, confidence, thesis, timeframe, strategy, trade_grade, scanned_at, loop_id) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run('NATGAS', 'skip', 7, 'ROUTED OUT (class energy): donchian_breakout long — donchian_breakout long routed out of symbol NATGAS by class-routing.json token "*:long" · broke the 20-bar high', '1h', 'donchian_breakout', 'routed', '2026-10-16T01:00:00.000Z', 9)
  ins.run('SPOTCRUDE', 'skip', 6, 'ROUTED OUT (class energy): va_breakout long — va_breakout long routed out of class energy by class-routing.json token "va_breakout:long"', '4h', 'va_breakout', 'routed', '2026-10-16T01:00:00.000Z', 9)
  ins.run('EURUSD', 'long', 8, 'ok', '4h', 'ema_pullback', 'potential', '2026-10-16T01:00:00.000Z', 9)
  ins.run('NATGAS', 'long', 7, 'older routed row', '1h', 'donchian_breakout', 'routed', '2026-10-15T01:00:00.000Z', 8)
  return db
}

test('scanUniverse reads the shared list exactly as loop.js does: strings normalised, disabled and force_skip rows out', (t) => {
  const db = seed(t)
  assert.deepEqual(scanUniverse(db).map(w => w.symbol), ['NATGAS', 'natgas', 'SPOTCRUDE', 'EURUSD', 'BTCUSD', 'AUS200'])
})

test('the view: policy, classes with sources, tiers, blocks per symbol, and the latest batch\'s routed rows', (t) => {
  const db = seed(t)
  const v = classRoutingView(db)
  assert.equal(v.enabled, true); assert.equal(v.source, 'file'); assert.deepEqual(v.warnings, [])
  assert.deepEqual(v.scanShare, { prioritySlots: 8, priorityMaxRank: 3 })
  assert.deepEqual(v.symbols.map(s => s.symbol), ['NATGAS', 'SPOTCRUDE', 'EURUSD', 'BTCUSD', 'AUS200'], 'deduped, upper-cased')
  const by = Object.fromEntries(v.symbols.map(s => [s.symbol, s]))
  assert.deepEqual({ cls: by.NATGAS.cls, source: by.NATGAS.source, tier: by.NATGAS.tier, priority: by.NATGAS.priority }, { cls: 'energy', source: 'broker_tree', tier: 'B', priority: 5 })
  assert.deepEqual(by.NATGAS.blocked, [{ token: '*:long', source: 'symbol NATGAS' }, { token: 'va_breakout:long', source: 'class energy' }])
  assert.deepEqual(by.SPOTCRUDE.blocked, [{ token: 'va_breakout:long', source: 'class energy' }])
  assert.deepEqual({ cls: by.EURUSD.cls, tier: by.EURUSD.tier, blocked: by.EURUSD.blocked }, { cls: 'fx', tier: 'A', blocked: [] })
  assert.equal(by.BTCUSD.tier, 'A')
  assert.deepEqual({ cls: by.AUS200.cls, source: by.AUS200.source, tier: by.AUS200.tier }, { cls: 'other', source: 'unknown', tier: 'B' }, 'not in the fixture tree → unknown, visible as such')
  assert.deepEqual(v.classSources, { broker_tree: 4, unknown: 1 })
  assert.equal(v.classes.energy.enabledSymbols, 2); assert.deepEqual(v.classes.energy.block, ['va_breakout:long'])
  assert.equal(v.classes.fx.enabledSymbols, 1); assert.equal(v.classes.other.enabledSymbols, 1)
  assert.deepEqual({ tierA: v.tiers.tierA, tierB: v.tiers.tierB, prioritySlots: v.tiers.prioritySlots, batchSize: v.tiers.batchSize, runsPerPassA: v.tiers.runsPerPassA, runsPerPassB: v.tiers.runsPerPassB },
    { tierA: 2, tierB: 3, prioritySlots: 8, batchSize: 15, runsPerPassA: 1, runsPerPassB: 1 })
  assert.deepEqual(v.tree, { primed: true, symbols: 5, builtAt: TREE.builtAt })
  assert.equal(v.lastScan.scannedAt, '2026-10-16T01:00:00.000Z')
  assert.equal(v.lastScan.routedOut, 2, 'the older batch\'s routed row is not counted')
  assert.deepEqual(v.lastScan.byToken, { '*:long': 1, 'va_breakout:long': 1 })
  assert.deepEqual(v.lastScan.rows.map(r => [r.symbol, r.strategy, r.bias, r.routedSide]), [['NATGAS', 'donchian_breakout', 'skip', 'long'], ['SPOTCRUDE', 'va_breakout', 'skip', 'long']], 'the stored row reads skip; the side it had comes from the thesis')
})

test('GET /state/class-routing serves the view, uncached', async (t) => {
  const db = seed(t)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => server.close())
  const res = await fetch(`http://127.0.0.1:${server.address().port}/state/class-routing`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.enabled, true)
  assert.equal(body.symbols.length, 5)
  assert.equal(body.lastScan.routedOut, 2)
  assert.match(body.note, /manual orders and the momentum book do not read this policy/)
})

test('account-signals: a routed scan row is scan_only on every account, with the token that refused it', (t) => {
  const db = seed(t)
  upsertAccount(db, { accountId: 'A', isLive: false }); writeWatchlist(db, 'A', ['NATGAS', 'EURUSD'])
  const snapshot = { scans: [
    { symbol: 'NATGAS', strategy: 'donchian_breakout', timeframe: '1h', bias: 'skip', routed_bias: 'long', confidence: 7, trade_grade: 'routed', routed_reason: 'donchian_breakout long routed out of symbol NATGAS by class-routing.json token "*:long"' },
    { symbol: 'EURUSD', strategy: 'ema_pullback', timeframe: '4h', bias: 'long', confidence: 8, trade_grade: 'potential' },
  ] }
  const rows = accountSignals(db, snapshot, { accountId: 'A' }).rows
  const natgas = rows.find(r => r.symbol === 'NATGAS'), eurusd = rows.find(r => r.symbol === 'EURUSD')
  assert.equal(natgas.eligibility, 'scan_only')
  assert.match(natgas.reason, /token "\*:long"/)
  assert.doesNotMatch(String(eurusd.reason), /class-routing/, 'the ordinary row is judged by the ordinary gates')
  // A routed row without its reason field still reads as routed, never as a candidate.
  const bare = accountSignals(db, { scans: [{ ...snapshot.scans[0], routed_reason: undefined }] }, { accountId: 'A' }).rows[0]
  assert.equal(bare.eligibility, 'scan_only'); assert.match(bare.reason, /class-routing\.json/)
})

test('the view mirrors the scanner\'s lower-tier reservation under an over-sized share (Codex round 5 on #1390)', (t) => {
  const db = seed(t)
  _resetClassRoutingForTests()
  const dir = mkdtempSync(join(tmpdir(), 'class-routing-view-'))
  try {
    const file = join(dir, 'class-routing.json')
    writeFileSync(file, JSON.stringify({ scanShare: { prioritySlots: 15, priorityMaxRank: 3 }, classes: { fx: { priority: 2 }, crypto: { priority: 1 }, energy: { priority: 5 } } }))
    const v = classRoutingView(db, { policyFile: file })
    assert.deepEqual({ prioritySlots: v.tiers.prioritySlots, tierA: v.tiers.tierA, tierB: v.tiers.tierB, runsPerPassB: v.tiers.runsPerPassB }, { prioritySlots: 14, tierA: 2, tierB: 3, runsPerPassB: 3 }, 'tier B keeps one slot: 3 symbols at 1 a run')
  } finally { rmSync(dir, { recursive: true, force: true }); _resetClassRoutingForTests() }
})
