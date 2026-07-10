// ---------------------------------------------------------------------------
// agent/services/fib-strategy-pending.test.js
//
// Pending-order mode coverage. computeFibSignal's pendingSetup flag is the
// core behavioural difference the pending-order feature hangs off: a
// confirmed swing whose retrace is NEAR (but not inside) the 61.8% zone must
// yield a resting-order signal at the level, while normal mode — which
// requires a close IN the zone — must stay null. scanPendingSetups' network
// path needs a live WS, so only its socket-free branches (unknown symbol,
// empty matrix) are tested here.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFibSignal, atr, scanPendingSetups } from './fib-strategy.js'

const HOUR = 3_600_000

// 40 bars: monotone decline to a fractal LOW at idx 15 (l=90), monotone
// rally to a fractal HIGH at idx 30 (h≈110.3), then a shallow monotone
// retrace ending well ABOVE the 61.8% zone (~97.75 ± ~1.0) — near it in
// fade terms, but a full zone-width away so normal mode rejects it.
// Small per-bar ranges keep ATR(14)≈1.4 so the ~20-point leg clears the
// MIN_LEG_ATR_MULT=3 significance floor by a wide margin.
function buildRetraceBars() {
  const bars = []
  const t0 = Date.UTC(2026, 0, 5)
  const push = (i, p) => bars.push({
    t: t0 + i * HOUR, o: p + 0.1, h: p + 0.3, l: p - 0.4, c: p, v: 100,
  })
  for (let i = 0; i <= 15; i++) push(i, 96.4 - 0.4 * i + 0.4)      // decline into the low
  bars[15] = { ...bars[15], l: 90, c: 90.4 }                        // swing low anchor
  for (let i = 16; i <= 30; i++) push(i, 90 + (20 / 15) * (i - 15)) // rally to the high
  for (let i = 31; i <= 39; i++) push(i, 110 - 0.5 * (i - 30))      // retrace, still far from zone
  return bars
}

test('pendingSetup yields a resting-order signal at the 61.8% level where normal mode is null', () => {
  const bars = buildRetraceBars()

  // Sanity: the leg really is significant vs volatility.
  const range = 110.3 - 90
  assert.ok(range > 3 * atr(bars), 'leg must exceed 3×ATR')

  const normal = computeFibSignal(bars, '1h', {})
  assert.equal(normal, null, 'normal mode requires a close inside the zone')

  const pending = computeFibSignal(bars, '1h', { pendingSetup: true })
  assert.ok(pending, 'pending mode signals as soon as the swing confirms')
  assert.equal(pending.bias, 'long')
  assert.equal(pending.swingA, 90)
  assert.ok(Math.abs(pending.swingB - 110.3) < 1e-9)

  // The resting order sits AT the level: entry === level618 (level618 is
  // rounded to 5dp for display; entry carries full precision).
  const expected618 = pending.swingB - 0.618 * (pending.swingB - pending.swingA)
  assert.ok(Math.abs(pending.entry - expected618) < 1e-9, 'entry is the raw 61.8% level')
  assert.ok(Math.abs(pending.entry - pending.level618) < 1e-5, 'entry matches reported level618')

  // Fixed conviction 8 — proximity scoring is meaningless for a resting order.
  assert.equal(pending.conviction, 8)
  assert.equal(pending.strategy, 'fib_618_fade')
  assert.ok(pending.sl < pending.swingA, 'long SL sits below the swing origin')
  assert.equal(pending.tp1, pending.swingB)
})

test('pendingSetup still rejects an invalidated leg', () => {
  const bars = buildRetraceBars()
  // Force the last close past the swing origin — the fade thesis is dead,
  // pending mode must not park an order on it.
  bars[bars.length - 1] = { ...bars[bars.length - 1], c: 88, l: 87.6 }
  assert.equal(computeFibSignal(bars, '1h', { pendingSetup: true }), null)
})

test('scanPendingSetups collects errors for unknown symbols without touching the network', async () => {
  const creds = { host: 'x', clientId: 'x', clientSecret: 'x', accessToken: 'x', accountId: 1 }
  const out = await scanPendingSetups(creds, {}, { GHOSTUSD: ['1h'] })
  assert.deepEqual(out.setups, [])
  assert.deepEqual(out.lastClose, {})
  assert.equal(out.errors.length, 1)
  assert.match(out.errors[0], /GHOSTUSD: symbolId unknown/)
})

test('scanPendingSetups is a no-op on an empty or TF-less matrix', async () => {
  const creds = { host: 'x', clientId: 'x', clientSecret: 'x', accessToken: 'x', accountId: 1 }
  assert.deepEqual(await scanPendingSetups(creds, {}, {}), { setups: [], lastClose: {}, errors: [] })
  // Armed symbol but no valid timeframes -> skipped before any fetch.
  assert.deepEqual(
    await scanPendingSetups(creds, { EURUSD: 1 }, { EURUSD: [] }),
    { setups: [], lastClose: {}, errors: [] },
  )
})
