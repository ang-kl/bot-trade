// node --test agent/services/va-breakout.test.js
//
// Value-Area breakout (owner spec, 2026-07-26): open inside yesterday's
// value area → a completed candle CLOSES beyond VAH/VAL (confirmation) →
// price pulls back to the broken level and holds — that pullback is the
// entry, never the breakout candle itself.
//
// Fixtures inject `opts.structure` (the volume-structure read) so each rule
// is tested against exact numbers instead of hoping a bar series lands the
// profile where the test needs it. The structure derivation itself is
// covered in agent/lib/volume-structure.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeVaBreakout } from './va-breakout.js'

// Yesterday: VAL 100, VAH 110, VPOC 105, height 10.
const PREV = { vpoc: 105, vah: 110, val: 100, height: 10, rows: [] }

const T0 = 1_000_000_000_000

// Bars with ~1.0 ATR: each bar spans h-l = 1. `spec` overrides the last bars.
function barsWith(lastBars, { count = 70 } = {}) {
  const bars = []
  for (let i = 0; i < count - lastBars.length; i++) {
    bars.push({ t: T0 + i * 60_000, o: 105, h: 105.5, l: 104.5, c: 105, v: 1000 })
  }
  lastBars.forEach((b, j) => bars.push({ t: T0 + (count - lastBars.length + j) * 60_000, v: 1000, ...b }))
  return bars
}

const structure = (over = {}) => ({
  prev: PREV,
  current: null,
  openPrice: 105,
  openMs: T0,                 // every fixture bar is inside "today"
  sessionBars: 70,
  structure: 'ranging',
  reference: null,
  role: null,
  lvns: [],
  migration: null,
  ...over,
})

// The canonical long: bar[-2] CLOSED above the VAH (confirmation), the live
// bar pulled back to the VAH (low touches 110) and holds above it.
function confirmedPullbackBars() {
  return barsWith([
    { o: 109, h: 111.6, l: 108.8, c: 111.5 },  // the confirming close above 110
    { o: 111.3, h: 111.4, l: 110.1, c: 110.9 }, // pullback to the level, holding
  ])
}

test('the canonical sequence signals: inside open, confirmed close, pullback hold', () => {
  const sig = computeVaBreakout(confirmedPullbackBars(), '15m', { structure: structure() })
  assert.ok(sig)
  assert.equal(sig.bias, 'long')
  assert.equal(sig.strategy, 'va_breakout')
  // Target: one value-area height beyond the broken VAH.
  assert.ok(Math.abs(sig.tp1 - 120) < 1e-9)
  assert.ok(sig.sl < 110, 'stop is back inside the value area')
  assert.ok(sig.rr >= 1.5)
})

test('no confirmed close beyond the edge -> no signal, whatever the pullback looks like', () => {
  // Price grinds at the VAH but every completed bar closed INSIDE the area.
  const bars = barsWith([
    { o: 109, h: 110.4, l: 108.8, c: 109.8 },  // wick above, close inside — not confirmation
    { o: 109.8, h: 110.4, l: 110.0, c: 110.3 },
  ])
  assert.equal(computeVaBreakout(bars, '15m', { structure: structure() }), null)
})

test('the breakout candle itself is not an entry — only the pullback is', () => {
  // Confirmation exists but the live bar is still up at the extension, not
  // back at the level.
  const bars = barsWith([
    { o: 109, h: 111.6, l: 108.8, c: 111.5 },
    { o: 111.5, h: 112.4, l: 111.4, c: 112.2 }, // low never returns to 110
  ])
  assert.equal(computeVaBreakout(bars, '15m', { structure: structure() }), null)
})

test('a pullback that closes back INSIDE the area is a failed breakout, not an entry', () => {
  const bars = barsWith([
    { o: 109, h: 111.6, l: 108.8, c: 111.5 },
    { o: 111, h: 111.1, l: 109.4, c: 109.6 },  // closed back through the VAH
  ])
  assert.equal(computeVaBreakout(bars, '15m', { structure: structure() }), null)
})

test('the short mirror: close below VAL, pullback up to it, hold below', () => {
  const bars = barsWith([
    { o: 101, h: 101.2, l: 98.4, c: 98.5 },    // confirming close below 100
    { o: 98.7, h: 99.9, l: 98.6, c: 99.1 },    // pullback to the level, holding
  ])
  const sig = computeVaBreakout(bars, '15m', { structure: structure() })
  assert.ok(sig)
  assert.equal(sig.bias, 'short')
  assert.ok(Math.abs(sig.tp1 - 90) < 1e-9)
  assert.ok(sig.sl > 100, 'stop is back above the VAL')
})

test('a bullish open treats the VAH as support with no separate confirmation needed', () => {
  // Open above value: the open IS the confirmation. Pullback to the VAH holds.
  const bars = barsWith([
    { o: 112, h: 112.5, l: 111.5, c: 112 },
    { o: 111.5, h: 111.6, l: 110.1, c: 111.0 }, // touches 110, closes above
  ])
  const sig = computeVaBreakout(bars, '15m', { structure: structure({ structure: 'bullish', reference: 110, role: 'support' }) })
  assert.ok(sig)
  assert.equal(sig.bias, 'long')
  assert.equal(sig.conviction, 9, 'continuation structure earns the extra conviction point')
})

test('a bearish open treats the VAL as resistance', () => {
  const bars = barsWith([
    { o: 98, h: 98.5, l: 97.5, c: 98 },
    { o: 98.5, h: 99.9, l: 98.4, c: 99.0 },
  ])
  const sig = computeVaBreakout(bars, '15m', { structure: structure({ structure: 'bearish', reference: 100, role: 'resistance' }) })
  assert.ok(sig)
  assert.equal(sig.bias, 'short')
})

test('an entry inside one of yesterday\'s LVNs is refused', () => {
  const s = structure({ lvns: [{ lo: 110.5, hi: 111.5, mid: 111, volume: 10, pctOfPoc: 2 }] })
  // Same canonical bars — the live close (110.9) sits inside the LVN band.
  assert.equal(computeVaBreakout(confirmedPullbackBars(), '15m', { structure: s }), null)
})

test('VPOC migration in the trade direction adds conviction; against it does not', () => {
  const withUp = computeVaBreakout(confirmedPullbackBars(), '15m', {
    structure: structure({ migration: { direction: 'up', drift: 3, driftFraction: 0.3, sessions: 3, monotonic: true } }),
  })
  const withDown = computeVaBreakout(confirmedPullbackBars(), '15m', {
    structure: structure({ migration: { direction: 'down', drift: -3, driftFraction: -0.3, sessions: 3, monotonic: true } }),
  })
  assert.ok(withUp && withDown)
  assert.equal(withUp.conviction, withDown.conviction + 1)
})

test('the confirming close must belong to the CURRENT session', () => {
  // Identical bars, but the structure says the session opened on the live
  // bar — the "confirmation" happened yesterday and proves nothing today.
  const bars = confirmedPullbackBars()
  const lateOpen = structure({ openMs: bars[bars.length - 1].t, sessionBars: 1 })
  assert.equal(computeVaBreakout(bars, '15m', { structure: lateOpen }), null)
})

test('no structure at all (too little history) -> no signal', () => {
  assert.equal(computeVaBreakout(confirmedPullbackBars(), '15m', { structure: null }), null)
})

test('too few bars -> null before any structure work happens', () => {
  assert.equal(computeVaBreakout(confirmedPullbackBars().slice(0, 30), '15m', { structure: structure() }), null)
})
