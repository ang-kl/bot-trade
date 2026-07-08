// node --test agent/lib/timeframes.test.js
// parseTimeframe / fetchPlan / aggregateBars — free-text timeframe engine.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTimeframe, tfMs, fetchPlan, aggregateBars } from './timeframes.js'

test('native labels pass through unchanged', () => {
  assert.deepEqual(parseTimeframe('4h'), { label: '4h', ms: 14_400_000 })
  assert.deepEqual(parseTimeframe('1mo'), { label: '1mo', ms: 2_592_000_000 })
})

test('unit spellings normalise: 15min→15m, 2hr→2h, 1M→1mo', () => {
  assert.deepEqual(parseTimeframe('15min'), { label: '15m', ms: 900_000 })
  assert.equal(parseTimeframe('2hr').label, '2h')
  assert.deepEqual(parseTimeframe('1M'), { label: '1mo', ms: 2_592_000_000 })
})

test('decimals allowed from hours up: 1.5h, 0.25d; comma accepted', () => {
  assert.deepEqual(parseTimeframe('1.5h'), { label: '1.5h', ms: 5_400_000 })
  assert.equal(parseTimeframe('0.25d').ms, 21_600_000) // 6h
  assert.equal(parseTimeframe('1,5h').ms, 5_400_000)
})

test('rejects: decimal minutes, non-whole-minute, junk, zero, >1y', () => {
  assert.equal(parseTimeframe('1.5m'), null)
  assert.equal(parseTimeframe('0.001h'), null)
  assert.equal(parseTimeframe('banana'), null)
  assert.equal(parseTimeframe('0h'), null)
  assert.equal(parseTimeframe('13mo'), null)
})

test('exact native durations canonicalise to the native label (24h→1d)', () => {
  assert.equal(parseTimeframe('24h').label, '1d')
  assert.equal(parseTimeframe('60m').label, '1h')
})

test('tfMs reads native and custom labels, 0 for junk', () => {
  assert.equal(tfMs('4h'), 14_400_000)
  assert.equal(tfMs('1.5h'), 5_400_000)
  assert.equal(tfMs('nope'), 0)
})

test('fetchPlan picks the LARGEST dividing native period', () => {
  assert.deepEqual(fetchPlan(5_400_000), { base: '30m', factor: 3 })    // 1.5h
  assert.deepEqual(fetchPlan(21_600_000), { base: '1h', factor: 6 })    // 6h
  assert.deepEqual(fetchPlan(5_184_000_000), { base: '1mo', factor: 2 }) // 2mo
})

test('aggregateBars: end-anchored chunks, OHLCV composed correctly', () => {
  const bars = Array.from({ length: 7 }, (_, i) => ({
    t: i * 1000, o: i + 1, h: i + 1.5, l: i + 0.5, c: i + 1.2, v: 10,
  }))
  const out = aggregateBars(bars, 3) // 7 % 3 = 1 leading bar dropped
  assert.equal(out.length, 2)
  const first = out[0] // bars 1..3
  assert.equal(first.t, 1000)
  assert.equal(first.o, 2)        // open of first bar in chunk
  assert.equal(first.h, 4.5)      // max high
  assert.equal(first.l, 1.5)      // min low
  assert.equal(first.c, 4.2)      // close of last bar in chunk
  assert.equal(first.v, 30)       // summed volume
})
