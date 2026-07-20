// ---------------------------------------------------------------------------
// agent/services/strategies.js — the strategy registry.
//
// Single source of truth for every tradeable strategy: key, plain-words name,
// compute function, default-on flag and whether the strategy can park a
// resting (pending) order pre-touch. The scan loop, backtest, routes and
// trade labels all resolve strategies THROUGH this table — nothing else may
// hardcode a strategy key.
//
// Import direction constraint: this module imports the strategy modules;
// strategy modules must NEVER import this registry (no cycles).
// ---------------------------------------------------------------------------

import { computeFibSignal } from './fib-strategy.js'
import { computeCupHandleSignal } from './cup-handle.js'

// The three newer strategy modules are loaded defensively: if a module is
// missing or broken the registry still builds, with a compute that simply
// never signals — the scan loop and routes stay up.
async function loadCompute(path, exportName) {
  try {
    const mod = await import(path)
    if (typeof mod[exportName] === 'function') return mod[exportName]
  } catch { /* module absent or broken — fall through to the null compute */ }
  return () => null
}

const computeEmaPullback = await loadCompute('./ema-pullback.js', 'computeEmaPullback')
const computeDonchianBreakout = await loadCompute('./donchian-breakout.js', 'computeDonchianBreakout')
const computeRsiMeanrev = await loadCompute('./rsi-meanrev.js', 'computeRsiMeanrev')
const computeVwapTrend = await loadCompute('./vwap-trend.js', 'computeVwapTrend')
const computeVpValue = await loadCompute('./vp-value.js', 'computeVpValue')

export const STRATEGY_REGISTRY = [
  { key: 'fib_618_fade',      name: 'Fib 61.8% fade',     compute: computeFibSignal,        defaultOn: true,  pendingCapable: true  },
  { key: 'cup_handle',        name: 'Cup & Handle',       compute: computeCupHandleSignal,  defaultOn: false, pendingCapable: false },
  { key: 'ema_pullback',      name: 'EMA trend-pullback', compute: computeEmaPullback,      defaultOn: false, pendingCapable: false },
  { key: 'donchian_breakout', name: 'Range breakout',     compute: computeDonchianBreakout, defaultOn: false, pendingCapable: false },
  { key: 'rsi_meanrev',       name: 'RSI mean-reversion', compute: computeRsiMeanrev,       defaultOn: false, pendingCapable: false },
  { key: 'vwap_trend',        name: 'VWAP trend-pullback', compute: computeVwapTrend,       defaultOn: false, pendingCapable: false },
  { key: 'vp_value',          name: 'Volume-profile rotation', compute: computeVpValue,     defaultOn: false, pendingCapable: false },
]

export const STRATEGY_KEYS = STRATEGY_REGISTRY.map(s => s.key)

/** Look up one registry entry by key (or undefined). */
export function strategyByKey(key) {
  return STRATEGY_REGISTRY.find(s => s.key === key)
}

/**
 * Resolve the set of ENABLED strategies from agent_state, in registry order.
 *
 * Rules (deliberate, in priority order):
 * - 'enabled_strategies_json' holds an array of registry keys; unknown keys
 *   are dropped silently (a renamed strategy must not brick the loop).
 * - missing or corrupt state → the defaultOn set (fib only today).
 * - every strategy, INCLUDING fib, is a normal toggle (owner decision
 *   2026-07-10: forcing fib on made unwanted fib trades unavoidable when
 *   running other strategies alone). Default stays fib-on. An empty list is
 *   legal — the scan finds nothing and says so, it does not invent a base.
 *   Pending-order mode still requires fib to be armed for its combos, but
 *   that is enforced where pending setups are scanned, not here.
 * - legacy back-compat: 'cup_handle_enabled' === 'true' adds cup_handle even
 *   when the JSON list doesn't mention it, so old toggles keep working.
 *
 * @returns {Array<{key,name,compute,defaultOn,pendingCapable}>}
 */
export function enabledStrategies(db, getState) {
  let keys = null
  try {
    const parsed = JSON.parse(getState(db, 'enabled_strategies_json') || 'null')
    if (Array.isArray(parsed)) keys = parsed.filter(k => typeof k === 'string')
  } catch { /* corrupt state — fall back to defaults below */ }

  const on = new Set(
    keys === null
      ? STRATEGY_REGISTRY.filter(s => s.defaultOn).map(s => s.key)
      : keys.filter(k => STRATEGY_KEYS.includes(k))
  )
  if (getState(db, 'cup_handle_enabled') === 'true') on.add('cup_handle')

  return STRATEGY_REGISTRY.filter(s => on.has(s.key))
}
