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
export const nativeProfileHash = strategy => strategy === 'fib_618_fade' ? FIB_PROFILE
  : NATIVE_DEFAULT_STRATEGIES.includes(strategy) ? hash(`${strategy};closed;reference_defaults;schema1`) : null
