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

// One Simple System (owner 28-08-2026, "proceed as plan", win-rate goal
// > 69%): the trail-distance sweep over the same 44-trade population put
// trail_0.5R at PF 2.41 / expectancy +0.387R / WR 69.2% — the highest win
// rate and PF of every distance tested (0.75R won expectancy at +0.478R;
// 1R measured 1.82 / 50%). capBars moved to 0: the sweep's trail figures
// were measured WITHOUT a cap, and every cap variant scored below the
// trail alone. Both remain one state write away in managed_exit_json.
// demoOnly false (owner 28-08-2026: "why only demo? i stressed it should be
// regardless of account") — the trail governs every REGISTERED account,
// live included. The registry check below still fails closed for accounts
// it cannot identify.
export const MANAGED_EXIT_DEFAULTS = Object.freeze({
  on: true,
  demoOnly: false,
  capBars: 0,
  trailR: 0.5,
})

/** Stored overrides ← defaults. Junk in state degrades to the defaults. */
export function loadManagedExit(db) {
  let stored = {}
  try { stored = JSON.parse(getState(db, 'managed_exit_json') || '{}') || {} } catch { stored = {} }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  // capBars is the one knob where 0 is a VALUE (no policy cap), not junk —
  // `num()` treating 0 as invalid was exactly the guard-out-of-reach shape:
  // a cap you could configure but never turn off.
  const capBars = Number(stored.capBars)
  return {
    on: stored.on !== undefined ? stored.on === true : MANAGED_EXIT_DEFAULTS.on,
    demoOnly: stored.demoOnly !== undefined ? stored.demoOnly !== false : MANAGED_EXIT_DEFAULTS.demoOnly,
    capBars: Number.isFinite(capBars) && capBars >= 0 ? capBars : MANAGED_EXIT_DEFAULTS.capBars,
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
  if (accountId == null) return false
  try {
    const row = db.prepare('SELECT is_live FROM accounts WHERE account_id = ?').get(String(accountId))
    // The registry check is UNCONDITIONAL: with demoOnly off the policy
    // reaches live accounts, but never an account it cannot identify.
    // (`!c.demoOnly → return true` used to sit above the null/registry
    // checks, so widening the scope would also have widened it to
    // unattributable rows — fail-closed must not depend on which scope is
    // configured.)
    if (!row) return false
    return c.demoOnly ? Number(row.is_live) === 0 : true
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
