// node --test agent/services/cup-handle.test.js
// Synthetic-bar tests for the Cup & Handle detector and the screener.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCupHandleSignal, computeInvCupHandleSignal, screenBars, sma, traceCupHandleSearch, traceInvCupHandleSearch } from './cup-handle.js'

const HOUR = 3_600_000
const bar = (i, o, h, l, c, v) => ({ t: i * HOUR, o, h, l, c, v })

/**
 * Build a textbook cup & handle ending in a volume breakout:
 * long uptrend (SMA support) → left rim → rounded sell-off → flat bottom →
 * recovery → tight shallow handle → breakout bar.
 */
function cupHandleBars() {
  const bars = []
  let i = 0
  let p = 50
  // 185 bars of gentle uptrend to 100 — keeps price above all SMAs and
  // leaves >=210 total bars so SMA200 exists at the breakout.
  for (; i < 185; i++) { p += 50 / 185; bars.push(bar(i, p - 0.1, p + 0.3, p - 0.4, p, 1000)) }
  // decline to ~76 over 12 bars, volume high early — depth ~21.3% of rim,
  // comfortably inside DEPTH_MIN/MAX (15-33%, owner-confirmed 2026-07-22)
  for (let k = 0; k < 12; k++, i++) { p -= 2.0; bars.push(bar(i, p + 2.0, p + 2.2, p - 0.3, p, 1600 - k * 60)) }
  // rounded bottom: 8 bars flat at ~76, dry volume
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.4, p - 0.25, p + 0.1, 500)) }
  // recovery to ~100 over 12 bars, volume rebuilding
  for (let k = 0; k < 12; k++, i++) { p += 2.0; bars.push(bar(i, p - 2.0, p + 0.4, p - 2.1, p, 1200 + k * 40)) }
  // tight handle: 5 bars drifting to ~97.5, low volume
  for (let k = 0; k < 5; k++, i++) { const hp = p - 0.5 * (k + 1) / 2; bars.push(bar(i, hp + 0.2, hp + 0.5, hp - 0.3, hp, 600)) }
  // breakout bar: closes above rim + prior-2 highs on 2× handle volume
  bars.push(bar(i, p - 1, p + 2.2, p - 1.2, p + 2, 1400))
  return bars
}

test('detects a textbook cup & handle breakout', () => {
  const sig = computeCupHandleSignal(cupHandleBars(), '1d')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.strategy, 'cup_handle')
  assert.equal(sig.bias, 'long')
  assert.ok(sig.conviction >= 8, `conviction ${sig.conviction} should reach the autotrade bar`)
  assert.ok(sig.rr >= 1.5)
  assert.ok(sig.tp1 > sig.entry && sig.sl < sig.entry)
})

test('no signal without a breakout bar (handle still forming)', () => {
  const bars = cupHandleBars()
  bars.pop() // remove the breakout
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
})

test('no signal in a downtrend (below SMAs)', () => {
  const bars = []
  let p = 200
  for (let i = 0; i < 260; i++) { p -= 0.3; bars.push(bar(i, p + 0.3, p + 0.5, p - 0.2, p, 1000)) }
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
})

test('too few bars → null (SMA200 undefined)', () => {
  assert.equal(computeCupHandleSignal(cupHandleBars().slice(-100), '1d'), null)
})

test('sma helper', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ c: i + 1 }))
  assert.equal(sma(bars, 20), 10.5)
  assert.equal(sma(bars, 21), null)
})

test('traceCupHandleSearch: a firing setup reports cup_found with blocked_at null', () => {
  const t = traceCupHandleSearch(cupHandleBars(), '1d')
  assert.equal(t.uptrend_ok, true)
  assert.equal(t.cup_found, true)
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, null)
  assert.ok(t.best_candidate.rrRatio >= 1.5)
})

