import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { modelMomentumCost } from './momentum-target-cost.js'

const schedule = JSON.parse(readFileSync(new URL('../config/tick-shadow-sim.json', import.meta.url)))
const input = { symbol: 'ETHUSD', side: 'BUY', entry: 100, initialRisk: 10, requiredRr: 3,
  spread: 0.2, quoteUsdRate: 1, carryingCostReservePrice: 0,
  lotSize: 100, minVolume: 100, digits: 2 }

test('cost reserve exposes commission measurement and slippage/carry assumptions separately', () => {
  const c = modelMomentumCost(input, schedule)
  assert.equal(c.ok, true)
  assert.equal(c.class, 'crypto')
  assert.match(c.commissionSource, /MEASURED ZERO/)
  assert.match(c.slippageSource, /PLACEHOLDER/)
  const worst = 140 + c.costReservePrice + 0.02
  assert.ok(c.costReservePrice >= 0.2 + 3 * worst * 0.5 / 10000)
  assert.equal(c.empiricallyValidated, false)
  assert.equal(c.carryingCostReservePrice, 0)
  assert.match(c.limitations.join(' '), /swap|carry/)
})

test('minimum-size US stock fees and FX per-lot conversion are not lost in a size-free rate', () => {
  const tiny = modelMomentumCost({ ...input, symbol: 'AAPL.US', minVolume: 10 }, schedule)
  assert.ok(tiny.costReservePrice >= 0.2 + 3 * 0.2)
  const fx = modelMomentumCost({ ...input, symbol: 'USDJPY', quoteUsdRate: 1 / 150, lotSize: 10000000 }, schedule)
  assert.equal(fx.commissionBasis, 'usd_per_lot')
  assert.equal(fx.commissionFixedPerUnit, 3.5 / 100000 * 150)
})

test('missing, negative, coercible or unsupported cost evidence refuses instead of implying zero', () => {
  for (const patch of [{ spread: null }, { quoteUsdRate: null }, { carryingCostReservePrice: undefined },
    { lotSize: 0 }, { minVolume: 0 }, { entry: Infinity }, { side: 'unknown' },
    { carryingCostReservePrice: -1 }, { spread: '0.2' }, { symbol: 'SAP.DE' }]) {
    assert.equal(modelMomentumCost({ ...input, ...patch }, schedule).ok, false)
  }
  const broken = structuredClone(schedule)
  delete broken.costs.classes.crypto.commissionBpsPerSide
  assert.equal(modelMomentumCost(input, broken).ok, false)
})

test('long and short reserve upper price bounds cover price-dependent costs after target rounding', () => {
  for (const side of ['BUY', 'SELL']) {
    const c = modelMomentumCost({ ...input, symbol: '0066.HK', side, quoteUsdRate: 1 / 7.8 }, schedule)
    assert.equal(c.ok, true)
    const worst = side === 'BUY' ? 140 + c.costReservePrice + 0.02 : 110
    assert.ok(c.costReservePrice >= input.spread + 3 * worst * (15 + 0.5) / 10000 - 1e-10)
  }
})
