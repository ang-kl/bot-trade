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

// P8 / AUDIT F-L1-09, F-L2-04. `latestRegime` used to read the newest row for
// a symbol with NO AGE BOUND, so a verdict computed days ago kept gating
// today's entries as if it were fresh — the system would act on a regime datum
// of ANY age. The quant phase recomputes roughly every 30 minutes for symbols
// scanned in the last 6 hours, so anything older than a few hours means the
// symbol dropped out of that sweep and its regime is a fossil.
//
// A stale row is now treated as UNKNOWN, which this gate has always failed
// OPEN on (see the header). That is deliberately the SAME semantics the gate
// already applies to a symbol with no regime at all — no new way to block, and
// no pretending an ancient row is a current reading. `blockOnStaleRegime`
// flips it to fail CLOSED for an owner who wants the stricter posture; it
// defaults OFF because turning a fail-open gate into a fail-closed one is a
// risk-limit decision, not a bug fix.
export const DEFAULT_MAX_REGIME_AGE_MIN = 240
export const DEFAULT_REGIME_GATE = {
  on: true,
  maxRegimeAgeMin: DEFAULT_MAX_REGIME_AGE_MIN,
  blockOnStaleRegime: false,
}

// Strategy kind — the only thing the gate needs to know about each strategy.
export const STRATEGY_KIND = {
  fib_618_fade: 'meanrev',
  rsi_meanrev: 'meanrev',
  rsi2_reversion: 'meanrev', // Connors RSI(2) washout fade — ranges & aligned dips
  vp_value: 'meanrev',      // value-area edge fade — wants rotation, dies in trends
  fib_confluence: 'meanrev', // bounce/rejection off a confluence zone — same failure mode as vp_value
  ema_pullback: 'trend',
  donchian_breakout: 'trend',
  cup_handle: 'trend',
  inv_cup_handle: 'trend',
  vwap_trend: 'trend',      // VWAP pullback in a trend — dies in quiet chop
  va_breakout: 'trend',     // value-area edge giving way — a whipsaw range kills the pullback hold
  // A gap retrace is a CONTINUATION trade: the thesis is that the impulse
  // resumes once the imbalance is repaired. In a dead market gaps form on
  // noise and fill with no follow-through, which is exactly what 'trend'
  // keeps it out of.
  fvg_retrace: 'trend',
}

export function loadRegimeGateConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'regime_gate_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        ...DEFAULT_REGIME_GATE,
        ...parsed,
        on: parsed.on !== false,
      }
    }
  } catch { /* corrupt — default */ }
  return { ...DEFAULT_REGIME_GATE }
}

/**
 * Latest regime row for a symbol, or null.
 *
 * `maxAgeMin` bounds how old that row may be (P8 / F-L1-09). Rows past the
 * bound come back with `stale: true` and their `computed_at`, so the caller
 * can decide — and so a veto reason can say the reading was a fossil rather
 * than silently treating it as current. Pass 0 or null to disable the bound
 * (the pre-P8 behaviour, kept for callers that only want to display it).
 */
export function latestRegime(db, symbol, { maxAgeMin = DEFAULT_MAX_REGIME_AGE_MIN } = {}) {
  let row = null
  try {
    row = db.prepare(
      `SELECT regime, trend_direction, computed_at FROM regimes WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1`
    ).get(symbol) || null
  } catch { return null }
  if (!row) return null
  const bound = Number(maxAgeMin)
  if (!(bound > 0)) return row
  const t = Date.parse(String(row.computed_at || '').replace(' ', 'T') + (String(row.computed_at || '').endsWith('Z') ? '' : 'Z'))
  if (!Number.isFinite(t)) return { ...row, stale: true }
  const ageMin = (Date.now() - t) / 60_000
  return ageMin > bound ? { ...row, stale: true, ageMin: Math.round(ageMin) } : row
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
  const row = latestRegime(db, symbol, { maxAgeMin: cfg.maxRegimeAgeMin })
  if (row?.stale) {
    // P8: an ancient reading is not a reading. Fail open by default — the
    // same answer this gate gives a symbol with no regime at all — or block
    // when the owner has asked for the stricter posture.
    const age = row.ageMin != null ? `${row.ageMin}m old` : `computed_at unparseable`
    return cfg.blockOnStaleRegime
      ? { block: true, reason: `regime_block stale-regime (${strategy}): the newest regime for ${symbol} is ${age}, past the ${cfg.maxRegimeAgeMin}m bound — refusing to gate on a fossil` }
      : { block: false, staleRegime: true, ageMin: row.ageMin ?? null }
  }
  return regimeBlocks(strategy, bias, row)
}
