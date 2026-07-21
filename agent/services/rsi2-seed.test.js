// node --test agent/services/rsi2-seed.test.js
//
// Move B: one-time additive boot seed arms rsi2_reversion + its GO combos,
// read from the owner's REAL backtest baseline (never hardcoded/fabricated).

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { seedRsi2GoCombos, goCombosFromBaseline, RSI2_SEED_FLAG } from './rsi2-seed.js'

const io = { getState, setState }

// A realistic baseline mirroring the "Your edge — backtest baseline" table.
function seedBaseline(db, strategy = 'rsi2_reversion') {
  setState(db, 'backtest_baseline_json', JSON.stringify({
    ranAt: '2026-07-21T03:00:00Z', strategy, entryMode: 'zone', bars: 1500,
    combos: [
      { symbol: 'EURGBP',   tf: '8h', trades: 37, profitFactor: 2.35, winRatePct: 65 },
      { symbol: 'US30',     tf: '8h', trades: 45, profitFactor: 1.89, winRatePct: 56 },
      { symbol: 'GOOGL.US', tf: '1h', trades: 38, profitFactor: 1.79, winRatePct: 55 },
      { symbol: 'CORN',     tf: '8h', trades: 44, profitFactor: 1.52, winRatePct: 61 },
      { symbol: 'FOO',      tf: '30m', trades: 40, profitFactor: 2.0, winRatePct: 60 }, // sub-1h → excluded
      { symbol: 'BAR',      tf: '4h', trades: 5,  profitFactor: 3.0, winRatePct: 80 },  // too few trades → excluded
      { symbol: 'BAZ',      tf: '4h', trades: 40, profitFactor: 1.1, winRatePct: 52 },  // PF below GO → excluded
      { symbol: 'WF',       tf: '4h', trades: 40, profitFactor: 1.8, winRatePct: 60, wfPositive: false }, // WF fail → excluded
    ],
  }))
}

test('goCombosFromBaseline: only real GO combos, ≥1h, sorted by PF', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  const baseline = JSON.parse(getState(db, 'backtest_baseline_json'))
  const combos = goCombosFromBaseline(baseline)
  assert.deepEqual(combos, [
    { symbol: 'EURGBP', tf: '8h' },
    { symbol: 'US30', tf: '8h' },
    { symbol: 'GOOGL.US', tf: '1h' },
    { symbol: 'CORN', tf: '8h' },
  ])
})

test('goCombosFromBaseline: empty for another strategy or no baseline', () => {
  assert.deepEqual(goCombosFromBaseline(null), [])
  assert.deepEqual(goCombosFromBaseline({ strategy: 'fib_618_fade', combos: [] }), [])
})

test('fresh DB with baseline: arms rsi2 and seeds the REAL combos', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.seeded, true)
  assert.equal(out.addedStrategy, true)
  assert.equal(out.matrixSeeded, true)

  assert.deepEqual(JSON.parse(getState(db, 'enabled_strategies_json')), ['fib_618_fade', 'rsi2_reversion'])
  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  assert.deepEqual(matrix['GOOGL.US'], ['1h'])
  assert.deepEqual(matrix.US30, ['8h'])
  assert.deepEqual(matrix.EURGBP, ['8h'])
  assert.equal(matrix.FOO, undefined) // sub-1h never armed
})

test('no baseline: arms strategy only, no fabricated combos', () => {
  const db = initDB(':memory:')
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.addedStrategy, true)
  assert.equal(out.matrixSeeded, false)
  assert.match(out.note, /no RSI-2 backtest baseline/)
  assert.equal(getState(db, 'autotrade_matrix_json'), null)
  assert.deepEqual(JSON.parse(getState(db, 'enabled_strategies_json')), ['fib_618_fade', 'rsi2_reversion'])
})

test('idempotent: a second call is a no-op', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  seedRsi2GoCombos(db, io)
  const before = getState(db, 'autotrade_matrix_json')
  const again = seedRsi2GoCombos(db, io)
  assert.deepEqual(again, { skipped: 'already_seeded' })
  assert.equal(getState(db, 'autotrade_matrix_json'), before)
  assert.ok(getState(db, RSI2_SEED_FLAG))
})

test('additive: preserves existing armed strategies and matrix arms', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  setState(db, 'autotrade_matrix_json', JSON.stringify({ US30: ['1d'], EURUSD: ['1h'] }))
  seedRsi2GoCombos(db, io)

  assert.deepEqual(JSON.parse(getState(db, 'enabled_strategies_json')), ['fib_618_fade', 'ema_pullback', 'rsi2_reversion'])
  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  assert.deepEqual(matrix.EURUSD, ['1h'])       // untouched
  assert.deepEqual(matrix.US30, ['1d', '8h'])   // 1d kept, 8h added
})

test('does not double-arm rsi2 if already enabled', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'rsi2_reversion']))
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.addedStrategy, false)
  assert.equal(JSON.parse(getState(db, 'enabled_strategies_json')).filter(k => k === 'rsi2_reversion').length, 1)
})

test('footgun guard: armed scope + no matrix → strategy-only, no matrix fabricated', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  setState(db, 'autotrade_scope', 'armed')
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.addedStrategy, true)
  assert.equal(out.matrixSeeded, false)
  assert.match(out.note, /armed scope/)
  assert.equal(getState(db, 'autotrade_matrix_json'), null)
})

test('armed scope WITH an existing matrix → union is safe', () => {
  const db = initDB(':memory:')
  seedBaseline(db)
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', JSON.stringify({ JPN225: ['1d'] }))
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.matrixSeeded, true)
  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  assert.deepEqual(matrix.JPN225, ['1d']) // untouched (not a GO combo here)
  assert.deepEqual(matrix.EURGBP, ['8h']) // real GO combo added
})