test('traceCupHandleSearch: handle still forming reports the real blocking gate, not a signal', () => {
  const bars = cupHandleBars()
  bars.pop() // remove the breakout bar — same setup as the "no signal" test above
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
  const t = traceCupHandleSearch(bars, '1d')
  assert.equal(t.uptrend_ok, true)
  assert.equal(t.cup_found, true, 'a valid cup structure was found — just no breakout yet')
  assert.ok(t.best_candidate, 'a near-miss candidate should still be reported')
  assert.equal(t.best_candidate.blocked_at, 'breakout_not_triggered')
})

test('traceCupHandleSearch: downtrend reports uptrend_ok false with no candidate search', () => {
  const bars = []
  let p = 200
  for (let i = 0; i < 260; i++) { p -= 0.3; bars.push(bar(i, p + 0.3, p + 0.5, p - 0.2, p, 1000)) }
  const t = traceCupHandleSearch(bars, '1d')
  assert.equal(t.uptrend_ok, false)
  assert.equal(t.cup_found, false)
  assert.equal(t.best_candidate, null)
})

test('traceCupHandleSearch: too few bars is honest, not a crash', () => {
  const t = traceCupHandleSearch(cupHandleBars().slice(-100), '1d')
  assert.equal(t.uptrend_ok, false)
  assert.equal(t.best_candidate, null)
})

/**
 * Build a textbook INVERTED cup & handle ending in a volume breakdown —
 * the bearish mirror of cupHandleBars(): long downtrend (below all SMAs)
 * → left rim → rounded rally into a dome top → decline forms the right
 * rim → tight handle drifting up (lower third) → breakdown bar.
 */
function invCupHandleBars() {
  const bars = []
  let i = 0
  let p = 150
  // 185 bars of gentle downtrend to ~100 — keeps price below all SMAs
  for (; i < 185; i++) { p -= 50 / 185; bars.push(bar(i, p + 0.1, p + 0.4, p - 0.3, p, 1000)) }
  // rally to ~126 over 12 bars — forms the dome's left rim to top,
  // depth ~16.7% of rim, comfortably inside DEPTH_MIN/MAX (15-33%)
  for (let k = 0; k < 12; k++, i++) { p += 2.2; bars.push(bar(i, p - 2.2, p + 0.3, p - 2.4, p, 1600 - k * 60)) }
  // rounded top: 8 bars flat near the high, dry volume
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.25, p - 0.4, p - 0.1, 500)) }
  // decline over 12 bars — forms the dome's right rim
  for (let k = 0; k < 12; k++, i++) { p -= 2.2; bars.push(bar(i, p + 2.2, p + 2.3, p - 0.4, p, 1200 + k * 40)) }
  // tight handle: 5 bars drifting up slightly (lower third), low volume
  for (let k = 0; k < 5; k++, i++) { const hp = p + 0.5 * (k + 1) / 2; bars.push(bar(i, hp - 0.2, hp + 0.3, hp - 0.5, hp, 600)) }
  // breakdown bar: closes below prior lows + handle low on 2× handle volume
  bars.push(bar(i, p + 1, p + 1.2, p - 2.2, p - 2, 1400))
  return bars
}

test('detects a textbook INVERTED cup & handle breakdown', () => {
  const sig = computeInvCupHandleSignal(invCupHandleBars(), '1d')
  assert.ok(sig, 'expected a signal')
  assert.equal(sig.strategy, 'inv_cup_handle')
  assert.equal(sig.bias, 'short')
  assert.equal(sig.cup.shape, 'inverted_cup')
  assert.ok(sig.conviction >= 8, `conviction ${sig.conviction} should reach the autotrade bar`)
  assert.ok(sig.rr >= 1.5)
  assert.ok(sig.tp1 < sig.entry && sig.sl > sig.entry, 'short: target below entry, stop above entry')
})

test('inverted: no signal without a breakdown bar (handle still forming)', () => {
  const bars = invCupHandleBars()
  bars.pop() // remove the breakdown
  assert.equal(computeInvCupHandleSignal(bars, '1d'), null)
})

