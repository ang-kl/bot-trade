// node --test agent/services/momentum-slippage-overlay.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
// ---------------------------------------------------------------------------
// 02-10-2026: the momentum TP1 slippage is the owner-confirmed measured figure,
// overlaid on the momentum path only. The shared tick schedule keeps 0.5 bps.
// ---------------------------------------------------------------------------
import { loadMomentumCostSchedule as _loadSched } from './momentum-entry-producer.js'
import { readFileSync as _read } from 'node:fs'
import { TICK_SHADOW_SIM_FILE as _SHARED } from '../lib/tick-cost-schedule.js'
import { modelMomentumCost as _model } from './momentum-target-cost.js'

test('momentum schedule carries the measured slippage; the shared tick schedule is untouched', () => {
  const m = _loadSched(), shared = JSON.parse(_read(_SHARED, 'utf8'))
  const want = { stock_us: 23, commodity: 24, stock_hk: 14, index_cfd: 24, fx: 24, crypto: 24 }
  for (const [c, bps] of Object.entries(want)) {
    assert.equal(m.costs.classes[c].slippageBpsPerSide, bps, c)
    assert.equal(shared.costs.classes[c].slippageBpsPerSide, 0.5, `${c}: shared file unchanged`)
    assert.match(m.costs.classes[c]._slippageSource, /MEASURED/)
  }
})

test('the measured slippage moves the TP1 reserve: US stock reserve rises from the placeholder', () => {
  const input = { symbol: 'XOM.US', side: 'BUY', entry: 161.86, initialRisk: 9.28, requiredRr: 3, spread: 0.05, quoteUsdRate: 1,
    lotSize: 100, minVolume: 100, digits: 2, carryingCostReservePrice: 0 }
  const placeholder = _model(input, JSON.parse(_read(_SHARED, 'utf8')))
  const measured = _model(input, _loadSched())
  assert.ok(placeholder.ok && measured.ok)
  assert.ok(measured.costReservePrice > placeholder.costReservePrice * 5, `${measured.costReservePrice} vs ${placeholder.costReservePrice}`)
})

test('the slippage limitation follows the schedule supplied: placeholder text for the shared file, measured text for the overlay', () => {
  const input = { symbol: 'XOM.US', side: 'BUY', entry: 161.86, initialRisk: 9.28, requiredRr: 3, spread: 0.05, quoteUsdRate: 1,
    lotSize: 100, minVolume: 100, digits: 2, carryingCostReservePrice: 0 }
  const shared = _model(input, JSON.parse(_read(_SHARED, 'utf8'))), overlaid = _model(input, _loadSched())
  assert.ok(shared.limitations.some(t => /repository placeholder/.test(t)))
  assert.ok(!shared.limitations.some(t => /measured entry-side/.test(t)))
  assert.ok(overlaid.limitations.some(t => /measured entry-side/.test(t)))
  assert.ok(!overlaid.limitations.some(t => /repository placeholder/.test(t)))
})
