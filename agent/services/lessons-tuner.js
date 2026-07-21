// ---------------------------------------------------------------------------
// agent/services/lessons-tuner.js — close the learning loop.
//
// The postmortem sweep classifies every loss (stop_hunt / thesis_wrong /
// chop). This tuner ACTS on the pattern (owner: "are you going to bake into a
// new/amend strategy?"):
//
//   ≥60% of a strategy's last 10 classified losses are STOP HUNTS
//     → widen that strategy's stop distance by 1.3× at proposal time.
//       The direction was right and the stop kept getting swept — wider
//       stop, same risk budget (risk-based sizing automatically ships
//       FEWER lots on a wider stop, so $ risk per trade is unchanged).
//
// Deliberately conservative: one fixed factor (no compounding), recomputed
// from the evidence on every sweep so it CLEARS itself when the pattern
// stops, and every application is stamped into the trade's sizing note so
// the audit trail shows exactly when the tuner touched a trade.
//
// thesis_wrong / chop patterns get NO auto-action on purpose — a wrong idea
// needs re-backtesting or disarming (human calls), not a knob.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const STOP_HUNT_LOOKBACK = 10   // last N classified losses per strategy
export const STOP_HUNT_MIN = 6         // ≥N of them stop_hunt → widen
export const SL_WIDEN_FACTOR = 1.3

/**
 * Recompute per-strategy SL-widen factors from postmortem evidence. Pure
 * read; returns { [strategy]: { factor, evidence } } for strategies whose
 * recent losses are dominated by stop hunts.
 */
export function computeSlWidenFactors(db) {
  const out = {}
  let strategies = []
  try {
    strategies = db.prepare(
      `SELECT DISTINCT strategy FROM trade_postmortems WHERE strategy IS NOT NULL`
    ).all().map(r => r.strategy)
  } catch { return out }
  for (const s of strategies) {
    const recent = db.prepare(
      `SELECT classification FROM trade_postmortems
       WHERE strategy = ? AND classification IN ('stop_hunt','thesis_wrong','chop')
       ORDER BY id DESC LIMIT ?`
    ).all(s, STOP_HUNT_LOOKBACK)
    if (recent.length < STOP_HUNT_LOOKBACK) continue // not enough evidence yet
    const hunts = recent.filter(r => r.classification === 'stop_hunt').length
    if (hunts >= STOP_HUNT_MIN) {
      out[s] = {
        factor: SL_WIDEN_FACTOR,
        evidence: `${hunts}/${recent.length} recent losses were stop hunts`,
      }
    }
  }
  return out
}

/** Persist the current factors (called from the loop after each postmortem sweep). */
export function refreshLessonTuning(db) {
  const factors = computeSlWidenFactors(db)
  setState(db, 'lesson_sl_widen_json', JSON.stringify(factors))
  return factors
}

/** Load the active factors. */
export function loadLessonTuning(db) {
  try { return JSON.parse(getState(db, 'lesson_sl_widen_json') || '{}') || {} } catch { return {} }
}

/**
 * Apply the tuner to one signal BEFORE the risk gate: widen the SL away from
 * entry by the strategy's factor. TP untouched (targets sit at structure) —
 * R:R drops accordingly and the min-RR gate still applies, which is honest:
 * a setup that can't afford a survivable stop shouldn't trade. Returns the
 * (possibly) adjusted signal plus a note for the audit trail.
 */
export function applySlWiden(signal, factors) {
  const f = factors?.[signal?.strategy]?.factor
  if (!(f > 1) || signal?.sl == null || signal?.entry == null) return { signal, note: null }
  const dist = Math.abs(signal.entry - signal.sl)
  if (!(dist > 0)) return { signal, note: null }
  const dir = signal.sl < signal.entry ? -1 : 1 // long: SL below entry
  const newSl = signal.entry + dir * dist * f
  return {
    signal: { ...signal, sl: newSl },
    note: `lesson_tuner: SL widened ×${f} (${factors[signal.strategy].evidence})`,
  }
}
