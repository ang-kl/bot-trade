import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
export const FIB_PROFILE = hash('fib_618_fade;closed;FX_DEFAULT;strict_without_filters;schema1')
// These reference functions ignore strategy options. The observer forwards
// their exact existing bar window; no new filter or setting is introduced.
export const NATIVE_DEFAULT_STRATEGIES = Object.freeze(['donchian_breakout', 'rsi2_reversion', 'vwap_trend', 'fib_confluence'])
export const nativeProfileHash = strategy => strategy === 'fib_618_fade' ? FIB_PROFILE
  : NATIVE_DEFAULT_STRATEGIES.includes(strategy) ? hash(`${strategy};closed;reference_defaults;schema1`) : null
