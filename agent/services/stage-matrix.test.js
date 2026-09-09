// node --test agent/services/stage-matrix.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  STAGES, STAGE_LABELS, FILTER_KEYS,
  loadStageMatrix, setStage, scanStageStrategies, backtestStageStrategies,
  scanFilterOptions, tradeStageGate, manageStageAllows,
  stageMatrixStats, stageMatrixView,
} from './stage-matrix.js'
import { STRATEGY_KEYS } from './strategies.js'

const io = { getState, setState }

test('columns are the four agreed stages, in pipeline order', () => {
  assert.deepEqual(STAGES, ['scan', 'backtest', 'trade', 'manage'])
  assert.equal(STAGE_LABELS.trade, 'Auto Trade & Open')
  assert.equal(STAGE_LABELS.manage, 'Live Tweak & Close')
})

test('defaults: scan analyses EVERYTHING, filters gate nothing at scan', () => {
  const db = initDB(':memory:')
  const m = loadStageMatrix(db, getState)
  // every registry strategy scans, backtests and manages by default
  for (const s of m.strategies) {
    assert.equal(s.stages.scan, true, `${s.key} scan default`)
    assert.equal(s.stages.backtest, true, `${s.key} backtest default`)
    assert.equal(s.stages.manage, true, `${s.key} manage default`)
  }
  // trade column mirrors enabledStrategies default (everything except
  // fib_618_fade — owner 2026-07-27)
  assert.deepEqual(
    m.strategies.filter(s => s.stages.trade).map(s => s.key),
    ['cup_handle', 'inv_cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev', 'vwap_trend', 'vp_value', 'rsi2_reversion', 'fib_confluence', 'va_breakout']
  )
  // filters: off at scan (analyse all convictions) and backtest; no manage cell.
  for (const f of m.filters) {
    assert.equal(f.stages.scan, false)
    assert.equal(f.stages.backtest, false)
    assert.equal(f.stages.manage, null)
  }
  // RSI confluence is TRADE-armed by default (kill naked fib); the others off.
  assert.equal(m.filters.find(f => f.key === 'rsi').stages.trade, true)
  assert.equal(m.filters.find(f => f.key === 'vwap').stages.trade, false)
  assert.equal(m.filters.find(f => f.key === 'fvg').stages.trade, false)
  assert.deepEqual(m.filters.map(f => f.key), FILTER_KEYS)
})

test('kill-naked-fib: RSI trade defaults ON, but an explicit OFF still wins', () => {
  const db = initDB(':memory:')
  // Unset → RSI confluence trade-armed (no naked fib).
  assert.equal(loadStageMatrix(db, getState).filters.find(f => f.key === 'rsi').stages.trade, true)
  // Owner opts back into naked fib → the stored value wins.
  setState(db, 'fib_rsi_filter', 'false')
  assert.equal(loadStageMatrix(db, getState).filters.find(f => f.key === 'rsi').stages.trade, false)
})

test('trade column derives LIVE from legacy keys — never from stored JSON', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'cup_handle']))
  setState(db, 'fib_rsi_filter', 'true')
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'cup_handle').stages.trade, true)
  assert.equal(m.filters.find(f => f.key === 'rsi').stages.trade, true)
  // stored matrix JSON must not shadow the legacy keys
  setState(db, 'stage_matrix_json', JSON.stringify({ strategy: { cup_handle: { trade: false } } }))
  const m2 = loadStageMatrix(db, getState)
  assert.equal(m2.strategies.find(s => s.key === 'cup_handle').stages.trade, true)
})