test('inverted: no signal in an uptrend (above SMAs) — classic and inverted are mutually exclusive', () => {
  assert.equal(computeInvCupHandleSignal(cupHandleBars(), '1d'), null)
  // and the reverse: the classic (bullish) search must not fire on
  // inverted-pattern bars either — one context can't satisfy both trend
  // gates at once.
  assert.equal(computeCupHandleSignal(invCupHandleBars(), '1d'), null)
})

test('inverted: too few bars → null (SMA200 undefined)', () => {
  assert.equal(computeInvCupHandleSignal(invCupHandleBars().slice(-100), '1d'), null)
})

test('traceInvCupHandleSearch: a firing setup reports cup_found with blocked_at null', () => {
  const t = traceInvCupHandleSearch(invCupHandleBars(), '1d')
  assert.equal(t.bias, 'short')
  assert.equal(t.uptrend_ok, true, 'required trend context (downtrend, for this direction) holds')
  assert.equal(t.cup_found, true)
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, null)
  assert.ok(t.best_candidate.rrRatio >= 1.5)
})

test('traceInvCupHandleSearch: handle still forming reports the real blocking gate, not a signal', () => {
  const bars = invCupHandleBars()
  bars.pop()
  assert.equal(computeInvCupHandleSignal(bars, '1d'), null)
  const t = traceInvCupHandleSearch(bars, '1d')
  assert.equal(t.cup_found, true, 'a valid dome structure was found — just no breakdown yet')
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, 'breakout_not_triggered')
})

test('traceInvCupHandleSearch: uptrend context reports uptrend_ok false with no candidate search', () => {
  const t = traceInvCupHandleSearch(cupHandleBars(), '1d')
  assert.equal(t.uptrend_ok, false)
  assert.equal(t.cup_found, false)
  assert.equal(t.best_candidate, null)
})

test('traceCupHandleSearch (classic) is unaffected by inverted-context bars — reports uptrend_ok false', () => {
  const t = traceCupHandleSearch(invCupHandleBars(), '1d')
  assert.equal(t.bias, 'long')
  assert.equal(t.uptrend_ok, false)
})

/**
 * Same shape as cupHandleBars() but with a configurable handle bar count
 * and handle volume, so the two new dynamic handle gates (length ratio,
 * volume contraction) can be exercised directly (owner-directed
 * 2026-07-22 handle-validation audit).
 */
function cupHandleBarsWithHandle(handleBars, handleVol) {
  const bars = []
  let i = 0
  let p = 50
  for (; i < 185; i++) { p += 50 / 185; bars.push(bar(i, p - 0.1, p + 0.3, p - 0.4, p, 1000)) }
  for (let k = 0; k < 12; k++, i++) { p -= 2.0; bars.push(bar(i, p + 2.0, p + 2.2, p - 0.3, p, 1600 - k * 60)) }
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.4, p - 0.25, p + 0.1, 500)) }
  for (let k = 0; k < 12; k++, i++) { p += 2.0; bars.push(bar(i, p - 2.0, p + 0.4, p - 2.1, p, 1200 + k * 40)) }
  for (let k = 0; k < handleBars; k++, i++) { const hp = p - 0.5 * (k + 1) / 2; bars.push(bar(i, hp + 0.2, hp + 0.5, hp - 0.3, hp, handleVol)) }
  bars.push(bar(i, p - 1, p + 2.2, p - 1.2, p + 2, 1400))
  return bars
}

test('handle_length_ratio: a handle far shorter than 10% of the cup is rejected, not just under-length', () => {
  const bars = cupHandleBarsWithHandle(1, 600)
  assert.equal(computeCupHandleSignal(bars, '1d'), null)
  const t = traceCupHandleSearch(bars, '1d')
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, 'handle_length_ratio')
})

test('handle_length_ratio: a proportionally long-enough handle fires', () => {
  const bars = cupHandleBarsWithHandle(2, 600)
  const sig = computeCupHandleSignal(bars, '1d')
  assert.ok(sig, 'expected a signal once the handle is >=10% of the cup duration')
  const t = traceCupHandleSearch(bars, '1d')
  assert.equal(t.best_candidate.blocked_at, null)
})

