import test from 'node:test'
import assert from 'node:assert/strict'
import { planMomentumTargets, priceTicks, sameTicks, stopHeld, shiftStopToFill, offPriceGrid, MOMENTUM_MIN_REQUIRED_RR } from './momentum-target-policy.js'
import { HARD_MIN_RR } from './risk.js'

const input = { side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 }

test('partial volume covers modeled runner loss after cost and broker rounding', () => {
  const p = planMomentumTargets(input)
  assert.equal(p.ok, true)
  assert.equal(p.mode, 'partial_runner')
  assert.equal(p.trigger, 130.4)
  assert.equal(p.brokerTarget, 140.4)
  assert.equal(p.closeVolume, 2600)
  assert.equal(p.runnerVolume, 7400)
  assert.ok(p.modeledNetAtOriginalStop >= 0)
  const independent = 2600 * (130.4 - 100 - 0.4) - 7400 * (100 - 90 + 0.4)
  assert.ok(Math.abs(independent - p.modeledNetAtOriginalStop) < 1e-7)
})

test('short mirrors long without inferring direction from a stop', () => {
  const p = planMomentumTargets({ ...input, side: 'SELL', originalStop: 110 })
  assert.equal(p.trigger, 69.6)
  assert.equal(p.brokerTarget, 59.6)
  assert.equal(p.closeVolume, 2600)
  for (const side of [null, '', 'unknown', 1]) assert.equal(planMomentumTargets({ ...input, side }).ok, false)
})

test('minimum volume cannot create dust or silently enlarge the position', () => {
  const p = planMomentumTargets({ ...input, volume: 100, minVolume: 100 })
  assert.equal(p.mode, 'whole_position_minimum')
  assert.equal(p.closeVolume, 100)
  assert.equal(p.runnerVolume, 0)
  assert.equal(p.brokerTarget, p.trigger)
  assert.equal(p.reason, 'no_valid_partial_and_runner')
  const exact = planMomentumTargets({ ...input, volume: 200 })
  assert.equal(exact.closeVolume, 100)
  assert.equal(exact.runnerVolume, 100)
})

test('missing costs, invalid broker units, crossed original stop and nonpositive short target refuse', () => {
  for (const patch of [{ costReservePrice: null }, { costReservePrice: undefined }, { costReservePrice: -1 },
    { volume: 101 }, { minVolume: 0 }, { stepVolume: 0 }, { volume: 1.2 }, { digits: null },
    { requiredRr: null }, { originalStop: 105 }, { entry: Infinity },
    { side: 'SELL', originalStop: 200 }]) {
    assert.equal(planMomentumTargets({ ...input, ...patch }).ok, false, JSON.stringify(patch))
  }
})

// Rewritten deliberately for T1 (V3 P0-1a): this test used requiredRr 1.5,
// which the old Math.max(1, Q) clamp admitted. Q below risk.js HARD_MIN_RR is
// now refused (next test), so the rounding property is checked at the floor.
test('outward price rounding never lowers the admitted reward/risk floor', () => {
  for (const side of ['BUY', 'SELL']) {
    const p = planMomentumTargets({ ...input, side, originalStop: side === 'BUY' ? 99.777 : 100.223,
      costReservePrice: 0.0013, requiredRr: HARD_MIN_RR })
    assert.equal(p.ok, true)
    const direction = side === 'BUY' ? 1 : -1
    assert.ok((direction * (p.trigger - input.entry) - 0.0013) / 0.223 >= HARD_MIN_RR - 1e-10)
    assert.ok(p.modeledNetAtOriginalStop >= -1e-7)
  }
})

test('Q below the gate\'s HARD_MIN_RR is refused, never clamped, and the copy is pinned to risk.js', () => {
  assert.equal(MOMENTUM_MIN_REQUIRED_RR, HARD_MIN_RR)
  const low = planMomentumTargets({ ...input, requiredRr: 2.9 })
  assert.equal(low.ok, false); assert.equal(low.reason, 'required_rr_below_hard_minimum')
  assert.equal(planMomentumTargets({ ...input, requiredRr: 1 }).reason, 'required_rr_below_hard_minimum')
  assert.equal(planMomentumTargets({ ...input, requiredRr: HARD_MIN_RR }).ok, true)
  assert.equal(planMomentumTargets({ ...input, requiredRr: 3.5 }).ok, true)
})

