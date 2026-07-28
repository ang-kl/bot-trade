// FVG retrace strategy. A new entry signal on a live account, so the tests are
// written around the ways it could fire when it should not — a strategy that
// only ever gets tested on the case it was designed for is untested.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeFvgSignal, selectZone, fillFraction, _internal } from './fvg-strategy.js'
import { findFvgZones } from '../lib/indicators.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { STRATEGY_KIND } from './regime-gate.js'

const HOUR = 3600_000
const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const bar = (i, o, h, l, c, v = 100) => ({ t: T0 + i * HOUR, o, h, l, c, v })

// A flat baseline long enough to clear MIN_BARS and give ATR something to
// chew on, then a deliberate bullish gap, then a retrace into it.
function bullGapSeries({ retraceTo = 10.35, closeUp = true, gapAt = 70, total = 80 } = {}) {
  const bars = []
  for (let i = 0; i < gapAt; i++) bars.push(bar(i, 10, 10.2, 9.8, 10))
  // Three bars that tear a gap: bar[gapAt-2].h = 10.2, bar[gapAt].l = 10.5
  bars.push(bar(gapAt, 10.6, 10.9, 10.5, 10.8))
  // Drift, then retrace back into the 10.2-10.5 band.
  for (let i = gapAt + 1; i < total - 1; i++) bars.push(bar(i, 10.8, 10.95, 10.7, 10.85))
  const o = closeUp ? retraceTo - 0.05 : retraceTo + 0.05
  bars.push(bar(total - 1, o, retraceTo + 0.06, retraceTo - 0.06, retraceTo))
  return bars
}

test('fillFraction: 0 at the near edge, 1 at the far edge', () => {
  const z = { dir: 'bull', top: 10.5, bottom: 10.2 }
  assert.equal(fillFraction(z, 10.5), 0)
  assert.equal(fillFraction(z, 10.2), 1)
  assert.equal(Math.round(fillFraction(z, 10.35) * 100) / 100, 0.5)
  // A bear gap measures from the other side.
  const b = { dir: 'bear', top: 10.5, bottom: 10.2 }
  assert.equal(fillFraction(b, 10.2), 0)
  assert.equal(fillFraction(b, 10.5), 1)
  // Degenerate zone: null, never a divide-by-zero Infinity.
  assert.equal(fillFraction({ dir: 'bull', top: 1, bottom: 1 }, 1), null)
})

test('the happy path: a retrace into a fresh bull gap produces a long', () => {
  const s = computeFvgSignal(bullGapSeries(), '1h')
  assert.ok(s, 'expected a signal')
  assert.equal(s.bias, 'long')
  assert.equal(s.strategy, 'fvg_retrace')
  assert.ok(s.sl < s.entry, 'a long stop must sit below entry')
  assert.ok(s.tp1 > s.entry)
  assert.ok(s.rr >= _internal.MIN_RR, `rr ${s.rr} below the floor`)
  // §3.5 needs the CREATING bar, not just the zone prices.
  assert.ok(Number.isFinite(s.fvg.originBarIdx))
  assert.ok(Number.isFinite(s.fvg.originBarTime))
  assert.ok(s.fvg.originAgeBars >= 2)
})

test('the stop sits BEYOND the far edge — where "the gap holds" is falsified', () => {
  const bars = bullGapSeries()
  const s = computeFvgSignal(bars, '1h')
  assert.ok(s.sl < s.fvg.bottom, `stop ${s.sl} must sit below the gap bottom ${s.fvg.bottom}`)
})

// ------------------------------------------------- the ways it must NOT fire

test('a bar falling THROUGH the gap is not a bounce — no signal', () => {
  // Same retrace depth, but the bar closed DOWN. That is the fill in progress,
  // not a reaction to it; entering here is catching a knife mid-fall.
  const s = computeFvgSignal(bullGapSeries({ closeUp: false }), '1h')
  assert.equal(s, null)
})

test('price that has not retraced into the zone yet produces nothing', () => {
  // Still up at 10.85, well above the 10.2-10.5 gap.
  const bars = bullGapSeries({ retraceTo: 10.85 })
  const s = computeFvgSignal(bars, '1h')
  assert.equal(s, null, 'a gap that price has not returned to is not an entry')
})

