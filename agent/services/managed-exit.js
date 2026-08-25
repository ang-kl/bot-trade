// ─────────────────────────────────────────────────────────────────────────────
// Managed-exit policy (owner, 25-08-2026: "c1").
//
// The gated-entry counterfactual (39 clean non-probe trades, all 8 rules past
// the 30-trade floor) split cleanly: every managed exit was profitable
// (trail_1R PF 1.82, cap_30m 1.78, cap_120m 1.67) and both let-it-run
// variants lost (0.66), while the ACTUAL exits did worst of all (PF 0.44,
// -0.53R). The entries carry the edge; the deep holds were destroying it.
//
// The policy is two numbers, stated in one sentence each:
//   - a TIME CAP of `capBars` bars OF THE ENTRY TIMEFRAME (8 bars = 2h on a
//     15m chart, matching the cap_120m evidence) stamped at fill when the
//     signal declares no cap of its own — timeframe-scaled, not wall-clock,
//     which is the owner's "different timeframe for different positions";
//   - a TRAIL of `trailR` R behind the peak favorable excursion, active from
//     entry, tighten-only (matching the trail_1R replay).
//
// DEMO ONLY by default: this is the out-of-sample confirmation run — the next
// 30-50 gated trades measured forward before any live account hears about it.
// An account not in the registry is treated as NOT demo: the policy fails
// CLOSED away from live money.
//
// History note: position-manager deliberately removed its blanket default
// time cap on 2026-08-14 ("a clock on technical setups that were sized to a
// structure, not to a deadline") — a correct call against an ARBITRARY clock.
// This one is not arbitrary: it is the measured answer from the exit
// counterfactual, scaled to each setup's own timeframe, and reversible by
// flipping `on` in managed_exit_json.
// ─────────────────────────────────────────────────────────────────────────────

import { getState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'

export const MANAGED_EXIT_DEFAULTS = Object.freeze({
  on: true,
  demoOnly: true,
  capBars: 8,
  trailR: 1.0,
})

/** Stored overrides ← defaults. Junk in state degrades to the defaults. */
export function loadManagedExit(db) {
  let stored = {}
  try { stored = JSON.parse(getState(db, 'managed_exit_json') || '{}') || {} } catch { stored = {} }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    on: stored.on !== undefined ? stored.on === true : MANAGED_EXIT_DEFAULTS.on,
    demoOnly: stored.demoOnly !== undefined ? stored.demoOnly !== false : MANAGED_EXIT_DEFAULTS.demoOnly,
    capBars: num(stored.capBars, MANAGED_EXIT_DEFAULTS.capBars),
    trailR: num(stored.trailR, MANAGED_EXIT_DEFAULTS.trailR),
  }
}

/**
 * Does the policy govern this account's positions?
 * Unknown account → false (fails closed away from live money).
 */
export function managedExitApplies(db, accountId, cfg = null) {
  const c = cfg || loadManagedExit(db)
  if (!c.on) return false
  if (!c.demoOnly) return true
  if (accountId == null) return false
  try {
    const row = db.prepare('SELECT is_live FROM accounts WHERE account_id = ?').get(String(accountId))
    return !!row && Number(row.is_live) === 0
  } catch { return false }
}

/**
 * The cap timestamp for a fill at `nowMs` on a signal of `timeframe`.
 * Unknown timeframe falls back to 1h bars — a cap too long is still a cap.
 */
export function managedCapAt(nowMs, timeframe, capBars) {
  const ms = tfMs(timeframe) || 3_600_000
  return new Date(nowMs + capBars * ms).toISOString()
}
