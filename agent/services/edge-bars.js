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
// THE WIN-RATE HALVES OF THE FIRST TWO ARE GONE (first-principles audit,
// 2026-09-19, §K item 10): exit asymmetry sets expectancy, not entry accuracy,
// so win rate is measured and displayed everywhere but is never a bar — no
// entry in this register carries a `winRatePct`, and edge-bars.test.js turns
// red if one is re-introduced.
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
// its own owner; what changes is that they are now readable side by side.
// (`edgeBarSummary()`, which stated the ordering they were supposed to satisfy,
// had no caller and was deleted 02-09-2026, #815.)
//
// Each constant remains overridable at its own call site (options args,
// agent_state config). Nothing here enforces anything at runtime.
// ---------------------------------------------------------------------------

/** The owner's dated go-live gate. Mirrors goal-tracker's DEFAULT_GOAL. */
export const GO_LIVE_BAR = {
  profitFactor: 1.68,
  source: 'agent/services/goal-tracker.js — DEFAULT_GOAL',
  question: 'may this system trade real money on 2026-08-15?',
}

/** Which backtested strategy/symbol/timeframe combos may be ARMED live. */
export const ARM_BAR = {
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

