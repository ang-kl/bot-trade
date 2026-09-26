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

test('coerceCorrectionIds drops non-integer numbers and non-digit strings', () => {
  assert.deepEqual(coerceCorrectionIds([3.14, 'abc', '', ' 5', '5 ']), [])
})

// Item 2, second fix round: a row id is SQLite's AUTOINCREMENT primary
// key — positive, safe-integer, never zero, never negative — so the first
// pass's plain "integer number or digit-only string" was too loose.
test('coerceCorrectionIds drops negative and zero ids, as a number or a string', () => {
  assert.deepEqual(coerceCorrectionIds([-7, 0, '0', -1.0, 5]), [5])
})

test('coerceCorrectionIds drops an unsafe integer number (MAX_SAFE_INTEGER + 1) and keeps MAX_SAFE_INTEGER itself', () => {
  const MSI = Number.MAX_SAFE_INTEGER
  assert.deepEqual(coerceCorrectionIds([MSI + 1, MSI, 5]), [MSI, 5])
})

test('coerceCorrectionIds drops an over-long digit string that Number() cannot represent exactly', () => {
  // 17 digits, one past MAX_SAFE_INTEGER (9,007,199,254,740,991): Number()
  // rounds this to 9007199254740992, a DIFFERENT value than the string named
  // — a naive Number.isSafeInteger(Number(v)) check alone would pass this
  // (the rounded result IS a safe integer), so the guard is the round-trip:
  // String(n) must equal the original digit string.
  assert.deepEqual(coerceCorrectionIds(['90071992547409929', '99999999999999999999', '5']), [5])
})

test('coerceCorrectionIds ACCEPTS a leading-zero digit string ("007") — it round-trips losslessly to 7', () => {
  assert.deepEqual(coerceCorrectionIds(['007', '0007']), [7, 7])
})

test('coerceCorrectionIds still drops "00" — it round-trips to 0, caught by the same positive-only rule as "0"', () => {
  assert.deepEqual(coerceCorrectionIds(['00']), [])
})
