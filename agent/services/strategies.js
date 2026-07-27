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
import { computeCupHandleSignal, computeInvCupHandleSignal } from './cup-handle.js'

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
const computeRsi2 = await loadCompute('./rsi2-reversion.js', 'computeRsi2')
const computeFibConfluence = await loadCompute('./fib-confluence.js', 'computeFibConfluence')
const computeVaBreakout = await loadCompute('./va-breakout.js', 'computeVaBreakout')

// Owner (2026-07-27): "turn all strategies on by default except fib_618 —
// I'll choose it in Tune since I have fib_confluence." fib_618_fade is the
// one EXPLICIT exception. ema_pullback was held back at first (disarmed the
// same day, net -$2,675.84 over 12 trades) but the owner explicitly
// confirmed re-arming it, citing their own additional entry-context
// tooling for assessing its recent trades — so it's back in the default set.
export const STRATEGY_REGISTRY = [
  { key: 'fib_618_fade',      name: 'Fib 61.8% fade',     compute: computeFibSignal,        defaultOn: false, pendingCapable: true  },
  { key: 'cup_handle',        name: 'Cup & Handle',       compute: computeCupHandleSignal,  defaultOn: true,  pendingCapable: false },
  { key: 'inv_cup_handle',    name: 'Inverted Cup & Handle', compute: computeInvCupHandleSignal, defaultOn: true, pendingCapable: false },
  { key: 'ema_pullback',      name: 'EMA trend-pullback', compute: computeEmaPullback,      defaultOn: true,  pendingCapable: false },
  { key: 'donchian_breakout', name: 'Range breakout',     compute: computeDonchianBreakout, defaultOn: true,  pendingCapable: false },
  { key: 'rsi_meanrev',       name: 'RSI mean-reversion', compute: computeRsiMeanrev,       defaultOn: true,  pendingCapable: false },
  { key: 'vwap_trend',        name: 'VWAP trend-pullback', compute: computeVwapTrend,       defaultOn: true,  pendingCapable: false },
  { key: 'vp_value',          name: 'Volume-profile rotation', compute: computeVpValue,     defaultOn: true,  pendingCapable: false },
  { key: 'rsi2_reversion',    name: 'RSI-2 reversion (high win)', compute: computeRsi2,      defaultOn: true,  pendingCapable: false },
  { key: 'fib_confluence',    name: 'Fib confluence zone', compute: computeFibConfluence,   defaultOn: true,  pendingCapable: false },
  { key: 'va_breakout',       name: 'Value-area breakout', compute: computeVaBreakout,      defaultOn: true,  pendingCapable: false },
]

export const STRATEGY_KEYS = STRATEGY_REGISTRY.map(s => s.key)

// Per-strategy R:R floor overrides. Most strategies inherit the global risk
// floor (1.5). A HIGH-WIN-RATE mean-reversion strategy deliberately runs a
// small R:R — forcing 1.5 on it would veto its entire edge — so it declares a
// lower floor here, honoured by BOTH the live risk gate (risk.js) and the
// backtest driver (backtest-fib.js). Absent key → use the caller's default.
export const STRATEGY_MIN_RR = {
  rsi2_reversion: 1.0,
}

/** R:R floor for a strategy: its override, else the provided fallback. */
export function minRrFor(strategyKey, fallback) {
  const v = STRATEGY_MIN_RR[strategyKey]
  return typeof v === 'number' ? v : fallback
}

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
 * - missing or corrupt state → the defaultOn set (owner 2026-07-27: all
 *   strategies except fib_618_fade — see the registry comment above).
 * - every strategy, INCLUDING fib, is a normal toggle (owner decision
 *   2026-07-10: forcing fib on made unwanted fib trades unavoidable when
 *   running other strategies alone). An empty list is legal — the scan
 *   finds nothing and says so, it does not invent a base.
 *   Pending-order mode still requires fib to be armed for its combos, but
 *   that is enforced where pending setups are scanned, not here — with fib
 *   defaulted off, pending-order mode needs fib armed explicitly to use it.
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
