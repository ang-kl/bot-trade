import test from 'node:test'
import assert from 'node:assert/strict'
import { planMomentumTargets, priceTicks, sameTicks, stopHeld, shiftStopToFill, MOMENTUM_MIN_REQUIRED_RR } from './momentum-target-policy.js'
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
