// ---------------------------------------------------------------------------
// agent/services/fib-filter-annotate.test.js
//
// Filter annotate mode: with { mode: 'annotate' } a failed confluence filter
// must NOT kill the signal — it records itself in signal.filters_failed so
// the stage matrix's Auto Trade & Open gate can veto the order instead
// ("analyse all convictions regardless of filters during scanning").
// Strict mode (the default, and the only mode the backtest/C++ parity path
// uses) must keep returning null exactly as before.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFibSignal } from './fib-strategy.js'

const HOUR = 3_600_000

// Same shape as fib-strategy-pending.test.js's fixture: decline to a fractal
// low (90), rally to a high (~110.3), shallow retrace. pendingSetup mode
// signals on it without needing a close inside the 61.8% zone.
function buildRetraceBars() {
  const bars = []
  const t0 = Date.UTC(2026, 0, 5)
  const push = (i, p) => bars.push({
    t: t0 + i * HOUR, o: p + 0.1, h: p + 0.3, l: p - 0.4, c: p, v: 100,
  })
  for (let i = 0; i <= 15; i++) push(i, 96.4 - 0.4 * i + 0.4)
  bars[15] = { ...bars[15], l: 90, c: 90.4 }
  for (let i = 16; i <= 30; i++) push(i, 90 + (20 / 15) * (i - 15))
  for (let i = 31; i <= 39; i++) push(i, 110 - 0.5 * (i - 30))
  return bars
}

// longMax: -1 is unsatisfiable for a long bias — the RSI filter always fails.
const IMPOSSIBLE_RSI = { longMax: -1, shortMin: 101 }

test('strict filter (default) still kills the signal', () => {
  const bars = buildRetraceBars()
  const base = computeFibSignal(bars, '1h', { pendingSetup: true })
  assert.ok(base, 'fixture must signal without filters')
  assert.deepEqual(base.filters_failed, [], 'no filters → nothing failed')

  const strict = computeFibSignal(bars, '1h', { pendingSetup: true, rsiFilter: IMPOSSIBLE_RSI })
  assert.equal(strict, null, 'strict mode: failed filter returns null')
})

test('annotate mode keeps the signal and records the failure', () => {
  const bars = buildRetraceBars()
  const sig = computeFibSignal(bars, '1h', {
    pendingSetup: true,
    rsiFilter: { ...IMPOSSIBLE_RSI, mode: 'annotate' },
  })
  assert.ok(sig, 'annotate mode: signal survives the failed filter')
  assert.deepEqual(sig.filters_failed, ['rsi'])
  assert.match(sig.thesis, /Filters failed: RSI/)
})

test('annotate mode with a PASSING filter records nothing', () => {
  const bars = buildRetraceBars()
  // longMax 101 always passes for a long bias
  const sig = computeFibSignal(bars, '1h', {
    pendingSetup: true,
    rsiFilter: { longMax: 101, shortMin: -1, mode: 'annotate' },
  })
  assert.ok(sig)
  assert.deepEqual(sig.filters_failed, [])
  assert.doesNotMatch(sig.thesis, /Filters failed/)
})

test('multiple annotate filters accumulate in filters_failed', () => {
  const bars = buildRetraceBars()
  // VWAP: last close (~105.5) is far ABOVE the leg-anchored VWAP → long fails.
  // FVG: monotone synthetic bars have no qualifying gap in the zone → fails.
  const sig = computeFibSignal(bars, '1h', {
    pendingSetup: true,
    rsiFilter: { ...IMPOSSIBLE_RSI, mode: 'annotate' },
    vwapFilter: { mode: 'annotate' },
    fvgFilter: { mode: 'annotate' },
  })
  assert.ok(sig, 'signal survives all annotated failures')
  assert.ok(sig.filters_failed.includes('rsi'))
  assert.ok(sig.filters_failed.length >= 2, `expected ≥2 failures, got ${JSON.stringify(sig.filters_failed)}`)
})
