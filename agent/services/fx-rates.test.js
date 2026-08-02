// Tests for the persistent FX rate table.
//
// The production failure this exists for: cross-pair sizing read the LAST
// SCAN BATCH, the scan rotates 15 of 221 symbols per cycle, so EURJPY and
// the USDJPY/EURUSD leg it converts through were almost never present in
// the same map — 736 entries in one day vetoed `usd_per_lot_unknown`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { recordFxRates, loadFxRates, fxRatesStatus, RATE_MAX_AGE_MS } from './fx-rates.js'
import { usdRate, usdLossPerLot } from '../lib/contracts.js'

const T0 = Date.UTC(2026, 7, 2, 12, 0, 0)
const scan = (...pairs) => ({ scans: pairs.map(([symbol, price]) => ({ symbol, price })) })

test('fx-rates — remembers across cycles, which is the whole point', () => {
  const db = initDB(':memory:')
  // Cycle 1 scans the majors; cycle 2 rotates to a different 15 including
  // EURJPY. Neither batch alone can size EURJPY.
  recordFxRates(db, scan(['EURUSD', 1.08], ['USDJPY', 157]), T0)
  recordFxRates(db, scan(['EURJPY', 170], ['GBPAUD', 1.9]), T0 + 5 * 60_000)

  const rates = loadFxRates(db, T0 + 6 * 60_000)
  assert.equal(rates.EURUSD, 1.08, 'cycle-1 rate survived cycle 2')
  assert.equal(rates.USDJPY, 157)
  assert.equal(rates.EURJPY, 170)

  // And the thing that was actually failing now resolves.
  const r = usdRate('JPY', rates)
  assert.ok(Math.abs(r - 1 / 157) < 1e-9, `JPY via USDJPY, got ${r}`)
  const perLot = usdLossPerLot('EURJPY', 0.5, 170, rates)
  assert.ok(Number.isFinite(perLot) && perLot > 0, `EURJPY sizes, got ${perLot}`)
})

test('fx-rates — the newest close wins on re-scan', () => {
  const db = initDB(':memory:')
  recordFxRates(db, scan(['EURUSD', 1.08]), T0)
  recordFxRates(db, scan(['EURUSD', 1.09]), T0 + 60_000)
  assert.equal(loadFxRates(db, T0 + 2 * 60_000).EURUSD, 1.09)
})

test('fx-rates — stale entries are DROPPED, so the gate vetoes instead of guessing', () => {
  const db = initDB(':memory:')
  recordFxRates(db, scan(['EURUSD', 1.08]), T0)
  const justInside = loadFxRates(db, T0 + RATE_MAX_AGE_MS - 1_000)
  assert.equal(justInside.EURUSD, 1.08)
  const pastWindow = loadFxRates(db, T0 + RATE_MAX_AGE_MS + 1_000)
  assert.equal(pastWindow.EURUSD, undefined, 'aged out rather than silently reused')
  // And with it gone, sizing refuses rather than inventing a rate.
  assert.ok(Number.isNaN(usdRate('EUR', pastWindow)))
})

test('fx-rates — junk prices are never recorded', () => {
  const db = initDB(':memory:')
  recordFxRates(db, scan(['EURUSD', 0], ['GBPUSD', -1], ['USDJPY', NaN], ['AUDUSD', 0.66]), T0)
  const rates = loadFxRates(db, T0)
  assert.deepEqual(Object.keys(rates), ['AUDUSD'])
})

test('fx-rates — malformed payloads leave the table intact', () => {
  const db = initDB(':memory:')
  recordFxRates(db, scan(['EURUSD', 1.08]), T0)
  recordFxRates(db, null, T0 + 1000)
  recordFxRates(db, { scans: 'not-an-array' }, T0 + 2000)
  assert.equal(loadFxRates(db, T0 + 3000).EURUSD, 1.08)
})

test('fx-rates — status reports coverage and age for the operator', () => {
  const db = initDB(':memory:')
  recordFxRates(db, scan(['EURUSD', 1.08], ['USDJPY', 157]), T0)
  const st = fxRatesStatus(db, T0 + 10 * 60_000)
  assert.equal(st.symbols, 2)
  assert.equal(st.stale, 0)
  assert.equal(st.oldestAgeMin, 10)
  assert.equal(st.maxAgeHours, 26)
})

test('fx-rates — the three production veto symbols all size from an accumulated table', () => {
  const db = initDB(':memory:')
  // Spread the legs across four separate cycles, as the rotation really does.
  recordFxRates(db, scan(['EURUSD', 1.08]), T0)
  recordFxRates(db, scan(['AUDUSD', 0.66]), T0 + 5 * 60_000)
  recordFxRates(db, scan(['EURJPY', 170], ['EURGBP', 0.85]), T0 + 10 * 60_000)
  recordFxRates(db, scan(['AUDPLN', 2.6]), T0 + 15 * 60_000)
  const rates = loadFxRates(db, T0 + 16 * 60_000)

  for (const [sym, dist, price] of [['EURJPY', 0.5, 170], ['EURGBP', 0.004, 0.85], ['AUDPLN', 0.01, 2.6]]) {
    const v = usdLossPerLot(sym, dist, price, rates)
    assert.ok(Number.isFinite(v) && v > 0, `${sym} should size, got ${v}`)
  }
})
