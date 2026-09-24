import { createHash } from 'node:crypto'
import { costClassOf } from '../lib/tick-cost-schedule.js'

const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const positive = n => nonnegative(n) && n > 0

/** Conservative candidate reserve in price units. Explicit inputs and source
 * text are carried forward; this arithmetic does not validate a cost model.
 * Charge three full-unit sides even though the two exits split the quantity.
 * Minimum fees use the smallest legal leg, never the original position size.
 */
export function modelMomentumCost(input, schedule) {
  const fail = reason => ({ ok: false, reason })
  const { symbol, side, entry, initialRisk, requiredRr, spread, quoteUsdRate,
    lotSize, minVolume, digits, carryingCostReservePrice } = input
  if (!['BUY', 'SELL'].includes(side) || ![entry, initialRisk, requiredRr, quoteUsdRate].every(positive)
    || ![spread, carryingCostReservePrice].every(nonnegative)
    || ![lotSize, minVolume].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isInteger(digits) || digits < 0 || digits > 8) return fail('explicit_cost_inputs_required')
  const cls = costClassOf(symbol), row = schedule?.costs?.classes?.[cls]
  const terms = ['commissionWirePerSide', 'commissionBpsPerSide', 'slippageWirePerSide', 'slippageBpsPerSide']
  if (!cls || !row || !terms.every(k => nonnegative(row[k]))
    || !row._commissionSource || !row._slippageSource) return fail('cost_class_evidence_missing')
  let fixed = row.commissionWirePerSide / 100000
  let rate = row.commissionBpsPerSide / 10000
  let basis = 'schedule_class_rate_and_per_unit'
  if (cls === 'fx') {
    const perLot = schedule?.sizedCommission?.fx?.usdPerLotPerSide
    if (!nonnegative(perLot)) return fail('sized_commission_missing')
    fixed = perLot / (lotSize / 100) / quoteUsdRate
    rate = 0
    basis = 'usd_per_lot'
  } else if (cls === 'stock_us') {
    const min = schedule?.sizedCommission?.stock_us?.minUsdPerSide
    if (!nonnegative(min)) return fail('sized_commission_missing')
    fixed = Math.max(fixed, min / (minVolume / 100) / quoteUsdRate)
    basis = 'per_unit_with_minimum_leg_fee'
  }
  const proportional = 3 * (rate + row.slippageBpsPerSide / 10000)
  if (!(proportional < 1)) return fail('cost_reserve_unbounded')
  // Long's largest modeled price is the runner target, which includes C.
  // Short's original stop is higher than entry/targets. Two price ticks cover
  // outward trigger and runner rounding; no actual-price bound is promised.
  const upperPrice = side === 'BUY' ? entry + (Math.max(1, requiredRr) + 1) * initialRisk + 2 * 10 ** -digits
    : entry + initialRisk
  const constant = spread + carryingCostReservePrice + 3 * (fixed + row.slippageWirePerSide / 100000)
  const raw = (constant + proportional * upperPrice) / (side === 'BUY' ? 1 - proportional : 1)
  // Round reserve upward to a wire fraction to avoid floating under-coverage.
  const costReservePrice = Math.ceil(raw * 1e10) / 1e10
  if (!nonnegative(costReservePrice)) return fail('cost_reserve_unbounded')
  return { ok: true, class: cls, costReservePrice, commissionBasis: basis,
    commissionFixedPerUnit: fixed, commissionSource: row._commissionSource,
    slippageSource: row._slippageSource, carryingCostReservePrice,
    scheduleHash: createHash('sha256').update(JSON.stringify(schedule)).digest('hex'),
    empiricallyValidated: false,
    limitations: ['Slippage is the repository placeholder, not measured execution performance.',
      'Carry/swap reserve is an explicit modeling assumption, not a forecast of an unlimited holding period.',
      'Class commission measurements can differ from this account; gaps and future spread/FX changes are not bounded.',
      'The commodity class includes the documented gold-based rate approximation.'],
  }
}