test('digits beyond relativePoints\' five decimals are refused; 0 to 5 plan', () => {
  for (const digits of [6, 8]) {
    const p = planMomentumTargets({ ...input, digits })
    assert.equal(p.ok, false); assert.equal(p.reason, 'relative_bracket_precision_unsupported', String(digits))
  }
  for (const digits of [0, 1, 2, 3, 4, 5]) assert.equal(planMomentumTargets({ ...input, digits }).ok, true, String(digits))
  assert.equal(planMomentumTargets({ ...input, digits: -1 }).reason, 'price_precision_required')
  assert.equal(planMomentumTargets({ ...input, digits: 2.5 }).reason, 'price_precision_required')
})

test('tick arithmetic: grid prices compare in ticks and a fill moves the stop by whole ticks', () => {
  assert.equal(priceTicks(247.81000000000003, 2), 24781)
  assert.ok(sameTicks(247.81, 247.81000000000003, 2))
  assert.ok(!sameTicks(247.81, 247.82, 2))
  assert.ok(!sameTicks(null, null, 2)); assert.ok(!sameTicks(247.81, 247.81, undefined)); assert.ok(!sameTicks(1, 1, 6))
  // The reviewer's named case: BUY 265.87/247.77 filled at 265.91.
  assert.equal(shiftStopToFill({ side: 'BUY', entry: 265.87, originalStop: 247.77, digits: 2 }, 265.91), 247.81)
  assert.equal(shiftStopToFill({ side: 'SELL', entry: 265.87, originalStop: 283.97, digits: 2 }, 265.83), 283.93)
  // A multi-deal average fill off the grid rounds the stop outward (wider).
  assert.equal(shiftStopToFill({ side: 'BUY', entry: 265.87, originalStop: 247.77, digits: 2 }, 265.905), 247.8)
  assert.equal(shiftStopToFill({ side: 'SELL', entry: 265.87, originalStop: 283.97, digits: 2 }, 265.875), 283.98)
  assert.equal(shiftStopToFill({ side: 'BUY', entry: 1, originalStop: 0.5, digits: 7 }, 1), null)
  // The broker stop may be tighter than the plan's, never wider.
  assert.ok(stopHeld('BUY', 247.81, 247.81000000000003, 2)); assert.ok(stopHeld('BUY', 247.82, 247.81, 2))
  assert.ok(!stopHeld('BUY', 247.8, 247.81, 2))
  assert.ok(stopHeld('SELL', 283.93, 283.93000000000006, 2)); assert.ok(!stopHeld('SELL', 283.94, 283.93, 2))
  assert.ok(!stopHeld('BUY', null, 247.81, 2)); assert.ok(!stopHeld('LONG', 247.81, 247.81, 2))
})

test('an unsplittable short needs only its whole-position target to remain positive', () => {
  const p = planMomentumTargets({ ...input, side: 'SELL', originalStop: 125, volume: 100 })
  assert.equal(p.ok, true)
  assert.equal(p.mode, 'whole_position_minimum')
  assert.equal(p.brokerTarget, 24.6)
})

// T1b (H1): the proposal refuses a planned price off the grid. Float residue
// (a few ulps beside a grid price) is on the grid; a fraction of a tick is not.
test('offPriceGrid names a fraction of a tick, never float residue or an unexpressible price', () => {
  assert.equal(offPriceGrid(247.8137, 2), true)
  assert.equal(offPriceGrid(265.9133, 2), true)
  assert.equal(offPriceGrid(265.905, 2), true)
  assert.equal(offPriceGrid(1.123455, 5), true)
  assert.equal(offPriceGrid(247.81, 2), false)
  assert.equal(offPriceGrid(247.81000000000003, 2), false)
  // An ATR stop distance, raw and as relativePoints sends it (18 ticks).
  assert.equal(offPriceGrid(265.87 - 0.1809, 2), true)
  assert.equal(offPriceGrid(265.87 - 18000 / 100000, 2), false)
  for (const [price, d] of [[null, 2], [NaN, 2], [247.8137, 6], [247.8137, undefined], [247.8137, 2.5]]) {
    assert.equal(offPriceGrid(price, d), false, `${price}@${d}`)
  }
})

