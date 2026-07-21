// node --test agent/services/pick-best-signal.test.js
//
// Best-conviction strategy selection (owner: "only 3 strategies in use"). The
// scanner used to take the FIRST registry-order strategy that fired (fib), so
// fib monopolised every symbol where it found a fade. pickBestSignal now takes
// the highest-conviction signal across ALL enabled strategies.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pickBestSignal } from './fib-strategy.js'

// Fake strategy fns: each returns a fixed signal (or null) tagged by name.
const strat = (name, conviction) => () => (conviction == null ? null : { strategy: name, conviction })

test('picks the highest-conviction signal, not the first that fires', () => {
  const fns = [strat('fib', 6), strat('rsi2', 9), strat('ema', 7)]
  const best = pickBestSignal(fns, [], '1h', {})
  assert.equal(best.strategy, 'rsi2')
  assert.equal(best.conviction, 9)
})

test('registry order breaks ties (earlier strategy kept)', () => {
  const fns = [strat('fib', 8), strat('rsi2', 8)]
  assert.equal(pickBestSignal(fns, [], '1h', {}).strategy, 'fib')
})

test('skips strategies that produce no signal', () => {
  const fns = [strat('fib', null), strat('rsi2', null), strat('ema', 5)]
  assert.equal(pickBestSignal(fns, [], '1h', {}).strategy, 'ema')
})

test('all silent → null', () => {
  assert.equal(pickBestSignal([strat('fib', null), strat('rsi2', null)], [], '1h', {}), null)
})

test('a lower-conviction fib no longer shadows a stronger rsi2 (the bug)', () => {
  // fib fires first but weakly; rsi2 is stronger → rsi2 must win now.
  const fns = [strat('fib', 4), strat('rsi2', 9)]
  assert.equal(pickBestSignal(fns, [], '8h', {}).strategy, 'rsi2')
})

// Armed-strategy preference (owner: "RSI2/VP armed but 0 trades after 6h ...
// you keep using FIB/EMA"). An ARMED strategy that can actually trade must beat
// a higher-conviction UNARMED one that would only get vetoed.
test('an ARMED strategy wins over a higher-conviction UNARMED one', () => {
  // fib conviction 9 but NOT armed; rsi2 conviction 6 but ARMED → rsi2 wins.
  const fns = [strat('fib', 9), strat('rsi2', 6)]
  const best = pickBestSignal(fns, [], '1h', { armedStrategyKeys: ['rsi2', 'vp_value'] })
  assert.equal(best.strategy, 'rsi2')
})

test('among ARMED strategies, highest conviction still wins', () => {
  const fns = [strat('vp_value', 6), strat('rsi2', 8), strat('fib', 9)]
  const best = pickBestSignal(fns, [], '1h', { armedStrategyKeys: ['rsi2', 'vp_value'] })
  assert.equal(best.strategy, 'rsi2') // 8 > 6, and fib (9) is unarmed so excluded
})

test('no armed set given → pure conviction (backtest/display, no regression)', () => {
  const fns = [strat('fib', 9), strat('rsi2', 6)]
  assert.equal(pickBestSignal(fns, [], '1h', {}).strategy, 'fib')
  assert.equal(pickBestSignal(fns, [], '1h', { armedStrategyKeys: [] }).strategy, 'fib')
})

test('all candidates unarmed → falls back to highest conviction', () => {
  const fns = [strat('fib', 9), strat('ema', 7)]
  const best = pickBestSignal(fns, [], '1h', { armedStrategyKeys: ['rsi2'] })
  assert.equal(best.strategy, 'fib') // neither armed → strongest surfaces (for the scan/display)
})