test('handle_volume: a handle as loud as the advance leg is rejected even with valid geometry', () => {
  const loud = cupHandleBarsWithHandle(4, 2000)
  assert.equal(computeCupHandleSignal(loud, '1d'), null)
  const t = traceCupHandleSearch(loud, '1d')
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, 'handle_volume')
})

test('handle_volume: a quiet handle (below the advance leg volume) fires', () => {
  const quiet = cupHandleBarsWithHandle(4, 600)
  const sig = computeCupHandleSignal(quiet, '1d')
  assert.ok(sig, 'expected a signal with a properly contracted handle')
})

/** Same idea as cupHandleBarsWithHandle() but for the inverted direction. */
function invCupHandleBarsWithHandle(handleBars, handleVol) {
  const bars = []
  let i = 0
  let p = 150
  for (; i < 185; i++) { p -= 50 / 185; bars.push(bar(i, p + 0.1, p + 0.4, p - 0.3, p, 1000)) }
  for (let k = 0; k < 12; k++, i++) { p += 2.2; bars.push(bar(i, p - 2.2, p + 0.3, p - 2.4, p, 1600 - k * 60)) }
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.25, p - 0.4, p - 0.1, 500)) }
  for (let k = 0; k < 12; k++, i++) { p -= 2.2; bars.push(bar(i, p + 2.2, p + 2.3, p - 0.4, p, 1200 + k * 40)) }
  for (let k = 0; k < handleBars; k++, i++) { const hp = p + 0.5 * (k + 1) / 2; bars.push(bar(i, hp - 0.2, hp + 0.3, hp - 0.5, hp, handleVol)) }
  bars.push(bar(i, p + 1, p + 1.2, p - 2.2, p - 2, 1400))
  return bars
}

test('inverted: handle_length_ratio: a handle far shorter than 10% of the cup is rejected', () => {
  const bars = invCupHandleBarsWithHandle(1, 600)
  assert.equal(computeInvCupHandleSignal(bars, '1d'), null)
  const t = traceInvCupHandleSearch(bars, '1d')
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, 'handle_length_ratio')
})

test('inverted: handle_length_ratio: a proportionally long-enough handle fires', () => {
  const bars = invCupHandleBarsWithHandle(2, 600)
  const sig = computeInvCupHandleSignal(bars, '1d')
  assert.ok(sig, 'expected a signal once the handle is >=10% of the cup duration')
  const t = traceInvCupHandleSearch(bars, '1d')
  assert.equal(t.best_candidate.blocked_at, null)
})

test('inverted: handle_volume: a handle as loud as the decline leg is rejected even with valid geometry', () => {
  const loud = invCupHandleBarsWithHandle(4, 2000)
  assert.equal(computeInvCupHandleSignal(loud, '1d'), null)
  const t = traceInvCupHandleSearch(loud, '1d')
  assert.ok(t.best_candidate)
  assert.equal(t.best_candidate.blocked_at, 'handle_volume')
})

test('inverted: handle_volume: a quiet handle (below the decline leg volume) fires', () => {
  const quiet = invCupHandleBarsWithHandle(4, 600)
  const sig = computeInvCupHandleSignal(quiet, '1d')
  assert.ok(sig, 'expected a signal with a properly contracted handle')
})

test('screenBars: passes a strong uptrend, fails the checks it should', () => {
  const good = cupHandleBars()
  const res = screenBars(good, { minPrice: 20 })
  assert.equal(res.pass, true)
  assert.ok(res.relVol > 1)

  const cheap = screenBars(good, { minPrice: 1000 })
  assert.equal(cheap.pass, false)
  assert.match(cheap.checks.find(c => !c.ok).text, /price/)

  const short = screenBars(good.slice(-50), {})
  assert.equal(short.pass, false)
})
