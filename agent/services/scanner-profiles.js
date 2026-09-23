import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
export const FIB_PROFILE = hash('fib_618_fade;closed;FX_DEFAULT;strict_without_filters;schema1')
const OPTION_INDEPENDENT = ['donchian_breakout', 'rsi2_reversion', 'vwap_trend', 'fib_confluence']
export const NATIVE_DEFAULT_STRATEGIES = Object.freeze([...OPTION_INDEPENDENT,
  'cup_handle', 'inv_cup_handle', 'ema_pullback', 'rsi_meanrev', 'vp_value', 'va_breakout', 'fvg_retrace'])
// Admit only the exact semantics implemented by the default native profile.
// Unrelated coordinator options do not change these strategy calculations.
export function nativeDefaultCompatible(strategy, opts = {}, fvgDefaults) {
  if (OPTION_INDEPENDENT.includes(strategy)) return true
  if (strategy === 'cup_handle' || strategy === 'inv_cup_handle') return !opts.vwapFilter
  if (strategy === 'ema_pullback') return !opts.pendingSetup
    && (opts.requireStack === undefined || opts.requireStack === true)
    && (opts.minSlAtr === undefined || opts.minSlAtr === 0.8)
    && (opts.maxSlAtr === undefined || opts.maxSlAtr === 3)
    && (opts.timeCapBars == null || opts.timeframeMinutes == null)
  if (strategy === 'rsi_meanrev') return (opts.minRr ?? 1.5) === 1.5
  if (strategy === 'vp_value') return (!opts.vpType || opts.vpType === 'composite')
    && opts.structureGate !== false && opts.structure == null
  if (strategy === 'va_breakout') return opts.structure == null
  if (strategy === 'fvg_retrace') return (opts.maxAgeBars === undefined || opts.maxAgeBars === 40)
    && fvgDefaults?.minGapAtr === 0.25 && fvgDefaults?.maxGapAtr === 3 && fvgDefaults?.maxAgeBars === 40
  return false
}
const finiteNonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
// Hash numeric parameters by IEEE-754 bits, avoiding JS/C++ decimal-printer
// differences. These are observation profiles, never strategy configuration.
const numberBits = n => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(n === 0 ? 0 : n); return bytes.toString('hex') }
export function nativeOptionsFor(strategy, opts = {}, fvgDefaults) {
  if (nativeDefaultCompatible(strategy, opts, fvgDefaults)) return {}
  if (strategy !== 'ema_pullback') return null
  const { pendingSetup = false, requireStack = true, minSlAtr = 0.8, maxSlAtr = 3,
    timeCapBars = null, timeframeMinutes = null } = opts
  if (typeof pendingSetup !== 'boolean' || typeof requireStack !== 'boolean'
    || !finiteNonnegative(minSlAtr) || !finiteNonnegative(maxSlAtr)) return null
  let timeCapMinutes = null
  if (timeCapBars != null && timeframeMinutes != null) {
    if (!finiteNonnegative(timeCapBars) || !finiteNonnegative(timeframeMinutes)) return null
    timeCapMinutes = timeCapBars * timeframeMinutes
    if (!finiteNonnegative(timeCapMinutes)) return null
  }
  return { pendingSetup, requireStack, minSlAtr, maxSlAtr, timeCapMinutes }
}
export function nativeProfileHash(strategy, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null
  if (Object.keys(options).length) {
    const { pendingSetup, requireStack, minSlAtr, maxSlAtr, timeCapMinutes } = options
    if (strategy !== 'ema_pullback' || Object.keys(options).sort().join(',') !== 'maxSlAtr,minSlAtr,pendingSetup,requireStack,timeCapMinutes'
      || typeof pendingSetup !== 'boolean' || typeof requireStack !== 'boolean'
      || !finiteNonnegative(minSlAtr) || !finiteNonnegative(maxSlAtr)
      || (timeCapMinutes !== null && !finiteNonnegative(timeCapMinutes))) return null
    return hash(`ema_pullback;closed;reference_options;schema1;${Number(pendingSetup)};${Number(requireStack)};${numberBits(minSlAtr)};${numberBits(maxSlAtr)};${timeCapMinutes === null ? 'null' : numberBits(timeCapMinutes)}`)
  }
  return strategy === 'fib_618_fade' ? FIB_PROFILE
    : NATIVE_DEFAULT_STRATEGIES.includes(strategy) ? hash(`${strategy};closed;reference_defaults;schema1`) : null
}
