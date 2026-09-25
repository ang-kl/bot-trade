// Candidate policy arithmetic only. No broker calls, activation or edge claim.
export const MOMENTUM_TARGET_POLICY = 'risk_coverage_partial_v1'
// relativePoints (lot-sizing.js) clamps a relative SL/TP to 5 decimals, so a
// finer symbol's target could not be sent as the relative bracket it plans.
export const MOMENTUM_MAX_PRICE_DIGITS = 5
// The static R:R floor the entry gate enforces: risk.js HARD_MIN_RR. Kept as a
// copy so this module stays a leaf (risk.js reaches this file through
// strategy-verdicts -> evidence-gate -> momentum-account); the policy test pins
// the two equal, so neither can move alone.
export const MOMENTUM_MIN_REQUIRED_RR = 3.0
const finite = n => typeof n === 'number' && Number.isFinite(n)
const positive = n => finite(n) && n > 0
const volumeInt = n => Number.isSafeInteger(n) && n > 0
const priceDigits = d => Number.isInteger(d) && d >= 0 && d <= MOMENTUM_MAX_PRICE_DIGITS

/** A price, or a price distance, in whole ticks at the symbol's digits. Two
 * computations of one grid price agree here even when their floats differ by
 * a few ulps (247.81 vs 247.81000000000003). Null when it cannot be expressed. */
export function priceTicks(price, digits) {
  if (!finite(price) || !priceDigits(digits)) return null
  const ticks = Math.round(price * 10 ** digits)
  return Number.isSafeInteger(ticks) ? ticks : null
}

export function sameTicks(a, b, digits) {
  const x = priceTicks(a, digits)
  return x != null && x === priceTicks(b, digits)
}

/** The broker stop protects at least as much as the plan's: at or above it
 * for a BUY, at or below it for a SELL, compared in ticks. */
export function stopHeld(side, brokerStop, planStop, digits) {
  const held = priceTicks(brokerStop, digits), plan = priceTicks(planStop, digits)
  if (held == null || plan == null || held <= 0) return false
  return side === 'BUY' ? held >= plan : side === 'SELL' ? held <= plan : false
}

// A shift is float residue when it is this close to a whole tick: far above
// the few-ulp error of a sum at any listed price, far below a real tick.
const SNAP_TOLERANCE_TICKS = 1e-6

/** The original stop moved by a confirmed fill's slippage, snapped to the
 * price grid. A fill on the grid moves it a whole number of ticks exactly,
 * which is what the broker does to a relative stop. A fill off the grid (a
 * multi-deal average) rounds the stop outward, so the plan never assumes a
 * tighter stop, or a smaller risk, than the broker may hold. */
export function shiftStopToFill({ side, entry, originalStop, digits } = {}, fillEntry) {
  if ((side !== 'BUY' && side !== 'SELL') || !priceDigits(digits)
    || ![entry, originalStop, fillEntry].every(positive)) return null
  const factor = 10 ** digits
  const scaled = originalStop * factor + (fillEntry - entry) * factor, nearest = Math.round(scaled)
  const ticks = Math.abs(scaled - nearest) < SNAP_TOLERANCE_TICKS ? nearest
    : side === 'BUY' ? Math.floor(scaled) : Math.ceil(scaled)
  return ticks > 0 && Number.isSafeInteger(ticks) ? ticks / factor : null
}

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
  // Q is the entry gate's floor, never below it. The old clamp to 1 let a
  // TP1 at QR+C be planned under the HARD_MIN_RR the gate measures.
  if (requiredRr < MOMENTUM_MIN_REQUIRED_RR) return refuse('required_rr_below_hard_minimum')
  if (!Number.isInteger(digits) || digits < 0 || digits > 8) return refuse('price_precision_required')
  if (!priceDigits(digits)) return refuse('relative_bracket_precision_unsupported')
  if (![volume, minVolume, stepVolume].every(volumeInt) || volume < minVolume
    || volume % stepVolume !== 0) return refuse('broker_volume_invalid')
  const direction = side === 'BUY' ? 1 : -1
  const risk = direction * (entry - originalStop)
  if (!(risk > 0)) return refuse('original_stop_on_wrong_side')
  const trigger = outward(entry + direction * (requiredRr * risk + cost), digits, direction)
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
