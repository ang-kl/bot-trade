// sizing-parity.test.js
//
// The regression these encode is JPN225: a currency assumption that was wrong
// by the USDJPY rate, invisible for as long as it existed, and found only when
// a loss happened to exceed a daily cap. The first test is that exact defect,
// reconstructed from the real fills, so the check is proven against the thing
// it was built for rather than against a hypothetical.

import test from 'node:test'
import assert from 'node:assert/strict'
import { sizingParity, tradeParity, modelledPnlUsd } from './sizing-parity.js'
import { setQuoteCurrencyOverrides, fxQuoteCurrency } from '../lib/contracts.js'

const RATES = { USDJPY: 158.329, GBPUSD: 1.34532, USDHKD: 7.84335 }

// The three real JPN225 shorts, now with the BROKER's prices.
//
// THE FIXTURE WAS CIRCULAR (found 13-08-2026). Its own comment said
// "exit_price is derived from the realised P&L under the USD reading" — the
// exits were reverse-engineered from the conclusion, so the ratio came out at
// 1.0000, 1.0001, 1.0001 and the test proved the model agreed with a number
// the model had produced. A parity check fed synthetic prices cannot detect a
// pricing error; it can only confirm one.
//
// These entry/exit prices are read off the 28 Jul–13 Aug statement for the
// same three deals (same P&L, same volumes). The moves are 197.9 / 82.2 / 27.7
// points, not 126.44 / 52.05 / 17.64, and they imply $0.6392 / $0.6334 /
// $0.6377 per point per lot — 100 JPY at USDJPY ~156-158, not $1.
const JPN = [
  { symbol: 'JPN225', side: 'SELL', entry_price: 62286.5, exit_price: 62484.4, volume: 72.50, net_pnl: -9171.76 },
  { symbol: 'JPN225', side: 'SELL', entry_price: 63659.7, exit_price: 63741.9, volume: 51.50, net_pnl: -2681.29 },
  { symbol: 'JPN225', side: 'SELL', entry_price: 62506.6, exit_price: 62534.3, volume: 74.50, net_pnl: -1315.92 },
]

test('with JPN225 read as JPY the model agrees with the broker', () => {
  const r = sizingParity(JPN, { rates: RATES })
  const s = r.symbols[0]
  assert.equal(s.symbol, 'JPN225')
  assert.equal(s.verdict, 'ok')
  assert.ok(Math.abs(s.impliedFactor - 1) < 0.01, `factor ${s.impliedFactor} should be ~1`)
})

test('THE REGRESSION: under the USD reading the factor names the rate', () => {
  // What the check reports when JPN225 is read as USD — the state the table
  // was actually in from 07-08 to 13-08. The headline is not "something is
  // wrong": it is that the number IS the FX rate, which points straight at the
  // mistake instead of at the symbol. Under USD the model expects 197.9 pts x
  // 72.5 lots = $14,348 and the broker charged $9,171.76.
  setQuoteCurrencyOverrides({ JPN225: 'USD' })
  try {
    assert.equal(fxQuoteCurrency('JPN225'), 'USD', 'override must win over the corrected table')
    const s = sizingParity(JPN, { rates: RATES }).symbols[0]
    assert.equal(s.verdict, 'disagrees')
    // The factor is now the RECIPROCAL of the rate, because the wrong reading
    // is `contractSize 100 + USD` rather than the old `contractSize 1 + JPY` —
    // both terms moved. What matters is unchanged and is the whole point of
    // the check: the number is the yen rate, so it names the mistake.
    assert.ok(Math.abs(1 / s.impliedFactor - 158.329) / 158.329 < 0.03,
      `1/factor ${(1 / s.impliedFactor).toFixed(2)} should land on the yen rate`)
    assert.match(s.suggests, /JPY→USD/)
  } finally { setQuoteCurrencyOverrides(null) }
})

test('the override map is cleared by null, restoring the table', () => {
  setQuoteCurrencyOverrides({ JPN225: 'USD' })
  setQuoteCurrencyOverrides(null)
  assert.equal(fxQuoteCurrency('JPN225'), 'JPY')
})

test('an override may set null — "no conversion" is a real answer', () => {
  // ABSENT and SET-TO-NULL must not collapse: null means "treat as USD",
  // which is exactly the correction JPN225 needed and could not express.
  setQuoteCurrencyOverrides({ GER40: null })
  try {
    assert.equal(fxQuoteCurrency('GER40'), null, 'not EUR from the table')
  } finally { setQuoteCurrencyOverrides(null) }
  assert.equal(fxQuoteCurrency('GER40'), 'EUR')
})