// Deterministic PRNG (mulberry32), so a red run names a reproducible case.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// T1b: a proposal and its fill slipped a whole number of ticks have the same
// risk in ticks, so the bind's recomputed targets must move by exactly the
// slip. Rounding the summed PRICE let float residue decide a reserve that
// sits on the rounding tolerance: a whole number of ticks plus the cost
// model's 1e-10 (1e-8 ticks at 2 decimals), as the ask-minus-bid float
// (2904.25 - 2904.24 = 0.010000000000218279) produces through its ceil.
test('targets move by exactly the slip in ticks, including a reserve on the rounding tolerance', () => {
  const named = { side: 'BUY', requiredRr: 3, costReservePrice: 0.4900000001, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 }
  const planned = planMomentumTargets({ ...named, entry: 2904.25, originalStop: 2830.44 })
  const filled = planMomentumTargets({ ...named, entry: 2904.28, originalStop: 2830.47 })
  assert.equal(planned.ok && filled.ok, true)
  assert.equal(priceTicks(filled.trigger, 2) - priceTicks(planned.trigger, 2), 3, `${planned.trigger} -> ${filled.trigger}`)
  assert.equal(priceTicks(filled.brokerTarget, 2) - priceTicks(planned.brokerTarget, 2), 3, `${planned.brokerTarget} -> ${filled.brokerTarget}`)

  const random = rng(20260926)
  const pick = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const bands = { 0: [100, 60000], 1: [100, 600000], 2: [100, 5000000], 3: [1000, 250000], 4: [1000, 2000000], 5: [20000, 200000] }
  const failures = []
  let cases = 0
  for (let i = 0; i < 3000; i++) {
    const d = pick(0, 5), f = 10 ** d, side = random() < 0.5 ? 'BUY' : 'SELL', dir = side === 'BUY' ? 1 : -1
    const et = pick(...bands[d]), rt = pick(1, Math.max(2, Math.floor(et * 0.05)))
    const slip = pick(1, 5) * (random() < 0.5 ? -1 : 1)
    // A whole number of ticks, lifted by the cost model's ceil over residue.
    const costReservePrice = Math.ceil((pick(0, 50) / f + 1e-13) * 1e10) / 1e10
    const base = { side, requiredRr: [3, 3.5, 4][pick(0, 2)], costReservePrice, digits: d, volume: 10000, minVolume: 100, stepVolume: 100 }
    const a = planMomentumTargets({ ...base, entry: et / f, originalStop: (et - dir * rt) / f })
    const b = planMomentumTargets({ ...base, entry: (et + slip) / f, originalStop: (et + slip - dir * rt) / f })
    if (!a.ok || !b.ok) continue
    cases++
    if (priceTicks(b.trigger, d) - priceTicks(a.trigger, d) !== slip
      || priceTicks(b.brokerTarget, d) - priceTicks(a.brokerTarget, d) !== slip) {
      failures.push(`${d}/${side} ${a.entry}/${a.originalStop} cost ${costReservePrice} slip ${slip}: ${a.trigger}/${a.brokerTarget} -> ${b.trigger}/${b.brokerTarget}`)
    }
  }
  assert.ok(cases > 2500, `only ${cases} plannable cases`)
  assert.deepEqual(failures.slice(0, 5), [])
})

// The tick-space targets change nothing where the summed price is not on the
// rounding tolerance: an off-grid stop (the planner still accepts it; only
// the proposal refuses it) and an off-grid entry, which keeps the old price
// rounding. Values computed by hand from outward rounding.
test('tick-space targets equal price rounding off the tolerance, for grid and off-grid inputs', () => {
  const offStop = planMomentumTargets({ ...input, originalStop: 99.777, costReservePrice: 0.0013, requiredRr: 3 })
  assert.equal(offStop.trigger, 100.68); assert.equal(offStop.brokerTarget, 100.91)
  const offEntry = planMomentumTargets({ ...input, entry: 100.0033, originalStop: 90, requiredRr: 3 })
  assert.equal(offEntry.trigger, 130.42); assert.equal(offEntry.brokerTarget, 140.43)
  const sell = planMomentumTargets({ ...input, side: 'SELL', entry: 100.0033, originalStop: 110, requiredRr: 3 })
  assert.equal(sell.trigger, 69.61); assert.equal(sell.brokerTarget, 59.61)
})
