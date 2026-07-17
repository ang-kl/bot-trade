// node --test agent/services/fast-monitor.test.js
//
// Fast monitor cadence policy: base interval from monitor_interval_min,
// scaled by the instrument's relative 1-minute volume — busy markets get
// the fastest checks, quiet ones the slowest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cadenceMs, relVolFromBars, effectiveCadenceMs } from './fast-monitor.js'

const MIN = 60_000

test('cadence: busy market checks at base speed, average 2×, quiet 3×', () => {
  assert.equal(cadenceMs(2.0, 1), 1 * MIN)
  assert.equal(cadenceMs(1.5, 1), 1 * MIN)
  assert.equal(cadenceMs(1.0, 1), 2 * MIN)
  assert.equal(cadenceMs(0.75, 1), 2 * MIN)
  assert.equal(cadenceMs(0.2, 1), 3 * MIN)
})

test('cadence: base minutes scale linearly; unknown volume = middle pace', () => {
  assert.equal(cadenceMs(2.0, 3), 3 * MIN)
  assert.equal(cadenceMs(0.2, 2), 6 * MIN)
  assert.equal(cadenceMs(NaN, 1), 2 * MIN)
})

test('cadence: garbage base falls back to 1 minute, floor 30s', () => {
  assert.equal(cadenceMs(2.0, undefined), 1 * MIN)
  assert.equal(cadenceMs(2.0, 0), 1 * MIN)      // 0 is garbage → default 1m
  assert.equal(cadenceMs(2.0, 0.25), 30_000)    // sub-30s floors at 30s
})

test('relVolFromBars: last CLOSED bar vs prior average; forming bar dropped', () => {
  const mk = (vols) => vols.map((v, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1, v }))
  // 6 closed bars of 100 + last closed 300 + forming 5 (ignored) → relVol 3
  const bars = mk([100, 100, 100, 100, 100, 100, 300, 5])
  assert.ok(Math.abs(relVolFromBars(bars) - 3) < 1e-9)
  assert.ok(Number.isNaN(relVolFromBars(mk([100, 100]))), 'too few bars → NaN')
  assert.ok(Number.isNaN(relVolFromBars(mk([0, 0, 0, 0, 0, 0, 0, 0]))), 'zero volume → NaN')
})

test('owner override beats the volume-adaptive cadence, both directions', () => {
  // hot market would say 1m — override throttles to 10m
  assert.equal(effectiveCadenceMs(10, 2.0, 1), 10 * MIN)
  // quiet market would say 3m — override pins to 30s
  assert.equal(effectiveCadenceMs(0.5, 0.2, 1), 30_000)
  // floor: overrides can never go below 15s
  assert.equal(effectiveCadenceMs(0.1, 2.0, 1), 15_000)
  // no/garbage override → volume-adaptive
  assert.equal(effectiveCadenceMs(null, 0.2, 1), 3 * MIN)
  assert.equal(effectiveCadenceMs('nope', 2.0, 1), 1 * MIN)
})