test('setStage trade writes THROUGH to the legacy keys', () => {
  const db = initDB(':memory:')
  // fib_618_fade is off by default (2026-07-27) — arming it merges into the
  // rest of the default-on set, in registry order.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true }, io)
  assert.deepEqual(
    JSON.parse(getState(db, 'enabled_strategies_json')),
    ['fib_618_fade', 'cup_handle', 'inv_cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev', 'vwap_trend', 'vp_value', 'rsi2_reversion', 'fib_confluence', 'va_breakout']
  )
  setStage(db, { kind: 'strategy', key: 'cup_handle', stage: 'trade', on: true }, io)
  assert.equal(getState(db, 'cup_handle_enabled'), 'true')
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'trade', on: true }, io)
  assert.equal(getState(db, 'fib_vwap_filter'), 'true')
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'trade', on: false }, io)
  assert.equal(getState(db, 'fib_vwap_filter'), 'false')
})

test('setStage scan/backtest/manage persist in stage_matrix_json only', () => {
  const db = initDB(':memory:')
  setStage(db, { kind: 'strategy', key: 'rsi_meanrev', stage: 'scan', on: false }, io)
  setStage(db, { kind: 'filter', key: 'fvg', stage: 'backtest', on: true }, io)
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'rsi_meanrev').stages.scan, false)
  assert.equal(m.filters.find(f => f.key === 'fvg').stages.backtest, true)
  // legacy keys untouched
  assert.ok(getState(db, 'enabled_strategies_json') == null)
  assert.notEqual(getState(db, 'fib_fvg_filter'), 'true')
})

test('setStage rejects unknown kind/key/stage and filter×manage', () => {
  const db = initDB(':memory:')
  assert.throws(() => setStage(db, { kind: 'strategy', key: 'nope', stage: 'scan', on: true }, io), /unknown strategy/)
  assert.throws(() => setStage(db, { kind: 'filter', key: 'nope', stage: 'scan', on: true }, io), /unknown filter/)
  assert.throws(() => setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'wat', on: true }, io), /unknown stage/)
  assert.throws(() => setStage(db, { kind: 'wat', key: 'fib_618_fade', stage: 'scan', on: true }, io), /unknown kind/)
  assert.throws(() => setStage(db, { kind: 'filter', key: 'rsi', stage: 'manage', on: true }, io), /no such|no Live Tweak/)
})

test('scanStageStrategies is wide by default and honours scan cells', () => {
  const db = initDB(':memory:')
  assert.deepEqual(scanStageStrategies(db, getState).map(s => s.key), STRATEGY_KEYS)
  setStage(db, { kind: 'strategy', key: 'donchian_breakout', stage: 'scan', on: false }, io)
  assert.equal(scanStageStrategies(db, getState).some(s => s.key === 'donchian_breakout'), false)
})

test('backtestStageStrategies honours backtest cells', () => {
  const db = initDB(':memory:')
  setStage(db, { kind: 'strategy', key: 'cup_handle', stage: 'backtest', on: false }, io)
  const keys = backtestStageStrategies(db, getState).map(s => s.key)
  assert.equal(keys.includes('cup_handle'), false)
  assert.equal(keys.includes('fib_618_fade'), true)
})

test('scanFilterOptions: strict when scan-armed, annotate when only trade-armed, null when off', () => {
  const db = initDB(':memory:')
  setState(db, 'fib_rsi_filter', 'true') // trade-armed, scan off → annotate
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'scan', on: true }, io) // scan-armed → strict
  const opts = scanFilterOptions(db, getState)
  assert.deepEqual(opts.rsiFilter, { mode: 'annotate' })
  assert.deepEqual(opts.vwapFilter, {})
  assert.equal(opts.fvgFilter, null)
})

test('tradeStageGate: strategy trade cell and trade-armed filters both bite', () => {
  const db = initDB(':memory:')
  // cup_handle on by default (2026-07-27 default set)
  assert.equal(tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: [] }).ok, true)
  // strategy off in trade column (fib_618_fade is off by default now)
  assert.match(tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: [] }).reason, /OFF in Auto Trade/)
  // trade-armed filter failed at scan → veto (filters gate any strategy, not just fib)
  setState(db, 'fib_rsi_filter', 'true')
  const vetoed = tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: ['rsi'] })
  assert.equal(vetoed.ok, false)
  assert.match(vetoed.reason, /RSI filter failed/)
  // same failure with the filter NOT trade-armed → passes
  setState(db, 'fib_rsi_filter', 'false')
  assert.equal(tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: ['rsi'] }).ok, true)
  // unknown strategy label never trades
  assert.equal(tradeStageGate(db, getState, { strategy: 'mystery', filtersFailed: [] }).ok, false)
})

