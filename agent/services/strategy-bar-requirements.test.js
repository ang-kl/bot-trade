// The permanent guard against the "armed but structurally cannot fire" bug.
//
// Twice now, a defaultOn strategy has been armed, backtested well, and been
// unable to produce a single live signal because its own length guard exceeded
// what the scan fetched:
//
//   cup_handle / inv_cup_handle  need 210, scan fetched 150
//   ema_pullback                 needs 450, scan fetched 150 — and was STILL
//                                starved after the first fix raised it to 260
//
// Both backtest fine, because a backtest ingests a full series. So the autopilot
// arms them on backtest evidence, and live they are silent — and a length-guard
// rejection is indistinguishable from "no setup today" from outside.
//
// This file makes the class impossible to reintroduce. The first test is the
// important one: it reads the ACTUAL MIN_BARS constant out of each strategy
// module and fails if the registry's declared `minBars` drifts from it. Adding a
// strategy whose requirement is not declared, or bumping a MIN_BARS without
// telling the registry, fails here rather than silently in production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  STRATEGY_REGISTRY, minBarsFor, fetchDepthFor, windowFor,
} from './strategies.js'

// Where each strategy's own length guard actually lives. Computed constants are
// resolved by hand with the arithmetic shown, so a change to the parts fails the
// comparison rather than passing silently.
const SOURCE_OF_TRUTH = {
  fib_618_fade: { file: 'fib-strategy.js', note: 'FRACTAL_WIDTH * 2 + 10 = 14', expect: 14 },
  cup_handle: { file: 'cup-handle.js', const: 'MIN_BARS' },
  inv_cup_handle: { file: 'cup-handle.js', const: 'MIN_BARS' },
  ema_pullback: { file: 'ema-pullback.js', const: 'MIN_BARS' },
  donchian_breakout: { file: 'donchian-breakout.js', const: 'MIN_BARS' },
  rsi_meanrev: { file: 'rsi-meanrev.js', const: 'MIN_BARS' },
  vwap_trend: { file: 'vwap-trend.js', const: 'MIN_BARS' },
  vp_value: { file: 'vp-value.js', const: 'MIN_BARS' },
  rsi2_reversion: { file: 'rsi2-reversion.js', note: 'TREND_PERIOD + RSI_PERIOD + 2 = 104', expect: 104 },
  fib_confluence: { file: 'fib-confluence.js', const: 'MIN_BARS' },
  va_breakout: { file: 'va-breakout.js', const: 'MIN_BARS' },
}

const readConst = (file, name) => {
  const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  const m = new RegExp(`const ${name} = (\\d+)`).exec(src)
  return m ? Number(m[1]) : null
}

test('every registry strategy declares minBars, and it matches the module', () => {
  for (const s of STRATEGY_REGISTRY) {
    assert.ok(Number.isFinite(s.minBars), `${s.key} has no declared minBars`)

    const truth = SOURCE_OF_TRUTH[s.key]
    assert.ok(truth, `${s.key} is not covered by this guard — add it to SOURCE_OF_TRUTH`)

    const actual = truth.const ? readConst(truth.file, truth.const) : truth.expect
    assert.equal(
      s.minBars, actual,
      `${s.key}: registry says ${s.minBars}, ${truth.file} says ${actual}` +
      (truth.note ? ` (${truth.note})` : ''),
    )
  }
})

test('the guard covers every strategy — a new one cannot slip in undeclared', () => {
  const declared = new Set(Object.keys(SOURCE_OF_TRUTH))
  for (const s of STRATEGY_REGISTRY) assert.ok(declared.has(s.key), `${s.key} missing from SOURCE_OF_TRUTH`)
  assert.equal(declared.size, STRATEGY_REGISTRY.length, 'SOURCE_OF_TRUTH has stale entries')
})

test('the scan fetches deep enough for the deepest ARMED strategy', () => {
  const all = STRATEGY_REGISTRY.map(s => s.compute)
  const deepest = Math.max(...STRATEGY_REGISTRY.map(s => s.minBars))
  assert.equal(fetchDepthFor(all, 150), deepest)
  // The historical failure, stated as an assertion: a fixed depth is never
  // enough on its own.
  assert.ok(deepest > 260, `deepest requirement is ${deepest} — the old fixed 260 could not satisfy it`)
})

test('depth collapses to the floor when the deep strategies are disarmed', () => {
  // Cost is only paid when it buys something: with only shallow strategies
  // armed, the scan fetches exactly what it always did.
  const shallow = STRATEGY_REGISTRY.filter(s => s.minBars <= 150).map(s => s.compute)
  assert.equal(fetchDepthFor(shallow, 150), 150)
  assert.equal(fetchDepthFor([], 150), 150)
})

test('the requirement is stamped on the compute function itself (no import cycle)', () => {
  // fib-strategy.js reads fn.minBars during a scan. It cannot import
  // strategies.js — strategies.js imports computeFibSignal FROM fib-strategy.js,
  // so the edge would be a cycle. If this stamping is ever removed, the scan
  // silently falls back to the 150 floor for everything and both deep
  // strategies go dark again, with no error anywhere.
  for (const s of STRATEGY_REGISTRY) {
    assert.equal(s.compute.minBars, s.minBars, `${s.key}: compute fn is not stamped`)
  }
  // And the scan's own derivation (max over armed fns) must agree.
  const derived = STRATEGY_REGISTRY.reduce(
    (deepest, s) => Math.max(deepest, Number(s.compute?.minBars) || 0), 150)
  assert.equal(derived, Math.max(...STRATEGY_REGISTRY.map(s => s.minBars)))
})

test('each strategy sees its own window — never less than the floor', () => {
  for (const s of STRATEGY_REGISTRY) {
    const w = windowFor(s.compute, 150)
    assert.ok(w >= 150, `${s.key} window ${w} dropped below the floor`)
    assert.ok(w >= s.minBars, `${s.key} window ${w} is short of its ${s.minBars}-bar requirement`)
    // A shallow strategy must not be silently widened — that would change the
    // window it was tuned on.
    if (s.minBars <= 150) assert.equal(w, 150, `${s.key} was widened past its tuned window`)
  }
})

test('minBarsFor falls back rather than returning undefined for an unknown key', () => {
  assert.equal(minBarsFor('no_such_strategy', 150), 150)
  assert.equal(minBarsFor('ema_pullback'), 450)
})

test('the scan floor still matches what shallow strategies historically saw', () => {
  const src = fs.readFileSync(new URL('./fib-strategy.js', import.meta.url), 'utf8')
  const floor = Number(/const SIGNAL_BARS = (\d+)/.exec(src)?.[1])
  assert.equal(floor, 150, 'changing this silently re-tunes every shallow strategy')
})