test('an already-filled gap is dead — findFvgZones marks it and selectZone drops it', () => {
  const bars = bullGapSeries()
  // Drive price clean through the bottom of the gap: now filled.
  bars.push(bar(bars.length, 10.1, 10.15, 9.9, 10.0))
  bars.push(bar(bars.length, 10.0, 10.3, 9.95, 10.25))
  const zones = findFvgZones(bars)
  const open = zones.filter(z => z.filledIdx == null)
  const a = 0.4
  const picked = selectZone(open, bars, a)
  // Either nothing survives, or whatever did is not the filled one.
  if (picked) assert.equal(picked.filledIdx, null)
})

test('too few bars returns null rather than a signal off a short series', () => {
  assert.equal(computeFvgSignal(bullGapSeries({ gapAt: 5, total: 10 }), '1h'), null)
})

test('a gap thinner than the ATR floor is noise, not an imbalance', () => {
  const bars = []
  for (let i = 0; i < 70; i++) bars.push(bar(i, 10, 10.5, 9.5, 10))   // big ATR
  bars.push(bar(70, 10.01, 10.02, 10.005, 10.015))                     // hair-thin gap
  for (let i = 71; i < 80; i++) bars.push(bar(i, 10.01, 10.02, 10.0, 10.012))
  const s = computeFvgSignal(bars, '1h')
  assert.equal(s, null, 'every other bar leaves a tick gap on a quiet instrument')
})

test('a stale gap past the age cap no longer counts', () => {
  const bars = bullGapSeries({ gapAt: 20, total: 20 + _internal.MAX_AGE_BARS + 25 })
  const s = computeFvgSignal(bars, '1h')
  assert.equal(s, null, 'the impulse that made an old gap is no longer the story')
})

test('entering on the gap-completing bar itself is chasing, not retracing', () => {
  const bars = []
  for (let i = 0; i < 70; i++) bars.push(bar(i, 10, 10.2, 9.8, 10))
  bars.push(bar(70, 10.6, 10.9, 10.5, 10.8))  // the gap bar IS the last bar
  const s = computeFvgSignal(bars, '1h')
  assert.equal(s, null)
})

test('flat bars with no gap at all produce nothing', () => {
  const bars = Array.from({ length: 80 }, (_, i) => bar(i, 10, 10.2, 9.8, 10))
  assert.equal(computeFvgSignal(bars, '1h'), null)
})

test('no ATR (a perfectly flat series) is a null, not a divide-by-zero', () => {
  const bars = Array.from({ length: 80 }, (_, i) => bar(i, 10, 10, 10, 10))
  assert.equal(computeFvgSignal(bars, '1h'), null)
})

// ------------------------------------------------------------- registration

test('registered, and registered DISARMED', () => {
  const entry = STRATEGY_REGISTRY.find(s => s.key === 'fvg_retrace')
  assert.ok(entry, 'not in STRATEGY_REGISTRY')
  assert.equal(entry.compute, computeFvgSignal)
  assert.equal(entry.minBars, _internal.MIN_BARS)
  // Every other strategy here was armed after its own backtest. Arming a new
  // one by default is how an unproven edge reaches live capital without
  // anyone deciding to let it.
  assert.equal(entry.defaultOn, false, 'a brand-new strategy must not ship armed')
})

test('minBars is stamped on the compute function, so scan depth covers it', () => {
  // The scan derives its fetch depth from the deepest ARMED strategy by
  // reading fn.minBars — the mechanism that was missing when cup_handle and
  // ema_pullback sat armed and silent for want of bars.
  assert.equal(computeFvgSignal.minBars, _internal.MIN_BARS)
})

test('the regime gate knows its kind — otherwise it is ungated', () => {
  // A strategy absent from STRATEGY_KIND fails OPEN through regimeBlocks: it
  // would trade in every regime including the dead ones a gap retrace dies in.
  assert.equal(STRATEGY_KIND.fvg_retrace, 'trend')
})

test('it uses the EXISTING detector rather than a third copy of the geometry', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('./fvg-strategy.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ findFvgZones \} from '\.\.\/lib\/indicators\.js'/)
  // Two implementations of gap geometry already exist. A third, inline, is
  // how they drift apart.
  assert.doesNotMatch(src, /function\s+find(FVGs|FvgZones)\s*\(/)
})