test('manageStageAllows: gated per strategy, unlabelled always managed', () => {
  const db = initDB(':memory:')
  assert.equal(manageStageAllows(db, getState, 'fib_618_fade'), true)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'manage', on: false }, io)
  assert.equal(manageStageAllows(db, getState, 'fib_618_fade'), false)
  assert.equal(manageStageAllows(db, getState, null), true)
  assert.equal(manageStageAllows(db, getState, 'legacy-free-text'), true)
})

test('stageMatrixStats aggregates the four ledgers per strategy', () => {
  const db = initDB(':memory:')
  // scan: analyses — 1 reached the bar, 2 below it
  const insA = db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', ?, 'fib_618_fade', datetime('now'))`
  )
  insA.run(1); insA.run(0); insA.run(0)
  // backtest: last autopilot verdicts — 2 GO, 1 no-go
  setState(db, 'autopilot_last_verdicts_json', JSON.stringify([
    { strategy: 'fib_618_fade', state: 'go' },
    { strategy: 'fib_618_fade', state: 'go' },
    { strategy: 'fib_618_fade', state: 'no-go' },
  ]))
  // trade: risk_events — 1 approved, 1 veto
  const insR = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, proposal_json, created_at)
     VALUES ('EURUSD', 'BUY', ?, '{"strategy":"fib_618_fade"}', datetime('now'))`
  )
  insR.run(1); insR.run(0)
  // manage: closed trades — 1 win, 1 loss
  const insT = db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, 'fib_618_fade', datetime('now'))`
  )
  insT.run(12.5); insT.run(-4)

  const stats = stageMatrixStats(db, getState)
  assert.deepEqual(stats['strategy|fib_618_fade|scan'], { ok: 1, fail: 2 })
  assert.deepEqual(stats['strategy|fib_618_fade|backtest'], { ok: 2, fail: 1 })
  assert.deepEqual(stats['strategy|fib_618_fade|trade'], { ok: 1, fail: 1 })
  assert.deepEqual(stats['strategy|fib_618_fade|manage'], { ok: 1, fail: 1 })
})

test('stageMatrixStats never folds unattributed rows into fib_618_fade', () => {
  const db = initDB(':memory:')
  // scan: a row with NO strategy label (legacy/lost attribution)
  db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', 1, NULL, datetime('now'))`
  ).run()
  // trade: a risk_event whose proposal_json carries no strategy field
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, proposal_json, created_at)
     VALUES ('EURUSD', 'BUY', 1, '{}', datetime('now'))`
  ).run()
  // manage: a closed trade with neither label_strategy nor strategy set —
  // exactly the shape of Edge Health's "Manual / external" autopilot rows
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, strategy, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', 10, NULL, NULL, datetime('now'))`
  ).run()

  const stats = stageMatrixStats(db, getState)
  assert.equal(stats['strategy|fib_618_fade|scan'], undefined)
  assert.equal(stats['strategy|fib_618_fade|trade'], undefined)
  assert.equal(stats['strategy|fib_618_fade|manage'], undefined)
})

test('stageMatrixStats ignores rows older than the 30-day window', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', 1, 'fib_618_fade', datetime('now', '-45 days'))`
  ).run()
  const stats = stageMatrixStats(db, getState)
  assert.equal(stats['strategy|fib_618_fade|scan'], undefined)
})

