// node --test agent/routes/actions.test.js
// pickBacktestSymbols — the backtest must follow the trader's watchlist,
// never a hardcoded default symbol.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pickBacktestSymbols, coerceCorrectionIds } from './actions.js'

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

test('dedupes and caps at 24 symbols per run', () => {
  const many = Array.from({ length: 30 }, (_, i) => `SYM${i}`)
  assert.equal(pickBacktestSymbols({ symbols: [...many, 'SYM0'] }, null).length, 24)
})

test('returns [] on empty or corrupt watchlist state', () => {
  assert.deepEqual(pickBacktestSymbols({}, null), [])
  assert.deepEqual(pickBacktestSymbols({}, 'not-json'), [])
  assert.deepEqual(pickBacktestSymbols(undefined, '[]'), [])
})

// N6 (checker nit round): named-corrections `ids` coercion accepts only
// integer numbers or digit-only strings — never `true`, a nested array,
// hex/exponent strings, or a fraction.
test('coerceCorrectionIds keeps only genuine integer row ids', () => {
  assert.deepEqual(coerceCorrectionIds([5, 47, 309]), [5, 47, 309])
  assert.deepEqual(coerceCorrectionIds(['5', '47']), [5, 47])
})

test('coerceCorrectionIds drops true, a nested array, hex/exponent strings and a fraction', () => {
  assert.deepEqual(coerceCorrectionIds([true, [5], '0x10', '1e3', 1.5, 5]), [5])
})

test('coerceCorrectionIds is undefined for a non-array (including undefined/null)', () => {
  assert.equal(coerceCorrectionIds(undefined), undefined)
  assert.equal(coerceCorrectionIds(null), undefined)
  assert.equal(coerceCorrectionIds('5'), undefined)
  assert.equal(coerceCorrectionIds(5), undefined)
})

test('coerceCorrectionIds drops non-integer numbers and non-digit strings; an integer number stays whatever its sign', () => {
  assert.deepEqual(coerceCorrectionIds([-5, 3.14, 'abc', '', ' 5', '5 ', '05']), [-5, 5])
})
