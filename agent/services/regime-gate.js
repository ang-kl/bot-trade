// ---------------------------------------------------------------------------
// agent/services/regime-gate.js — don't fade a trend, don't chase a range.
//
// Owner (2026-07-20, Net P&L −$2019, PF 0.15): "you seem to be trading like a
// beginner and not a chief trader." Root cause found: the `regimes` table
// computes trending/volatile/ranging/quiet per symbol every 30 min, but that
// value was ONLY ever used to label trades and fill dashboards — it never
// gated an entry. So the Fib 61.8% FADE (a counter-trend, level-reaction
// strategy) fired into strong trends and whipsaws where its levels get blown
// straight through: −$973 over 12 Fib trades, −$823 over 2 EMA trades.
//
// This gate matches each strategy's KIND to the regime:
//   mean-reversion (fib fade, rsi) — wants RANGING/QUIET; blocked in VOLATILE
//     (whipsaw destroys level reactions) and in a TRENDING regime whose
//     direction OPPOSES the signal (fading a live trend is the classic
//     account-killer).
//   trend/breakout (ema pullback, donchian, cup&handle) — wants a TREND;
//     blocked in QUIET (no trend to ride; breakouts there are fakeouts).
//
// Unknown regime (not computed yet) never blocks — fail open, same as the
// rest of the risk chain. Fully toggleable; on by default given the
// evidence, because shipping it off would leave the bleed unaddressed.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DEFAULT_REGIME_GATE = { on: true }

// Strategy kind — the only thing the gate needs to know about each strategy.
export const STRATEGY_KIND = {
  fib_618_fade: 'meanrev',
  rsi_meanrev: 'meanrev',
  ema_pullback: 'trend',
  donchian_breakout: 'trend',
  cup_handle: 'trend',
}

export function loadRegimeGateConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'regime_gate_json') || 'null')
    if (parsed && typeof parsed === 'object') return { on: parsed.on !== false }
  } catch { /* corrupt — default */ }
  return { ...DEFAULT_REGIME_GATE }
}

/** Latest regime row for a symbol, or null. */
export function latestRegime(db, symbol) {
  try {
    return db.prepare(
      `SELECT regime, trend_direction FROM regimes WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1`
    ).get(symbol) || null
  } catch { return null }
}

/**
 * Should this signal be blocked by the current regime? Pure decision — no DB.
 *
 * @param {string} strategy  strategy key
 * @param {'long'|'short'} bias  signal direction
 * @param {{regime?:string, trend_direction?:string}|null} regimeRow
 * @returns {{block:boolean, reason?:string}}
 */
export function regimeBlocks(strategy, bias, regimeRow) {
  const kind = STRATEGY_KIND[strategy]
  const regime = regimeRow?.regime || null
  if (!kind || !regime) return { block: false } // unknown → fail open

  if (kind === 'meanrev') {
    if (regime === 'volatile') {
      return { block: true, reason: `regime_block meanrev-in-volatile (${strategy}): whipsaw blows through fade levels` }
    }
    if (regime === 'trending') {
      const trendDir = regimeRow.trend_direction // 'long' | 'short' | null
      // Fading AGAINST a live trend — the classic account-killer. A fade
      // that agrees with the trend direction is fine (buying a dip in an
      // uptrend). Unknown trend direction on a trending regime → block, since
      // a fade into an unqualified trend is the risky default.
      if (!trendDir || trendDir !== bias) {
        return { block: true, reason: `regime_block fade-vs-trend (${strategy}): ${bias} fade into a ${trendDir || 'unknown'}-trending market` }
      }
    }
    return { block: false }
  }

  // trend / breakout strategies
  if (regime === 'quiet') {
    return { block: true, reason: `regime_block trend-in-quiet (${strategy}): no trend to ride, breakouts fake out` }
  }
  return { block: false }
}

/** DB-backed convenience: look up the regime and decide. */
export function checkRegimeGate(db, strategy, bias, symbol) {
  const cfg = loadRegimeGateConfig(db)
  if (!cfg.on) return { block: false }
  return regimeBlocks(strategy, bias, latestRegime(db, symbol))
}