test('stageMatrixView bundles columns, matrix, stats and window', () => {
  const db = initDB(':memory:')
  const v = stageMatrixView(db, getState)
  assert.deepEqual(v.columns.map(c => c.key), STAGES)
  assert.equal(v.strategies.length, STRATEGY_KEYS.length)
  assert.equal(v.filters.length, FILTER_KEYS.length)
  assert.equal(typeof v.stats, 'object')
  assert.equal(v.windowDays, 30)
})

// ---------------------------------------------------------------------------
// A GLOBAL OFF IS A KILL SWITCH (owner "go", 02-09-2026). Reproduces the
// 12:36 → 12:50 case: global disarm, account pin still on, strategy trades.
// ---------------------------------------------------------------------------
import { unpinTradeStageEverywhere, armedTradeKeys, acctMatrixKey, acctEnabledKey } from './stage-matrix.js'
import { readFileSync } from 'node:fs'

function withAccounts(db, ids) {
  for (const id of ids) db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
  return db
}

test('global OFF clears the per-account trade pin and the legacy list; global ON leaves pins alone', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222', '333'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend', 'rsi2_reversion']))
  // 111: overlay pin ON (the production shape); 222: legacy wholesale list;
  // 333: no pin, follows global; 444: not in the registry but carries a pin.
  setState(db, acctMatrixKey('111'), JSON.stringify({ strategy: { vwap_trend: { trade: true, scan: false } } }))
  setState(db, acctEnabledKey('222'), JSON.stringify(['vwap_trend', 'ema_pullback']))
  setState(db, acctMatrixKey('444'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  // THE DEFECT: the global switch alone changes nothing on a pinned account.
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  assert.ok(armedTradeKeys(db, getState, '111').has('vwap_trend'), 'pinned account still armed after a bare global write')
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'))
  assert.ok(armedTradeKeys(db, getState, '444').has('vwap_trend'))
  assert.ok(!armedTradeKeys(db, getState, '333').has('vwap_trend'), 'the unpinned account followed the global')
  // THE FIX.
  const touched = unpinTradeStageEverywhere(db, io, 'vwap_trend')
  assert.deepEqual(touched, ['111', '222', '444'], 'every pin found, registry or not; the unpinned account is not "touched"')
  for (const a of ['111', '222', '333', '444']) assert.ok(!armedTradeKeys(db, getState, a).has('vwap_trend'), `${a} follows the global OFF`)
  // Other cells and other strategies on the same account survive.
  assert.deepEqual(JSON.parse(getState(db, acctMatrixKey('111'))), { strategy: { vwap_trend: { scan: false } } })
  assert.deepEqual(JSON.parse(getState(db, acctEnabledKey('222'))), ['ema_pullback'])
  assert.ok(armedTradeKeys(db, getState, '222').has('ema_pullback'), 'the legacy list keeps its other entries')
  // Idempotent, and a global ON does not re-pin or un-pin anything.
  assert.deepEqual(unpinTradeStageEverywhere(db, io, 'vwap_trend'), [])
  setState(db, acctMatrixKey('333'), JSON.stringify({ strategy: { rsi2_reversion: { trade: false } } }))
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true }, io)
  assert.ok(!armedTradeKeys(db, getState, '333').has('rsi2_reversion'), 'an account that opted OUT keeps its opt-out on a global ON')
})

test('the kill switch lives in the OWNER routes, not in setStage: the adaptive breaker keeps its never-go-dark rule', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  setState(db, acctMatrixKey('111'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  setState(db, acctMatrixKey('222'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '111' }, io)
  assert.ok(!armedTradeKeys(db, getState, '111').has('vwap_trend'))
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'), 'a per-account OFF is scoped, as before')
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false }, io)
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'), 'setStage alone leaves the pin — the breaker relies on that')
  assert.ok(!armedTradeKeys(db, getState, null).has('vwap_trend'))
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const route = src.slice(src.indexOf("router.post('/stage-matrix'"), src.indexOf("router.post('/stage-matrix'") + 2500)
  assert.match(route, /unpinTradeStageEverywhere\(db, \{ getState, setState \}, String\(key\)\)/, 'the matrix route is the owner\'s other kill switch')
})

