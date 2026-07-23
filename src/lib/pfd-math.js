// Pure math for the CockpitPFD instrument (kept out of the component file
// so it's unit-testable and fast-refresh-safe).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const isLongSide = (side) => side === 'BUY' || side === 'Long' || side === 'long'

/** R-multiple: signed progress from entry in units of the stop distance. */
export function pfdR(entry, sl, side, price) {
  if (entry == null || sl == null || price == null) return null
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  return ((price - entry) * (isLongSide(side) ? 1 : -1)) / risk
}

/**
 * Roll angle from TP convergence. `samples` are {t, d} where d is the
 * distance to TP normalized by the SL distance (symbol-agnostic). The
 * change per minute maps onto a bank angle: RIGHT bank (positive) =
 * distance shrinking = converging on the TP; LEFT = diverging.
 */
export function rollFromSamples(samples) {
  if (!samples || samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  const mins = (last.t - first.t) / 60000
  if (!(mins > 0)) return 0
  const closingRatePerMin = (first.d - last.d) / mins // + = getting closer to TP
  return clamp(Math.tanh(closingRatePerMin / 0.5) * 30, -30, 30)
}
