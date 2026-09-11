// ---------------------------------------------------------------------------
// agent/services/direction-policy.js — ONE direction rule, every consumer
// (PR-D, owner principle 8, 11-09-2026: "trade direction is key for
// trending / momentum trading"; decision: shorts on the momentum book under
// the 9/10 conviction floor with regime-gate alignment).
//
// Before this file the short rule (a short must earn 1.5× a long's
// conviction) lived only in momentum-shadow.js, where nothing is placed, and
// the book discarded every short row it read. The rule now lives here and
// the shadow imports it, so the floor the shadow logs a refusal against is
// the floor the book places against — one number, two readers.
//
// `directionFor` is pure: side, conviction, the symbol's trend reading and
// the shadow config in; { ok, reason } out. The trend reading is whatever
// `regimes.trend_direction` holds — the regime writer (services/regime.js)
// emits 'long' | 'short' | null, and 'up' | 'down' are accepted as the same
// two answers so a caller spelling it either way gets one verdict.
// ---------------------------------------------------------------------------

import { loadRegimeGateConfig, latestRegime } from './regime-gate.js'

/** The shadow's own defaults, so a caller with no config gets the 6 × 1.5 = 9 floor. */
export const DEFAULT_DIRECTION_CFG = Object.freeze({ longMinConviction: 6, shortConvictionMult: 1.5 })

/** 'up' | 'down' | null from any spelling the regime table or a caller may use. */
export function normaliseTrend(t) {
  const s = t == null ? '' : String(t).toLowerCase()
  if (s === 'up' || s === 'long' || s === 'bull') return 'up'
  if (s === 'down' || s === 'short' || s === 'bear') return 'down'
  return null
}

/**
 * The short floor the owner's rule implies: longMin × mult, capped at the
 * 0–10 scale. When the product exceeds 10 the rule is unreachable on this
 * scale and `shortRuleAboveScale` says so rather than silently refusing every
 * short. (Lifted from momentum-shadow.js, PR-D.)
 */
export function shortMinConviction(cfg = DEFAULT_DIRECTION_CFG) {
  const longMin = Number(cfg?.longMinConviction ?? DEFAULT_DIRECTION_CFG.longMinConviction)
  const mult = Number(cfg?.shortConvictionMult ?? DEFAULT_DIRECTION_CFG.shortConvictionMult)
  const raw = longMin * mult
  return { shortMin: Math.min(10, Math.ceil(raw)), raw, shortRuleAboveScale: raw > 10 }
}

/**
 * May this side be taken at this conviction under this trend?
 *   long  → conviction ≥ longMinConviction
 *   short → conviction ≥ shortMinConviction AND a trend reading that is
 *           not 'up'. NO READING REFUSES A SHORT (checker, 11-09-2026:
 *           regimes are computed for scanned symbols only, so for most of
 *           the momentum universe "unknown" was the ordinary case and the
 *           alignment was decorative) — "unknown is not a reading", the
 *           fade branch's own rule. Longs are unchanged by the reading.
 * Pure. `reason` is the machine string the entry carries as its
 * direction_reason when ok, or the refusal reason when not.
 */
export function directionFor({ side, conviction, trendDirection = null, cfg = DEFAULT_DIRECTION_CFG } = {}) {
  const c = conviction == null || conviction === '' ? NaN : Number(conviction) // null is ABSENT, never 0
  const trend = normaliseTrend(trendDirection)
  const longMin = Number(cfg?.longMinConviction ?? DEFAULT_DIRECTION_CFG.longMinConviction)
  if (side === 'long') {
    if (!(c >= longMin)) return { ok: false, side, reason: `long_floor: conviction ${Number.isFinite(c) ? c : '?'} < ${longMin}`, trend }
    return { ok: true, side, reason: `tsmom:long conviction ${c} ≥ ${longMin}${trend ? ` trend ${trend}` : ''}`, trend }
  }
  if (side === 'short') {
    const { shortMin } = shortMinConviction(cfg)
    if (!(c >= shortMin)) {
      return { ok: false, side, reason: `short_rule: conviction ${Number.isFinite(c) ? c : '?'} < ${shortMin} (${longMin}×${Number(cfg?.shortConvictionMult ?? DEFAULT_DIRECTION_CFG.shortConvictionMult)})`, trend }
    }
    if (trend === 'up') return { ok: false, side, reason: `direction_against_trend: short into an up-trend (conviction ${c})`, trend }
    if (trend !== 'down') return { ok: false, side, reason: `direction_no_trend_reading: a short needs a fresh trend reading and this name has none (conviction ${c})`, trend }
    return { ok: true, side, reason: `tsmom:short conviction ${c} ≥ ${shortMin} trend down`, trend }
  }
  return { ok: false, side, reason: `direction_unknown: side ${side == null ? 'missing' : String(side)}`, trend }
}

/**
 * Which order sides a symbol may be entered on under its trend reading:
 * up → BUY only, down → SELL only, unknown → both. Pure; the tick permit
 * feeder uses it to withhold the against-trend side's permit.
 */
export function permittedSides(trendDirection) {
  const t = normaliseTrend(trendDirection)
  if (t === 'up') return ['BUY']
  if (t === 'down') return ['SELL']
  return ['BUY', 'SELL']
}

/**
 * The trend reading an entry path may act on — ONE reader for the book, the
 * account pass and the tick feeder (checker, 11-09-2026: three private
 * copies hard-coded the 240-minute bound and ignored the owner's
 * regime_gate_json). The age bound is the gate's `maxRegimeAgeMin`; with
 * the gate switched OFF there is no reading (null), so a short is refused
 * rather than gated on a table the owner has turned off. Stale → null.
 */
export function trendReadingFor(db, symbol) {
  try {
    const cfg = loadRegimeGateConfig(db)
    if (!cfg.on) return null
    const row = latestRegime(db, symbol, { maxAgeMin: cfg.maxRegimeAgeMin })
    return row && !row.stale ? (row.trend_direction ?? null) : null
  } catch { return null }
}
