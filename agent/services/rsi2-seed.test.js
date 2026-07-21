// node --test agent/services/rsi2-seed.test.js
//
// Move B: one-time additive boot seed arms rsi2_reversion + its GO combos.
// Additive and reversible; runs once; never restricts the watchlist.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { seedRsi2GoCombos, RSI2_SEED_FLAG, RSI2_GO_COMBOS } from './rsi2-seed.js'

const io = { getState, setState }

test('fresh DB: arms rsi2 (keeps fib default) and seeds the matrix', () => {
  const db = initDB(':memory:')
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.seeded, true)
  assert.equal(out.addedStrategy, true)
  assert.equal(out.matrixSeeded, true)

  const enabled = JSON.parse(getState(db, 'enabled_strategies_json'))
  assert.deepEqual(enabled, ['fib_618_fade', 'rsi2_reversion'])

  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  for (const { symbol, tf } of RSI2_GO_COMBOS) {
    assert.ok(matrix[symbol.toUpperCase()].includes(tf), `${symbol} ${tf} armed`)
  }
})

test('idempotent: a second call is a no-op', () => {
  const db = initDB(':memory:')
  seedRsi2GoCombos(db, io)
  const before = getState(db, 'autotrade_matrix_json')
  const again = seedRsi2GoCombos(db, io)
  assert.deepEqual(again, { skipped: 'already_seeded' })
  assert.equal(getState(db, 'autotrade_matrix_json'), before)
  assert.ok(getState(db, RSI2_SEED_FLAG))
})

test('additive: preserves an existing armed strategy list and matrix arms', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  setState(db, 'autotrade_matrix_json', JSON.stringify({ NATGAS: ['2h'], EURUSD: ['1h'] }))
  seedRsi2GoCombos(db, io)

  const enabled = JSON.parse(getState(db, 'enabled_strategies_json'))
  assert.deepEqual(enabled, ['fib_618_fade', 'ema_pullback', 'rsi2_reversion'])

  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  // existing arms untouched, GO combos unioned in
  assert.deepEqual(matrix.EURUSD, ['1h'])
  assert.deepEqual(matrix.NATGAS, ['2h', '4h']) // 2h kept, 4h added
  assert.ok(matrix.JPN225.includes('8h'))
})

test('does not double-arm rsi2 if already enabled', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'rsi2_reversion']))
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.addedStrategy, false)
  const enabled = JSON.parse(getState(db, 'enabled_strategies_json'))
  assert.equal(enabled.filter(k => k === 'rsi2_reversion').length, 1)
})

test('footgun guard: armed scope + no matrix → strategy-only, no matrix fabricated', () => {
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.addedStrategy, true)
  assert.equal(out.matrixSeeded, false)
  assert.match(out.note, /armed scope/)
  // no matrix was written → watchlist stays TF-wide, not restricted to 5 symbols
  assert.equal(getState(db, 'autotrade_matrix_json'), null)
  assert.deepEqual(JSON.parse(getState(db, 'enabled_strategies_json')), ['fib_618_fade', 'rsi2_reversion'])
})

test('armed scope WITH an existing matrix → union is safe', () => {
  const db = initDB(':memory:')
  setState(db, 'autotrade_scope', 'armed')
  setState(db, 'autotrade_matrix_json', JSON.stringify({ JPN225: ['1d'] }))
  const out = seedRsi2GoCombos(db, io)
  assert.equal(out.matrixSeeded, true)
  const matrix = JSON.parse(getState(db, 'autotrade_matrix_json'))
  assert.deepEqual(matrix.JPN225, ['1d', '8h'])
})