test('a malformed override is dropped, not stored', () => {
  const applied = setQuoteCurrencyOverrides({ JPN225: 'JAPANESE YEN', US30: 'x', GER40: 'USD' })
  try {
    assert.deepEqual(applied, ['GER40'])
    assert.equal(fxQuoteCurrency('JPN225'), 'JPY', 'unchanged by the bad value')
    assert.equal(fxQuoteCurrency('GER40'), 'USD')
  } finally { setQuoteCurrencyOverrides(null) }
})

test('under-sizing is caught as loudly as over-sizing', () => {
  // A plain `factor > tolerance` test misses every case where the model
  // OVERSTATES risk — which under-trades the account silently. The bound is
  // symmetric in log space.
  const half = [1, 2, 3].map(i => ({
    symbol: 'FOO', side: 'BUY', entry_price: 100, exit_price: 100 + i, volume: 1, net_pnl: -i * 0.25,
  }))
  const s = sizingParity(half, { rates: RATES }).symbols[0]
  assert.equal(s.verdict, 'disagrees')
  assert.ok(s.impliedFactor < 1, 'the broker charged LESS than modelled')
})

test('a thin sample gets no verdict — three trades is the floor', () => {
  const s = sizingParity(JPN.slice(0, 2), { rates: RATES, minTrades: 3 }).symbols[0]
  assert.equal(s.verdict, 'insufficient')
  assert.equal(s.trades, 2)
  assert.equal(s.suggests, null, 'no hypothesis from two rows')
})

test('one wild row cannot set the verdict — the median holds', () => {
  // Trade 641's recorded exit implies a PROFIT while the broker charged
  // 9,171.76: a separate price-capture defect. A mean would let that one row
  // condemn the symbol; the median requires consistency.
  const withOneBadExit = [
    { symbol: 'JPN225', side: 'SELL', entry_price: 62487, exit_price: 62484.4, volume: 72.54, net_pnl: -9171.76 },
    JPN[1], JPN[2],
  ]
  const s = sizingParity(withOneBadExit, { rates: RATES }).symbols[0]
  assert.equal(s.verdict, 'ok', 'two good rows outvote one')
  assert.equal(s.signMismatches, 1)
  assert.match(s.note, /disagree on DIRECTION/)
  // 2.6 points of recorded move against a 9,171.76 charge → 48.6×. Reported,
  // not hidden: the median decides the verdict, worstRatio preserves the row.
  assert.ok(s.worstRatio > 40, `outlier still reported (got ${s.worstRatio})`)
})

test('scratch trades are skipped rather than dividing two roundings', () => {
  const r = sizingParity([
    { symbol: 'X', side: 'BUY', entry_price: 100, exit_price: 100, volume: 1, net_pnl: 0 },
  ], { rates: RATES })
  assert.equal(r.compared, 0)
  assert.equal(r.skipped, 1)
  assert.deepEqual(r.symbols, [])
})

test('an unclosed or unpriced trade is not a finding', () => {
  for (const bad of [
    { symbol: 'X', side: 'BUY', entry_price: 100, exit_price: null, volume: 1, net_pnl: -5 },
    { symbol: 'X', side: 'BUY', entry_price: 100, exit_price: 99, volume: 0, net_pnl: -5 },
    { symbol: 'X', side: 'BUY', entry_price: 100, exit_price: 99, volume: 1, net_pnl: null },
  ]) assert.equal(tradeParity(bad, RATES), null)
})

test('HKD names reconcile — proof this is not "conversion is broken"', () => {
  // 0016.HK: 438.69 units, 9.64 of adverse move, HKD→USD 0.1275.
  // Modelled 539 USD against 563.16 realised. The HKD path is RIGHT, which is
  // what makes the JPN225 finding a single wrong entry rather than a systemic
  // currency bug — and this test is here so that stays true.
  const m = modelledPnlUsd(
    { symbol: '0016.HK', side: 'BUY', entry_price: 122.81, exit_price: 113.11, volume: 438.69 }, RATES)
  assert.ok(m < 0, 'a long that fell lost money')
  assert.ok(Math.abs(Math.abs(m) - 563.16) / 563.16 < 0.10, `modelled ${m} within 10% of realised -563.16`)
})

test('disagreeing symbols are listed, and sorted to the top', () => {
  setQuoteCurrencyOverrides({ JPN225: 'USD' })
  try {
    const clean = [1, 2, 3].map(i => ({
      symbol: 'US30', side: 'BUY', entry_price: 50000, exit_price: 50000 + i, volume: 2, net_pnl: i * 2,
    }))
    const r = sizingParity([...clean, ...JPN], { rates: RATES })
    assert.deepEqual(r.disagreeing, ['JPN225'])
    assert.equal(r.symbols[0].symbol, 'JPN225', 'the problem sorts first')
    assert.equal(r.symbols[1].verdict, 'ok')
    assert.equal(r.compared, 6)
  } finally { setQuoteCurrencyOverrides(null) }
})
