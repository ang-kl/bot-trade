// node --test agent/services/fast-monitor.test.js
//
// Fast monitor cadence policy: base interval from monitor_interval_min,
// scaled by the instrument's relative 1-minute volume — busy markets get
// the fastest checks, quiet ones the slowest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cadenceMs, relVolFromBars, effectiveCadenceMs, isSpikeMove, SPIKE_PCT_PER_MIN, frozenQuoteUpdate, FROZEN_QUOTE_DEFAULT_MIN } from './fast-monitor.js'

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

test('isSpikeMove: fast enough move since the last check counts as a spike', () => {
  const t0 = 1_000_000
  // 0.5% in 30s = 1%/min — above the 0.4%/min default threshold.
  assert.equal(isSpikeMove(100, t0, 100.5, t0 + 30_000), true)
  // Same 0.5% move stretched over 5 minutes = 0.1%/min — not a spike.
  assert.equal(isSpikeMove(100, t0, 100.5, t0 + 5 * MIN), false)
  // Custom threshold widens/narrows what counts.
  assert.equal(isSpikeMove(100, t0, 100.05, t0 + 30_000, 0.05), true)
})

test('isSpikeMove: no prior sample, non-finite price, or non-advancing clock never spikes', () => {
  const t0 = 1_000_000
  assert.equal(isSpikeMove(undefined, undefined, 101, t0), false)
  assert.equal(isSpikeMove(100, t0, null, t0 + MIN), false)
  assert.equal(isSpikeMove(100, t0, 200, t0), false)      // clock didn't advance
  assert.equal(isSpikeMove(0, t0, 1, t0 + MIN), false)    // prevMid <= 0 is garbage, not "infinite move"
})

test('SPIKE_PCT_PER_MIN is exported and isSpikeMove uses it as the default threshold', () => {
  const t0 = 1_000_000
  const justUnder = 100 * (1 + (SPIKE_PCT_PER_MIN - 0.01) / 100)
  const justOver = 100 * (1 + (SPIKE_PCT_PER_MIN + 0.01) / 100)
  assert.equal(isSpikeMove(100, t0, justUnder, t0 + MIN), false)
  assert.equal(isSpikeMove(100, t0, justOver, t0 + MIN), true)
})

// Frozen-quote detector (hardening batch 6a) ----------------------------

test('frozenQuoteUpdate: first sighting and any price movement restart the episode', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  assert.deepEqual(r, { rec: { mid: 1.1, changedAt: t0, alerted: false }, alert: false, recovered: false })
  r = frozenQuoteUpdate(r.rec, 1.1001, t0 + MIN, 10 * MIN)
  assert.equal(r.rec.changedAt, t0 + MIN)
  assert.equal(r.alert, false)
})

test('frozenQuoteUpdate: unchanged past the threshold alerts exactly once', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 9 * MIN, 10 * MIN)
  assert.equal(r.alert, false)                              // still inside the threshold
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 11 * MIN, 10 * MIN)
  assert.equal(r.alert, true)                               // breach → alert
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 30 * MIN, 10 * MIN)
  assert.equal(r.alert, false)                              // same episode → no re-alert
})

test('frozenQuoteUpdate: movement after an alert reports recovery and re-arms', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 11 * MIN, 10 * MIN)
  assert.equal(r.alert, true)
  r = frozenQuoteUpdate(r.rec, 1.2, t0 + 12 * MIN, 10 * MIN)
  assert.equal(r.recovered, true)
  assert.equal(r.rec.alerted, false)                        // fresh episode — can alert again
  r = frozenQuoteUpdate(r.rec, 1.2, t0 + 23 * MIN, 10 * MIN)
  assert.equal(r.alert, true)
})

test('frozenQuoteUpdate: threshold 0 disables alerting entirely', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 0)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 100 * MIN, 0)
  assert.equal(r.alert, false)
  assert.equal(FROZEN_QUOTE_DEFAULT_MIN, 10)
})
