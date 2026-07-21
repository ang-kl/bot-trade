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
