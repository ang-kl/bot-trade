// node --test agent/lib/lot-sizing.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { lotsToVolume, volumeToLots, relativePoints, getVolumeMeta, _cache } from './lot-sizing.js'

// Real Pepperstone-style FX meta: 1 lot = 100,000 units = 10,000,000 cents.
const FX = { lotSize: 10_000_000, minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000 }
// Metals-style: 1 lot = 100 oz = 10,000 cents-of-units.
const XAU = { lotSize: 10_000, minVolume: 100, maxVolume: 10_000_000, stepVolume: 100 }

test('0.01 lot FX = 100,000 protocol volume (the old constant sent 100)', () => {
  const r = lotsToVolume(0.01, FX)
  assert.equal(r.volume, 100_000)
  assert.equal(r.belowMin, false)
})

test('1 lot FX = 10,000,000; round-trips through volumeToLots', () => {
  const r = lotsToVolume(1, FX)
  assert.equal(r.volume, 10_000_000)
  assert.equal(volumeToLots(r.volume, FX), 1)
})

test('below broker minimum is flagged, not silently sent', () => {
  const r = lotsToVolume(0.005, FX) // 50,000 < min 100,000
  assert.equal(r.belowMin, true)
})

test('volume snaps DOWN to stepVolume', () => {
  const r = lotsToVolume(0.017, FX) // 170,000 → floor to step 100,000
  assert.equal(r.volume, 100_000)
})

test('metals use their own lotSize', () => {
  const r = lotsToVolume(0.5, XAU)
  assert.equal(r.volume, 5_000)
  assert.equal(r.belowMin, false)
})

test('maxVolume clamps and flags', () => {
  const r = lotsToVolume(99_999, XAU)
  assert.equal(r.aboveMax, true)
  assert.equal(r.volume, XAU.maxVolume)
})

// relativePoints: cTrader wants relative SL/TP in 1/100000-of-price units,
// SNAPPED to the symbol's digits — finer precision is rejected with
// "Relative stop loss has invalid precision" (hit live on the BTCUSD
// validation fill, digits=2).

test('relativePoints: 5-digit FX passes through unchanged (step 1)', () => {
  assert.equal(relativePoints(0.0057739, 5), 577)
  assert.equal(relativePoints(0.005, 5), 500)
})

test('relativePoints: 2-digit symbols snap to whole cents — BTCUSD regression', () => {
  // BTC ~67,000: 0.5% SL = 335.27891. Raw rounding gives 33_527_891 — NOT
  // divisible by 10^(5-2)=1000 → broker INVALID_REQUEST. Snapped:
  assert.equal(relativePoints(335.27891, 2), 33_528_000)
  assert.equal(relativePoints(335.27891, 2) % 1000, 0)
})

test('relativePoints: never collapses to zero — a tiny real stop keeps one step', () => {
  assert.equal(relativePoints(0.000004, 5), 1)
  assert.equal(relativePoints(0.004, 2), 1000)
})

test('relativePoints: missing/garbage digits default to 5', () => {
  assert.equal(relativePoints(0.005, undefined), 500)
  assert.equal(relativePoints(0.005, 'nope'), 500)
})

test('the actual symbol adapter retains raw broker precision on fresh and cached reads', async (t) => {
  _cache.clear()
  t.after(() => _cache.clear())
  const cases = [
    [undefined, 5], [null, 5], ['', 0], [' ', 0], [false, 0], [true, 1],
    [-1, -1], [2.5, 2.5], [NaN, NaN], [Infinity, Infinity], [0, 0], ['3', 3],
  ]
  for (let i = 0; i < cases.length; i++) {
    const [raw, legacy] = cases[i]
    const symbol = { symbolId: i + 1, lotSize: 10000, ...(raw === undefined ? {} : { digits: raw }) }
    let reads = 0
    const deps = { wsSymbolsByIds: async () => { reads++; return { symbol: [symbol] } } }
    const args = ['fixture', 'id', 'secret', 'token', 8000 + i, i + 1, deps]
    const meta = await getVolumeMeta(...args)
    assert.equal(Object.hasOwn(meta, 'brokerDigits'), true, 'absence must remain explicit, not a sizing default')
    assert.ok(Object.is(meta.brokerDigits, raw), `raw precision ${String(raw)} is retained`)
    assert.ok(Object.is(meta.digits, legacy), 'existing sizing normalization stays unchanged')
    assert.equal(await getVolumeMeta(...args), meta, 'cache retains the same provenance')
    assert.equal(reads, 1)
  }
})
