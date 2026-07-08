// node --test agent/lib/lot-sizing.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { lotsToVolume, volumeToLots } from './lot-sizing.js'

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
