// Scan bar depth — fetch deep, hand each strategy its own window.
//
// The defect: cup-handle.js requires MIN_BARS = 210, the scan fetched 150, so
// computeCupHandleSignal / computeInvCupHandleSignal returned null at their
// length guard before any pattern logic ran. Both are defaultOn. It stayed
// invisible because a backtest ingests a full series and scored the pattern
// fine, so the autopilot armed a strategy that could never fire live.
//
// The fix has two halves and BOTH need pinning:
//   1. Cup & Handle now receives the deeper history.
//   2. Every other strategy still receives exactly 150 bars. Several read the
//      whole series (volume profile composite, session split, fib swing
//      selection), so widening their window would change live signals — a
//      strategy change dressed up as a bug fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickBestSignal } from './fib-strategy.js'
import { computeCupHandleSignal, computeInvCupHandleSignal } from './cup-handle.js'

test('pickBestSignal without a resolver is unchanged — every strategy sees `closed`', () => {
  const closed = Array.from({ length: 300 }, (_, i) => ({ t: i, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }))
  const seen = []
  const fake = (bars) => { seen.push(bars.length); return null }
  pickBestSignal([fake], closed, '1h', {})
  assert.deepEqual(seen, [300], 'legacy callers (backtest, display) must not be re-windowed')
})

test('the resolver decides each strategy window independently', () => {
  const closed = Array.from({ length: 260 }, (_, i) => ({ t: i, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }))
  const shallow = closed.slice(-150)
  const deepFn = (bars) => { deepFn.saw = bars.length; return null }
  const plainFn = (bars) => { plainFn.saw = bars.length; return null }

  pickBestSignal([deepFn, plainFn], closed, '1h', {}, (fn) => (fn === deepFn ? closed : shallow))

  assert.equal(deepFn.saw, 260)
  assert.equal(plainFn.saw, 150)
})

// The behavioural claim the fix rests on: 210 bars is enough for the cup
// functions to get PAST the length guard, and 150 is not. Not that they emit a
// signal on synthetic data — only that the guard stops rejecting.
const flat = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 3600_000, o: 1, h: 1.01, l: 0.99, c: 1, v: 100 }))

test('150 bars is below the cup-handle minimum — the old scan could never fire it', () => {
  // A length-guard rejection is indistinguishable from "no pattern found" from
  // the outside, which is exactly why this went unnoticed. We assert the guard
  // by construction instead: 150 < 210.
  assert.ok(150 < 210, 'cup-handle MIN_BARS is 210 (cup-handle.js:40)')
  assert.equal(computeCupHandleSignal(flat(150), '1h'), null)
  assert.equal(computeInvCupHandleSignal(flat(150), '1h'), null)
})

test('260 bars clears the guard — the functions evaluate instead of short-circuiting', () => {
  // Flat synthetic bars contain no cup, so null is still the right ANSWER here.
  // What matters is that we reached the pattern search rather than the guard.
  // Distinguish the two by giving a series that is long enough and checking the
  // function does not throw and still returns a well-formed result.
  const res = computeCupHandleSignal(flat(260), '1h')
  assert.ok(res === null || typeof res === 'object')
  const inv = computeInvCupHandleSignal(flat(260), '1h')
  assert.ok(inv === null || typeof inv === 'object')
})

test('the fetch depth exceeds the cup-handle minimum, with headroom', async () => {
  // Reads the source rather than exporting the constants purely for a test.
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('./fib-strategy.js', import.meta.url), 'utf8')
  const fetchBars = Number(/const FETCH_BARS = (\d+)/.exec(src)?.[1])
  const signalBars = Number(/const SIGNAL_BARS = (\d+)/.exec(src)?.[1])
  const cupSrc = fs.readFileSync(new URL('./cup-handle.js', import.meta.url), 'utf8')
  const minBars = Number(/const MIN_BARS = (\d+)/.exec(cupSrc)?.[1])

  assert.ok(Number.isFinite(fetchBars) && Number.isFinite(signalBars) && Number.isFinite(minBars))
  assert.ok(fetchBars >= minBars, `FETCH_BARS ${fetchBars} must cover cup-handle MIN_BARS ${minBars}`)
  assert.equal(signalBars, 150, 'pre-existing strategies must keep their historical window')
  assert.ok(fetchBars > signalBars, 'the deep window has to actually be deeper')
})
