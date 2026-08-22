// node --test agent/services/daily-cap-binding.test.js
//
// THE PRODUCTION LINE, 22-08-2026, 5,173 times in one day:
//
//   daily_loss_limit_hit pnl=-2281.09 limit=1358.09
//     — flat $ cap binds ($150.00, tighter than $1358.09 from %)
//
// It reports one number and then blames a different one. `capUsd` was right;
// only the explanation lied. The cause: `binding` compared against the raw
// `usdCapUsd` while the line above had already EXCLUDED the flat cap from the
// combination, because the balance-tier rule was on and takes it out of force.
//
// THE COST WAS NOT COSMETIC. Read off the veto log, the $150 looked like a
// shutdown-tight cap on a small balance and went into a written recommendation
// to raise it. It was not in force at all; the cap actually holding the line
// was $1,358.09, which is 4% of a $33,952 account and entirely correct. A
// message that names the wrong field sends the operator to change a setting
// that is doing nothing — and leaves the one that IS binding unexamined.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pacedDailyCap, describeBinding } from './daily-loss-pacing.js'

const TIER = { tierSmallPct: 0.03, tierLargePct: 0.04, tierAtUsd: 10000 }
const at = (over) => pacedDailyCap({
  basePct: 0.03, maxPct: null, nowMs: 1_000_000, dayOpenMs: 0, floorUsd: 200, ...over,
})

test('THE PRODUCTION CASE: a tiered account does not blame the flat cap', () => {
  const p = at({ balance: 33952.16, absoluteFallback: 150, ...TIER })
  assert.equal(Math.round(p.capUsd * 100) / 100, 1358.09, 'the cap itself was always right')
  assert.equal(p.binding, 'pct', 'the % cap is what holds the line')
  assert.equal(p.usdInForce, null, 'the flat cap is out of force under the tier rule')
  const said = describeBinding(p)
  assert.match(said, /1358\.09/)
  assert.match(said, /out of force/)
  assert.ok(!/flat \$ cap binds/.test(said), 'it must not name a cap that is not applied')
})

test('the configured flat cap is still REPORTED, just not blamed', () => {
  // Deliberate: the Risk page must be able to show what is set. What changes
  // is that a reader deciding what BINDS uses usdInForce.
  const p = at({ balance: 33952.16, absoluteFallback: 150, ...TIER })
  assert.equal(p.usdCapUsd, 150)
  assert.match(describeBinding(p), /\$150\.00/)
})

test('WITH THE TIER RULE OFF the flat cap binds exactly as before', () => {
  // The regression that would matter most: this fix must not disarm a real cap.
  // floorUsd null so the $200 floor does not lift the cap off the flat 150 and
  // take the binding label with it — that path is its own test below.
  const p = at({ balance: 33952.16, absoluteFallback: 150, floorUsd: null })
  assert.equal(p.usdInForce, 150)
  assert.equal(p.binding, 'usd')
  assert.equal(p.capUsd, 150)
  assert.match(describeBinding(p), /flat \$ cap binds/)
})

test('a tighter % cap still reads as pct with the flat cap in force', () => {
  const p = at({ balance: 1000, absoluteFallback: 5000, floorUsd: null })
  assert.equal(p.binding, 'pct')
  assert.equal(p.usdInForce, 5000)
  assert.match(describeBinding(p), /tighter than the \$5000\.00 flat cap/)
})

test('the floor still wins when it lifts the cap, tier rule or not', () => {
  const p = at({ balance: 1000, absoluteFallback: 150, floorUsd: 200, ...TIER })
  assert.equal(p.capUsd, 200)
  assert.equal(p.binding, 'floor')
})

test('PACING IS NO LONGER SUPPRESSED on a tiered account with a ramp', () => {
  // `paced` is gated on binding !== 'usd', so the mislabel silently turned the
  // ramp off — a second symptom of the same one-line bug.
  const p = pacedDailyCap({
    balance: 33952.16, basePct: 0.02, maxPct: 0.05, absoluteFallback: 150,
    nowMs: 43_200_000, dayOpenMs: 0, floorUsd: null, ...TIER,
  })
  assert.notEqual(p.binding, 'usd')
  assert.equal(p.paced, true, 'a tiered account with a ceiling must still report its ramp')
})

test('both checks off is still uncapped — a floor never invents a limit', () => {
  const p = pacedDailyCap({
    balance: 1000, basePct: null, maxPct: null, absoluteFallback: null,
    nowMs: 1, dayOpenMs: 0, floorUsd: 200,
  })
  assert.equal(p.capUsd, null)
  assert.equal(p.uncapped, true)
  assert.equal(describeBinding(p), null)
})
