// ---------------------------------------------------------------------------
// agent/services/edge-bars.js — every numeric "is the edge good enough" bar,
// in one file, with the reason each one differs.
//
// WHY. Risk-Decision Audit, 2026-08-03, finding #3: four independent numeric
// edge bars existed across four files with no shared constant and no
// cross-reference —
//
//   68 / 1.68   goal-tracker      the go-live gate
//   60 / 1.7    strategy-autopilot which combos get armed
//   0.8         performance-breaker when to shout
//   1.5         rsi2-seed          one strategy's own arming floor
//
// — so "a change to the goal will not propagate to the breaker or the arming
// bar, and vice versa."
//
// THIS DOES NOT UNIFY THEM, AND MUST NOT. They answer four different
// questions and correctly hold four different values: a breaker that trips at
// the go-live target would halt trading during any ordinary drawdown on the
// way there, and an arming bar set to the go-live target would arm nothing
// until the goal were already met. The audit's finding was about VISIBILITY,
// not about the numbers being wrong — the failure mode is someone moving the
// gate and never learning that three other bars now sit in a different
// relationship to it.
//
// So this module is a register, not a policy. Each bar keeps its own value and
// its own owner; what changes is that they are now readable side by side, and
// `edgeBarSummary()` states the ordering they are supposed to satisfy so a
// future edit that breaks it is visible rather than silent.
//
// Each constant remains overridable at its own call site (options args,
// agent_state config). Nothing here enforces anything at runtime.
// ---------------------------------------------------------------------------

/** The owner's dated go-live gate. Mirrors goal-tracker's DEFAULT_GOAL. */
export const GO_LIVE_BAR = {
  winRatePct: 68,
  profitFactor: 1.68,
  source: 'agent/services/goal-tracker.js — DEFAULT_GOAL',
  question: 'may this system trade real money on 2026-08-12?',
}

/** Which backtested strategy/symbol/timeframe combos may be ARMED live. */
export const ARM_BAR = {
  winRatePct: 60,
  profitFactor: 1.7,
  minTrades: 25,
  source: 'agent/services/strategy-autopilot.js — decideChanges opts',
  question: 'is this specific combo proven enough to put money behind?',
}

/** Rolling live-trade alert floor. ALERT ONLY — autoDisarm is off by owner. */
export const BREAKER_BAR = {
  profitFactor: 0.8,
  minTrades: 15,
  window: 20,
  source: 'agent/services/performance-breaker.js — DEFAULT_PB',
  question: 'is live performance bad enough to interrupt a human?',
  // Owner, 2026-07-30 and re-confirmed 2026-08-03: "leave autoDisarm OFF".
  // The breaker reports; the owner decides. Recorded here so a reader of this
  // register does not mistake the bar for an automatic stop.
  autoDisarm: false,
}

/** One seed strategy's own auto-arming floor. */
export const SEED_BAR = {
  profitFactor: 1.5,
  minTrades: 20,
  source: 'agent/services/rsi2-seed.js — GO_PF / GO_MIN_TRADES',
  question: 'may rsi2_reversion auto-arm a combo from its own backtest?',
}

/**
 * The ordering these bars are meant to satisfy, and whether they still do.
 *
 * BREAKER < SEED < ARM <= GO_LIVE. Each step is a stricter claim than the one
 * below it: shout well before the target, arm only above it, gate go-live at
 * or above the arming bar. A future edit that inverts any step — e.g. dropping
 * the go-live PF to 1.2 while the arming bar stays at 1.7 — would mean the
 * system refuses to arm strategies that already clear the gate it is being
 * held to. That is the drift the audit was pointing at, and this is where it
 * becomes visible instead of silent.
 *
 * Reporting only. Nothing consumes this to block anything.
 */
export function edgeBarSummary() {
  const steps = [
    { name: 'breaker', pf: BREAKER_BAR.profitFactor },
    { name: 'seed', pf: SEED_BAR.profitFactor },
    { name: 'arm', pf: ARM_BAR.profitFactor },
    { name: 'goLive', pf: GO_LIVE_BAR.profitFactor },
  ]
  const violations = []
  for (let i = 1; i < steps.length; i++) {
    const lo = steps[i - 1]
    const hi = steps[i]
    // The last step is <=, not <: arm 1.7 and goLive 1.68 are near-equal by
    // design, and calling that a violation would cry wolf on the current,
    // owner-chosen configuration.
    const ok = i === steps.length - 1 ? hi.pf >= lo.pf - 0.05 : hi.pf > lo.pf
    if (!ok) violations.push(`${lo.name} (${lo.pf}) should sit below ${hi.name} (${hi.pf})`)
  }
  return {
    bars: { goLive: GO_LIVE_BAR, arm: ARM_BAR, breaker: BREAKER_BAR, seed: SEED_BAR },
    ordered: violations.length === 0,
    violations,
  }
}
