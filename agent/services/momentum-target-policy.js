// Candidate policy arithmetic only. No broker calls, activation or edge claim.
export const MOMENTUM_TARGET_POLICY = 'risk_coverage_partial_v1'
const finite = n => typeof n === 'number' && Number.isFinite(n)
const positive = n => finite(n) && n > 0
const volumeInt = n => Number.isSafeInteger(n) && n > 0

function outward(price, digits, direction) {
  const factor = 10 ** digits, scaled = price * factor, nearest = Math.round(scaled)
  const integer = Math.abs(scaled - nearest) < 1e-8 ? nearest
    : direction === 1 ? Math.ceil(scaled) : Math.floor(scaled)
  return integer / factor
}

/** Volumes are broker cents-of-units, never lots. Cost is an explicit reserve
 * per unit for the full two-exit lifecycle, not a prediction of realized fees.
 * The coverage identity assumes both fills at the modeled prices; gaps and
 * slippage may exceed the reserve. Existing risk/entry gates remain external.
 */
export function planMomentumTargets(input = {}) {
  const { side, entry, originalStop, requiredRr, costReservePrice: cost,
    digits, volume, minVolume, stepVolume } = input
  const refuse = reason => ({ ok: false, policy: MOMENTUM_TARGET_POLICY, reason })
  if (side !== 'BUY' && side !== 'SELL') return refuse('direction_required')
  if (!positive(entry) || !positive(originalStop) || !positive(requiredRr)
    || !finite(cost) || cost < 0) return refuse('risk_and_cost_evidence_required')
  if (!Number.isInteger(digits) || digits < 0 || digits > 8) return refuse('price_precision_required')
  if (![volume, minVolume, stepVolume].every(volumeInt) || volume < minVolume
    || volume % stepVolume !== 0) return refuse('broker_volume_invalid')
  const direction = side === 'BUY' ? 1 : -1
  const risk = direction * (entry - originalStop)
  if (!(risk > 0)) return refuse('original_stop_on_wrong_side')
  const rr = Math.max(1, requiredRr)
  const trigger = outward(entry + direction * (rr * risk + cost), digits, direction)
  const distance = direction * (trigger - entry)
  const runnerTarget = outward(trigger + direction * risk, digits, direction)
  if (!positive(trigger) || !(distance > cost)) return refuse('target_price_invalid')
  const fraction = (risk + cost) / (distance + risk)
  const desiredVolume = Math.ceil(Math.max(volume * fraction, minVolume) / stepVolume) * stepVolume
  const partial = desiredVolume < volume && volume - desiredVolume >= minVolume
  if (partial && (!positive(runnerTarget) || direction * (runnerTarget - trigger) <= 0)) return refuse('target_price_invalid')
  const closeVolume = partial ? desiredVolume : volume
  const runnerVolume = volume - closeVolume
  const modeledNetAtOriginalStop = closeVolume * (distance - cost) - runnerVolume * (risk + cost)
  if (!Number.isFinite(modeledNetAtOriginalStop) || modeledNetAtOriginalStop < -1e-7) return refuse('coverage_not_representable')
  return {
    ok: true, policy: MOMENTUM_TARGET_POLICY, validation: 'CANDIDATE_NOT_EMPIRICALLY_VALIDATED',
    mode: partial ? 'partial_runner' : 'whole_position_minimum',
    reason: partial ? null : 'no_valid_partial_and_runner',
    side, entry, originalStop, initialRisk: risk, requiredRr, costReservePrice: cost,
    trigger, brokerTarget: partial ? runnerTarget : trigger,
    volume, closeVolume, runnerVolume, closePercentage: closeVolume / volume * 100,
    minVolume, stepVolume, digits, modeledNetAtOriginalStop, modeledValueUnit: 'price_times_broker_volume',
  }
}
