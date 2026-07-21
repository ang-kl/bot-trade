// node --test agent/services/fib-confluence.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeFibConfluence } from './fib-confluence.js'

// Build a bar series with clear swing highs/lows so multiple Fib grids overlap
// near a target price, then park the last bar in that confluence zone.
function bar(t, o, h, l, c, v = 1000) { return { t: t * 60000, o, h, l, c, v } }

// A rising-then-pulling-back structure: two swing lows and two swing highs whose
// 0.5/0.618 retracements stack around ~108–110, then price returns there.
function series() {
  const b = []
  let t = 0
  const push = (h, l, c) => { b.push(bar(t++, c, h, l, c)); }
  // climb to a swing high ~120 with an intermediate low ~100
  const path = [
    [101, 99, 100], [103, 100, 102], [100, 96, 98],   // swing low ~96
    [106, 99, 105], [112, 105, 111], [118, 111, 117],
    [122, 117, 120], [120, 114, 116], [119, 112, 114], // swing high ~122
    [116, 108, 110], [114, 106, 108], [117, 110, 116], // dip toward confluence, bounce
    [119, 112, 118], [121, 116, 120], [118, 110, 112], // another swing high ~121
    [115, 107, 109], [113, 104, 106], [110, 100, 102], // swing low ~100
    [112, 103, 111], [116, 110, 115], [120, 114, 119],
  ]
  for (const [h, l, c] of path) push(h, l, c)
  // Pad to satisfy MIN_BARS with mild noise around 112 (near the confluence)
  for (let i = 0; i < 22; i++) push(114 - (i % 3), 108 - (i % 3), 111 - (i % 3))
  // Final bar sits in the confluence band
  push(113, 108, 110)
  return b
}

test('computeFibConfluence: null on too few bars', () => {
  assert.equal(computeFibConfluence([bar(0, 1, 1, 1, 1)], '1h'), null)
})

test('computeFibConfluence: returns a well-formed signal or null (never throws), with valid geometry', () => {
  const sig = computeFibConfluence(series(), '4h')
  if (sig === null) return // acceptable — no ≥3-level cluster this synthetic run
  assert.ok(sig.bias === 'long' || sig.bias === 'short')
  assert.equal(sig.strategy, 'fib_confluence')
  assert.ok(Number.isFinite(sig.entry) && Number.isFinite(sig.sl) && Number.isFinite(sig.tp1))
  // stop on the correct side of entry, RR at least the floor
  if (sig.bias === 'long') { assert.ok(sig.sl < sig.entry); assert.ok(sig.tp1 > sig.entry) }
  else { assert.ok(sig.sl > sig.entry); assert.ok(sig.tp1 < sig.entry) }
  assert.ok(sig.rr >= 1.5)
  assert.ok(sig.conviction >= 6 && sig.conviction <= 10)
  assert.match(sig.thesis, /confluence/)
})

test('computeFibConfluence: FIRES on a stacked multi-grid confluence zone', () => {
  // 2 swing lows at 100, 2 swing highs at 110 → several retracement levels
  // stack near 105; the final bar sits in that zone. Must produce a signal.
  let t = 0; const b = []
  const B = (h, l, c) => b.push({ t: t++ * 60000, o: c, h, l, c, v: 1000 })
  B(104, 102, 103); B(103, 101, 102); B(102, 100, 101); B(103, 101, 102); B(104, 102, 103)
  B(105, 103, 104); B(103, 101, 102); B(102, 100, 101); B(103, 101, 102); B(106, 104, 105)
  B(107, 105, 106); B(109, 107, 108); B(110, 108, 109); B(109, 107, 108); B(107, 105, 106)
  B(108, 106, 107); B(109, 107, 108); B(110, 108, 109); B(109, 107, 108); B(107, 105, 106)
  for (let i = 0; i < 22; i++) { const j = i % 4; B(106 - (j === 0 ? 0 : 0.3), 104 + (j === 2 ? 0 : 0.2), 105 + (j - 1.5) * 0.2) }
  B(106, 104, 105)
  const sig = computeFibConfluence(b, '4h')
  assert.ok(sig, 'a stacked confluence must produce a signal')
  assert.equal(sig.strategy, 'fib_confluence')
  assert.ok(sig.conviction >= 6)
  assert.ok(sig.rr >= 1.5)
  if (sig.bias === 'long') assert.ok(sig.sl < sig.entry); else assert.ok(sig.sl > sig.entry)
})

test('computeFibConfluence: is registered and armable via the registry', async () => {
  const { STRATEGY_KEYS } = await import('./strategies.js')
  assert.ok(STRATEGY_KEYS.includes('fib_confluence'), 'fib_confluence in the registry')
})
