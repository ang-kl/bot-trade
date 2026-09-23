// Frozen outputs come from the actual JavaScript owners, never the native port.
// Run with Node 22 from the repository root when the reference contract changes.
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { computeDonchianBreakout } from '../agent/services/donchian-breakout.js'
import { computeRsi2 } from '../agent/services/rsi2-reversion.js'
import { computeVwapTrend } from '../agent/services/vwap-trend.js'
import { computeFibConfluence } from '../agent/services/fib-confluence.js'
import { findSwings } from '../agent/services/fib-strategy.js'
import { nativeProfileHash } from '../agent/services/scanner-profiles.js'
import { tfMs } from '../agent/lib/timeframes.js'

const owners = { donchian_breakout: computeDonchianBreakout, rsi2_reversion: computeRsi2,
  vwap_trend: computeVwapTrend, fib_confluence: computeFibConfluence }
const fixtures = [], end = Date.parse('2026-09-22T18:00:00Z')
const bar = (c, h = c + 0.4, l = c - 0.4, v = 1000) => ({ o: c, h, l, c, v })
const mirror = bars => bars.map(b => ({ ...b, o: 400 - b.o, h: 400 - b.l, l: 400 - b.h, c: 400 - b.c }))
function add(name, strategy, input, timeframe = '1h') {
  const duration = tfMs(timeframe), bars = input.map((b, i) => ({ ...b, t: end - (input.length - i) * duration }))
  const expected = owners[strategy](bars, timeframe)
  fixtures.push({ name, request: { schemaVersion: 1, purpose: 'mirror',
    feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' },
    feedEpoch: 'frozen1', configVersion: 'v1', profileHash: nativeProfileHash(strategy), candidateTtlMs: 60000,
    strategy, timeframe, barMode: 'closed', barDurationMs: duration, options: {},
    receivedAtMs: end, sourceTimestampMs: bars.at(-1).t, bars }, expected })
  return expected
}
const triangle = Array.from({ length: 45 }, (_, i) => {
  const p = i % 12; return bar(100 + (p <= 6 ? p : 12 - p) / 6 * 10, undefined, undefined)
})
const breakout = [...triangle, bar(111.5, 111.7, 109.5, 2000)]
for (const [name, b] of [['long', breakout], ['short', mirror(breakout)]]) {
  assert.equal(add(name, 'donchian_breakout', b)?.bias, name)
  for (const v of [0, 1199.999, 1200, 1799.999, 1800])
    add(`${name}-volume-${v}`, 'donchian_breakout', b.map((x, i) => i === b.length - 1 ? { ...x, v } : x))
}
add('warmup', 'donchian_breakout', breakout.slice(-39))
add('overshoot', 'donchian_breakout', [...triangle, bar(118, 118.3, 109.5, 2000)])

const trend = Array.from({ length: 120 }, (_, i) => bar(100 + i))
const washout = [...trend, bar(214), bar(209)]
for (const [name, b] of [['long', washout], ['short', mirror(washout)]]) {
  assert.equal(add(name, 'rsi2_reversion', b)?.bias, name)
  for (const timeframe of ['30m', '1h', '1.5h', '4h', '1d']) add(`${name}-${timeframe}`, 'rsi2_reversion', b, timeframe)
  add(`${name}-warmup`, 'rsi2_reversion', b.slice(-103))
}

// Seeded independent input generation finds both sides and no-signal cases.
// Every selected fixture retains its bars and full reference output.
let seed = 1769
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32)
for (const strategy of ['vwap_trend', 'fib_confluence']) {
  const counts = { long: 0, short: 0, none: 0 }
  for (let attempt = 0; attempt < 10000 && Object.values(counts).some(n => n < 4); attempt++) {
    let price = 100
    const input = Array.from({ length: 80 }, () => {
      price += (random() - 0.5) * 2
      return bar(price, price + random() * 2, price - random() * 2, Math.floor(random() * 2000))
    })
    const timed = input.map((b, i) => ({ ...b, t: end - (input.length - i) * 3600000 }))
    const side = owners[strategy](timed, '1h')?.bias || 'none'
    if (counts[side] >= 4) continue
    counts[side]++
    add(`seeded-${side}-${counts[side]}`, strategy, input)
  }
  assert.deepEqual(counts, { long: 4, short: 4, none: 4 })
  const first = fixtures.find(f => f.request.strategy === strategy && f.expected).request.bars
  add('warmup', strategy, first.slice(-29))
  add('zero-volume', strategy, first.map(b => ({ ...b, v: 0 })))
  for (const timeframe of ['5m', '1d', '1w', '1mo']) add(`anchor-${timeframe}`, strategy, first, timeframe)
}
writeFileSync('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json', JSON.stringify(fixtures) + '\n')

const pivotCases = [
  ['flat', Array.from({ length: 9 }, () => bar(100, 101, 99))],
  ['unique', [100, 101, 105, 101, 100, 99, 95, 99, 100].map(c => bar(c))],
  ['tied-high', [100, 101, 105, 105, 100, 99, 95, 99, 100].map(c => bar(c))],
  ['tied-low', [100, 101, 105, 101, 100, 95, 95, 99, 100].map(c => bar(c))],
]
writeFileSync('cpp-scan-timeframe/src/tests/fixtures/pivots-parity.json', JSON.stringify(pivotCases.map(([name, input]) => {
  const bars = input.map((b, i) => ({ ...b, t: i * 60000 }))
  return { name, bars, expected: findSwings(bars) }
})) + '\n')
console.log(JSON.stringify({ fixtures: fixtures.length, pivots: pivotCases.length }))
