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
//   - a TIME CAP of `capMinutes` WALL-CLOCK minutes stamped at fill when the
//     signal declares no cap of its own (originally capBars × the entry
//     timeframe; re-based to wall-clock 01-09-2026 — the owner ruled that a
//     timeframe describes the bars a signal looked BACK on and must never
//     become a forward hold horizon);
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
import { familyOf } from './strategies.js'

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
/**
 * The managed ruleset, applied wherever a position of a governed account is
 * evaluated. On managed accounts the peak-based trail is the ONLY
 * exit-timing rule: the legacy ladder (bank target, partial, runner,
 * breakeven) is silenced BY RULE VALUES, not deleted — non-managed accounts
 * keep the full ladder, and flipping managed_exit_json off restores it
 * everywhere. Signal-owned theses (time caps, invalidation) still fire.
 *
 * ONE helper for EVERY evaluator, extracted 2026-08-31 after the 0016.HK
 * close: the merge lived inline in loop.js's monitorOnePosition only, while
 * fast-monitor.js evaluated the same positions every 30s with the raw
 * per-symbol rules — so bank_target_4R took the exit one minute after HK
 * open and the managed trail never got to answer. A rule silenced at one of
 * two call sites is failure mode #3 wearing #4's clothes.
 */
export function applyManagedRules(db, accountId, rules, { strategy = null } = {}) {
  if (!managedExitApplies(db, accountId)) return rules
  const policy = loadManagedExit(db)
  return {
    ...rules,
    alwaysTrailR: policy.trailR,
    // takeAtR rides the bank-target rule: FULL_EXIT once R reaches it, the
    // trail answering below. 0 keeps the trail as the only exit. SCOPED BY
    // FAMILY (owner 07-09-2026, "scope takeAtR to mean reversion"): the
    // whole-position take exists because reversion setups measured ~40%
    // touching +1R and nothing reaching +1.5R — a fact about REVERSION, not
    // about trends. A trend or breakout entry taken whole at +1R is the
    // momentum tail cut off at the root. So only positions whose strategy
    // family is listed get the take; every other family, and a position
    // with no strategy on record (manual, external), keeps the trail alone.
    bankTriggerR: takeAtRFor(policy, strategy),
    partialTriggerR: Infinity,
    runnerTriggerR: Infinity,
    beTriggerR: Infinity,
  }
}

/**
 * The R at which THIS position is taken whole, or 0 for trail-only. Pure:
 * the policy's takeAtR applies only when the strategy's family is in
 * takeAtRFamilies. Unknown strategy → no family → 0.
 */
export function takeAtRFor(policy, strategy) {
  if (!(policy.takeAtR > 0)) return 0
  const fam = strategy ? familyOf(strategy) : null
  return fam && policy.takeAtRFamilies.includes(fam) ? policy.takeAtR : 0
}

// capMinutes replaced capBars on 01-09-2026 (owner: "15m/1h/4h look BACK at
// historical bars — they are not a future interval. Correct that"). The old
// knob multiplied a bar count by the SIGNAL'S TIMEFRAME, so the policy's
// hold deadline was derived from a lookback parameter — the exact semantic
// the owner ordered out. The cap is now one wall-clock number, minutes from
// fill, timeframe-blind. 0 = no policy cap (the shipped default since the
// trail-distance sweep measured every cap variant below the trail alone).
// A legacy stored capBars is IGNORED, loudly: converting it would need a
// timeframe, which is the dependency being removed.
export const MANAGED_EXIT_DEFAULTS = Object.freeze({
  on: true,
  demoOnly: false,
  capMinutes: 0,
  trailR: 0.5,
  // TAKE THE WHOLE POSITION at this R (owner "do the different exit",
  // 03-09-2026, §7,272·C). Measured on the 79 clean burn-in closes of the
  // last 30 days: realised R quartiles −0.30 / −0.10 / −0.02, about 60% of
  // trades touch +0.5R and about 40% touch +1R, and nothing reaches +1.5R or
  // +2R often enough to measure — the trail alone gave those touches back.
  // Rides the existing bank-target rule (FULL_EXIT at R ≥ bankTriggerR), so
  // the trail still governs below it. 0 = off (trail only, as before).
  takeAtR: 1.0,
  // Families the take applies to. Measured basis above is reversion-only;
  // trend, breakout and momentum entries keep the trail as their sole exit.
  takeAtRFamilies: ['mean_reversion'],
})

/** Stored overrides ← defaults. Junk in state degrades to the defaults. */
export function loadManagedExit(db) {
  let stored = {}
  try { stored = JSON.parse(getState(db, 'managed_exit_json') || '{}') || {} } catch { stored = {} }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  // capMinutes is the one knob where 0 is a VALUE (no policy cap), not junk —
  // `num()` treating 0 as invalid was exactly the guard-out-of-reach shape:
  // a cap you could configure but never turn off.
  const capMinutes = Number(stored.capMinutes)
  if (stored.capBars != null && Number(stored.capBars) > 0 && !(capMinutes > 0)) {
    console.warn('[managed-exit] stored capBars is retired and IGNORED — set capMinutes (wall-clock) in managed_exit_json instead')
  }
  return {
    on: stored.on !== undefined ? stored.on === true : MANAGED_EXIT_DEFAULTS.on,
    demoOnly: stored.demoOnly !== undefined ? stored.demoOnly !== false : MANAGED_EXIT_DEFAULTS.demoOnly,
    capMinutes: Number.isFinite(capMinutes) && capMinutes >= 0 ? capMinutes : MANAGED_EXIT_DEFAULTS.capMinutes,
    trailR: num(stored.trailR, MANAGED_EXIT_DEFAULTS.trailR),
    // 0 is a VALUE here too (trail only); junk degrades to the default.
    takeAtR: Number.isFinite(Number(stored.takeAtR)) && Number(stored.takeAtR) >= 0 ? Number(stored.takeAtR) : MANAGED_EXIT_DEFAULTS.takeAtR,
    // An explicit array REPLACES the default (an empty array means the take
    // reaches no family at all — a value, not junk); anything else degrades.
    takeAtRFamilies: Array.isArray(stored.takeAtRFamilies)
      ? stored.takeAtRFamilies.map(f => String(f))
      : [...MANAGED_EXIT_DEFAULTS.takeAtRFamilies],
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
 * The cap timestamp for a fill at `nowMs`: wall-clock minutes, no timeframe
 * input at all — a timeframe describes the bars a signal was computed on,
 * never how long the position may live (owner, 01-09-2026).
 */
export function managedCapAt(nowMs, capMinutes) {
  return new Date(nowMs + Number(capMinutes) * 60_000).toISOString()
}
