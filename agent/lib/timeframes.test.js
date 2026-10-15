// node --test agent/lib/timeframes.test.js
// parseTimeframe / fetchPlan / aggregateBars — free-text timeframe engine.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextBarCloseMs, parseTimeframe, tfMs, fetchPlan, aggregateBars } from './timeframes.js'

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

test('nextBarCloseMs: the forming bar\'s close — epoch-aligned intraday/daily, Saturday 00:00 UTC for 1w, first of next month for 1mo, null for junk', () => {
  const wed = Date.UTC(2026, 8, 2, 22, 19, 47) // Wed 02-09-2026 22:19:47 UTC
  assert.equal(nextBarCloseMs('4h', wed), Date.UTC(2026, 8, 3, 0, 0, 0))
  assert.equal(nextBarCloseMs('1d', wed), Date.UTC(2026, 8, 3, 0, 0, 0))
  assert.equal(nextBarCloseMs('1h', Date.UTC(2026, 8, 2, 22, 0, 0)), Date.UTC(2026, 8, 2, 23, 0, 0), 'exactly on a boundary → the NEXT boundary')
  assert.equal(nextBarCloseMs('1w', wed), Date.UTC(2026, 8, 5, 0, 0, 0), 'Sat 05-09 00:00 UTC, after the Friday session')
  assert.equal(nextBarCloseMs('1w', Date.UTC(2026, 8, 5, 0, 0, 0)), Date.UTC(2026, 8, 12, 0, 0, 0), 'on a Saturday → the following Saturday')
  assert.equal(nextBarCloseMs('1mo', wed), Date.UTC(2026, 9, 1, 0, 0, 0))
  assert.equal(nextBarCloseMs('junk', wed), null)
  assert.equal(nextBarCloseMs('1d', NaN), null)
})

// ── № 15,036 15-Oct (Codex round 2 on #1379; claude-builder) ──
test('barCloseMs: an aggregate closes with its LAST constituent; a native or stored bar at open + period', async () => {
  const { barCloseMs } = await import('./timeframes.js')
  const H = 3_600_000
  const fri20 = Date.UTC(2026, 8, 4, 20), mon0 = Date.UTC(2026, 8, 7, 0)
  const [agg] = aggregateBars([{ t: fri20, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }, { t: mon0, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }], 2) // an 8h from two 4h bars
  assert.equal(agg.t, fri20); assert.equal(agg.tLast, mon0)
  assert.equal(barCloseMs(agg, 8 * H), mon0 + 4 * H, 'closed when the Monday 00:00 4h bar closes, not at Friday 20:00 + 8h')
  assert.ok(barCloseMs(agg, 8 * H) > Date.UTC(2026, 8, 7, 1), 'RED before: at Monday 01:00 the fixed-duration test called it closed')
  assert.equal(barCloseMs({ t: fri20 }, 4 * H), fri20 + 4 * H, 'a native bar')
  assert.equal(barCloseMs([fri20, 1, 2, 0.5, 1.5, 1], 8 * H), fri20 + 8 * H, 'a stored bar carries no tLast')
})

test('round 4 P2 on #1379: a monthly bar closes at the next calendar month, not 30 days on', async () => {
  const { barCloseMs, tfMs, aggregateBars } = await import('./timeframes.js')
  const mo = tfMs('1mo')
  assert.equal(barCloseMs([Date.UTC(2026, 2, 1)], mo), Date.UTC(2026, 3, 1), 'RED before: March 1 + 30 d = March 31, while the bar was still forming')
  assert.equal(barCloseMs({ t: Date.UTC(2026, 1, 1) }, mo), Date.UTC(2026, 2, 1), 'February closes on March 1, not 30 days on')
  assert.equal(barCloseMs([Date.UTC(2026, 0, 1)], 2 * mo), Date.UTC(2026, 2, 1), 'a stored 2mo array: two calendar months')
  const agg = aggregateBars([{ t: Date.UTC(2026, 0, 1), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: Date.UTC(2026, 1, 1), o: 1, h: 1, l: 1, c: 1, v: 1 }], 2)[0]
  assert.equal(barCloseMs(agg, 2 * mo), Date.UTC(2026, 2, 1), 'a synthesised 2mo closes with its last constituent\'s calendar month')
  assert.equal(barCloseMs([Date.UTC(2026, 8, 4, 20)], 4 * 3_600_000), Date.UTC(2026, 8, 4, 20) + 4 * 3_600_000, 'sub-month bars unchanged')
})