test('wiring: POST /actions/strategies clears pins for every strategy it turns off and reports them', () => {
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const route = src.slice(src.indexOf("router.post('/strategies'"), src.indexOf("router.post('/storage-purge'"))
  assert.match(route, /unpinTradeStageEverywhere\(db, \{ getState, setState \}, k\)/)
  assert.match(route, /unpinned,/)
})

// ---------------------------------------------------------------------------
// OWNER-DECLARED PINS FROM THE REPO (owner order 09-09-2026, §7,522·B·2): the
// rsi2_reversion / rsi_meanrev demo cohort, applied at boot from
// config/strategy-pins.json because the pinning route needs the lost token.
// ---------------------------------------------------------------------------
import { seedStrategyPinsFromConfig, isHandPinned, tradeStageGate as gateFor } from './stage-matrix.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('strategy-pin seed: pins the named strategies ON for that account only, idempotent, the gates read the pin, junk is skipped by name', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend'])) // rsi2 OFF globally, as in production 09-09
  const dir = mkdtempSync(join(tmpdir(), 'pins-'))
  const file = join(dir, 'strategy-pins.json')
  writeFileSync(file, JSON.stringify({ _note: 'the file\'s own note, never an account (09-09-2026)', 111: ['rsi2_reversion', 'rsi_meanrev', 'not_a_strategy'], abc: ['rsi2_reversion'], 222: 'rsi2_reversion' }))
  const lines = []
  const a = seedStrategyPinsFromConfig(db, io, { file, log: (m) => lines.push(m) })
  assert.equal(a.error, null)
  assert.deepEqual(a.applied, ['111:rsi2_reversion', '111:rsi_meanrev'])
  // (integer-like keys enumerate first, so 222 precedes abc)
  assert.deepEqual(a.skipped, ["111: unknown strategy 'not_a_strategy'", '222: malformed', 'abc: malformed'])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /strategy pin …111: rsi2_reversion ON for Auto Trade & Open/)
  // The pin is the owner's word: explicit true cell, gate open on 111, still OFF on 222 and globally.
  assert.equal(isHandPinned(db, getState, '111', 'rsi2_reversion'), true)
  assert.equal(isHandPinned(db, getState, '222', 'rsi2_reversion'), false)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion', accountId: '111' }).ok, true)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion', accountId: '222' }).ok, false)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion' }).ok, false, 'the global cell is untouched')
  assert.ok(!armedTradeKeys(db, getState, '111').has('ema_pullback'), 'other cells on the account keep their value')
  // Idempotent: a second boot changes nothing.
  const b = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(b.applied, []); assert.deepEqual(b.unchanged, ['111:rsi2_reversion', '111:rsi_meanrev'])
  // Missing or malformed file: reports, changes nothing.
  assert.match(seedStrategyPinsFromConfig(db, io, { file: join(dir, 'missing.json') }).error, /strategy-pins.json unreadable/)
  writeFileSync(file, '[1,2]')
  assert.equal(seedStrategyPinsFromConfig(db, io, { file }).error, 'strategy-pins.json is not an object')
})

test('strategy-pin seed: the checked-in file parses, pins the whole non-momentum stack on every account of the cluster (owner 09-09-2026), and index.js applies it at boot after the momentum seed', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
  const ids = Object.keys(cfg).filter(k => /^\d{8}$/.test(k))
  assert.equal(ids.length, 5, 'the five accounts the loop runs')
  const stack = STRATEGY_KEYS.filter(k => k !== 'tsmom_long')
  for (const id of ids) assert.deepEqual(cfg[id], stack, `${id}: every strategy but the momentum book's own`)
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /seedMomentumAccountFromConfig\(db, \{ log[\s\S]{0,900}?seedStrategyPinsFromConfig\(db, \{ getState, setState \}, \{ log/, 'the boot seed runs after the momentum-account seed')
})
