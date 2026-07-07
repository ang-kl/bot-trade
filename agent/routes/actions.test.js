// node --test agent/routes/actions.test.js
// pickBacktestSymbols — the backtest must follow the trader's watchlist,
// never a hardcoded default symbol.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pickBacktestSymbols } from './actions.js'

const WATCHLIST = JSON.stringify([
  { symbol: 'EURUSD', enabled: true },
  { symbol: 'GBPUSD' },                    // enabled omitted → treated as ON
  { symbol: 'USDJPY', enabled: false },    // OFF — must be excluded
  'XAUUSD',                                // legacy plain-string row
])

test('defaults to every ENABLED watchlist symbol when body has none', () => {
  assert.deepEqual(pickBacktestSymbols({}, WATCHLIST), ['EURUSD', 'GBPUSD', 'XAUUSD'])
})

test('explicit symbols list wins over the watchlist', () => {
  assert.deepEqual(pickBacktestSymbols({ symbols: ['us30', ' nzdusd '] }, WATCHLIST), ['US30', 'NZDUSD'])
})

test('legacy single symbol still works', () => {
  assert.deepEqual(pickBacktestSymbols({ symbol: 'eurusd' }, WATCHLIST), ['EURUSD'])
})

test('dedupes and caps at 8 symbols per run', () => {
  const many = Array.from({ length: 12 }, (_, i) => `SYM${i}`)
  assert.equal(pickBacktestSymbols({ symbols: [...many, 'SYM0'] }, null).length, 8)
})

test('returns [] on empty or corrupt watchlist state', () => {
  assert.deepEqual(pickBacktestSymbols({}, null), [])
  assert.deepEqual(pickBacktestSymbols({}, 'not-json'), [])
  assert.deepEqual(pickBacktestSymbols(undefined, '[]'), [])
})
