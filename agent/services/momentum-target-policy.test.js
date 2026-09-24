import test from 'node:test'
import assert from 'node:assert/strict'
import { planMomentumTargets } from './momentum-target-policy.js'

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

test('outward price rounding never lowers the admitted reward/risk floor', () => {
  for (const side of ['BUY', 'SELL']) {
    const p = planMomentumTargets({ ...input, side, originalStop: side === 'BUY' ? 99.777 : 100.223,
      costReservePrice: 0.001, requiredRr: 1.5 })
    assert.equal(p.ok, true)
    const direction = side === 'BUY' ? 1 : -1
    assert.ok((direction * (p.trigger - input.entry) - 0.001) / 0.223 >= 1.5 - 1e-10)
    assert.ok(p.modeledNetAtOriginalStop >= -1e-7)
  }
})

test('an unsplittable short needs only its whole-position target to remain positive', () => {
  const p = planMomentumTargets({ ...input, side: 'SELL', originalStop: 125, volume: 100 })
  assert.equal(p.ok, true)
  assert.equal(p.mode, 'whole_position_minimum')
  assert.equal(p.brokerTarget, 24.6)
})
