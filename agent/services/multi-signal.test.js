// node --test agent/services/multi-signal.test.js
//
// BREAKING THE WINNER-TAKE-ALL (owner-approved, 05-08-2026).
//
// The scanner returned ONE signal per symbol — the conviction winner — and only
// that winner became a `scans` row. Measured over 7 days of production
// diagnostics, cup_handle produced 2,643 setups that cleared every gate it has,
// including the reward:risk floor, and emitted zero signals: each one lost the
// conviction contest to fib_confluence or vwap_trend. With conviction saturated
// at 9-10 across the registry, that contest is close to arbitrary and the same
// two strategies win nearly every time.
//
// The tests below are about the two ways this change could go wrong:
//   1. It stops being a superset — some existing caller's `signal` moves.
//   2. It becomes a free-for-all — a symbol multiplies its own share of the
//      analyze slots by appearing once per strategy, which would recreate the
//      starvation from the other direction.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickAllSignals, pickBestSignal, bestOf, armedPredicate } from './fib-strategy.js'

const strat = (name, conviction) => () => (conviction == null ? null : { strategy: name, conviction })

test('pickAllSignals returns EVERY candidate, not just the winner', () => {
  const fns = [strat('fib', 6), strat('cup_handle', 5), strat('vwap', 9)]
  const all = pickAllSignals(fns, [], '1h', {})
  assert.deepEqual(all.map(c => c.strategy), ['fib', 'cup_handle', 'vwap'])
})

test('a strategy that fires is never dropped for firing weakly', () => {
  // THE WHOLE POINT. cup_handle at conviction 5 alongside vwap at 10 used to
  // vanish — not vetoed, not logged, not written. Simply gone before anything
  // could judge it.
  const all = pickAllSignals([strat('vwap', 10), strat('cup_handle', 5)], [], '1h', {})
  assert.ok(all.some(c => c.strategy === 'cup_handle'))
})

test('non-firing strategies still produce nothing', () => {
  assert.deepEqual(pickAllSignals([strat('fib', null), strat('cup_handle', null)], [], '1h', {}), [])
})

test('bestOf reproduces pickBestSignal exactly — one ranking, not two', () => {
  // If these ever disagree, `signal` and `signals[0]` would name different
  // strategies for the same symbol and every downstream report would be
  // internally inconsistent.
  const cases = [
    [strat('fib', 6), strat('rsi2', 9), strat('ema', 7)],
    [strat('fib', 9), strat('rsi2', 9)],
    [strat('fib', null), strat('rsi2', 3)],
    [strat('fib', null), strat('rsi2', null)],
  ]
  for (const fns of cases) {
    for (const opts of [{}, { armedStrategyKeys: ['rsi2'] }, { armedStrategyKeys: [] }]) {
      const viaPick = pickBestSignal(fns, [], '1h', opts)
      const viaAll = bestOf(pickAllSignals(fns, [], '1h', opts), armedPredicate(opts))
      assert.deepEqual(viaAll, viaPick)
    }
  }
})

test('armed still beats unarmed in the shared ranking', () => {
  // The rule that fixed "RSI-2 and VP sat at 0 trades for hours" must survive
  // this change — an unarmed winner can only be vetoed at the trade gate.
  const fns = [strat('fib', 10), strat('rsi2', 4)]
  const opts = { armedStrategyKeys: ['rsi2'] }
  assert.equal(bestOf(pickAllSignals(fns, [], '1h', opts), armedPredicate(opts)).strategy, 'rsi2')
})

test('an empty or absent armed set means pure conviction, unchanged', () => {
  for (const opts of [{}, { armedStrategyKeys: [] }, { armedStrategyKeys: new Set() }]) {
    const best = bestOf(pickAllSignals([strat('fib', 10), strat('rsi2', 4)], [], '1h', opts), armedPredicate(opts))
    assert.equal(best.strategy, 'fib')
  }
})

test('bestOf tolerates holes and empties rather than throwing mid-scan', () => {
  assert.equal(bestOf([]), null)
  assert.equal(bestOf(null), null)
  assert.equal(bestOf([null, undefined]), null)
  assert.equal(bestOf([null, { strategy: 'a', conviction: 1 }]).strategy, 'a')
})

// ---------------------------------------------------------------------------
// The fan-out shape runFibScan builds. Reproduced here rather than exercised
// through runFibScan, which needs a broker connection — what matters is the
// invariant, and the invariant is arithmetic.
// ---------------------------------------------------------------------------

const uniq = (xs) => [...new Set(xs)]

test('rows fan out per strategy while symbol lists stay one entry per symbol', () => {
  const results = [
    { symbol: 'EURUSD', signals: [{ strategy: 'fib', conviction: 9 }, { strategy: 'cup_handle', conviction: 8 }] },
    { symbol: 'GBPUSD', signals: [{ strategy: 'vwap', conviction: 7 }] },
    { symbol: 'USDJPY', signals: [] },
  ]
  const scans = results.flatMap(r => (r.signals.length
    ? [...r.signals].sort((a, b) => b.conviction - a.conviction).map(s => ({ symbol: r.symbol, strategy: s.strategy, confidence: s.conviction, bias: 'long' }))
    : [{ symbol: r.symbol, strategy: null, confidence: 0, bias: 'skip' }]))

  assert.equal(scans.length, 4, 'three symbols, four strategy rows')
  assert.equal(uniq(scans.map(s => s.symbol)).length, 3, 'coverage still counts SYMBOLS')
  // The skip row survives — the monitor phase resolves open-position prices
  // from these rows and a symbol silently vanishing would break that.
  assert.ok(scans.some(s => s.symbol === 'USDJPY' && s.bias === 'skip'))

  const hot = uniq(scans.filter(s => s.confidence >= 6 && s.bias !== 'skip').map(s => s.symbol))
  assert.deepEqual(hot, ['EURUSD', 'GBPUSD'], 'EURUSD appears ONCE despite two qualifying strategies')
})

test('signalsByStrategy addresses a specific strategy, signals keeps the winner', () => {
  const results = [{
    symbol: 'EURUSD',
    signal: { strategy: 'fib', conviction: 9 },
    signals: [{ strategy: 'fib', conviction: 9 }, { strategy: 'cup_handle', conviction: 5 }],
  }]
  const signals = {}
  const signalsByStrategy = {}
  for (const r of results) {
    if (r.signal) signals[r.symbol] = r.signal
    for (const sig of r.signals || []) (signalsByStrategy[r.symbol] ||= {})[sig.strategy] = sig
  }
  // Existing callers see exactly what they always saw…
  assert.equal(signals.EURUSD.strategy, 'fib')
  // …and a fair-share slot granted to cup_handle can now dispatch cup_handle,
  // which was the missing half: the allocator picked the symbol FOR a strategy
  // and dispatch then handed over the conviction winner anyway.
  assert.equal(signalsByStrategy.EURUSD.cup_handle.conviction, 5)
})
