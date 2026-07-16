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
  // trade column mirrors enabledStrategies default (fib only)
  assert.deepEqual(m.strategies.filter(s => s.stages.trade).map(s => s.key), ['fib_618_fade'])
  // filters: off at scan (analyse all convictions) and backtest; no manage cell
  for (const f of m.filters) {
    assert.equal(f.stages.scan, false)
    assert.equal(f.stages.backtest, false)
    assert.equal(f.stages.trade, false)
    assert.equal(f.stages.manage, null)
  }
  assert.deepEqual(m.filters.map(f => f.key), FILTER_KEYS)
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
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: true }, io)
  assert.deepEqual(JSON.parse(getState(db, 'enabled_strategies_json')), ['fib_618_fade', 'ema_pullback'])
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
  // fib on by default
  assert.equal(tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: [] }).ok, true)
  // strategy off in trade column
  assert.match(tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: [] }).reason, /OFF in Auto Trade/)
  // trade-armed filter failed at scan → veto
  setState(db, 'fib_rsi_filter', 'true')
  const vetoed = tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: ['rsi'] })
  assert.equal(vetoed.ok, false)
  assert.match(vetoed.reason, /RSI filter failed/)
  // same failure with the filter NOT trade-armed → passes
  setState(db, 'fib_rsi_filter', 'false')
  assert.equal(tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: ['rsi'] }).ok, true)
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
