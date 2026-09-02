// ---------------------------------------------------------------------------
// agent/services/management-state.js — what state is this position in, and who
// is allowed to move it?
//
// Operating Goal Plan §40 (management state machine) and §41 (authority
// hierarchy), as code rather than as prose.
//
// WHY. docs/position-write-authority.md establishes that six components can
// write a stop and eight can close a position, and that §41's eight-level
// hierarchy is encoded nowhere. Today they do not collide only because each
// module's own filter happens not to overlap the others — profit-keeper
// tightens toward profit, loss-guardian acts only on a position with NO stop,
// trade-guard only on positions carrying operator rules. That separation is
// convention. It is not enforced, it is not written down anywhere the code can
// read, and the first filter that widens turns it into a race.
//
// This module is the shared vocabulary those writers currently lack. It is
// deliberately PURE — no database, no broker, no clock of its own — so it can
// be reasoned about and tested exhaustively before anything depends on it.
//
// SCOPE, HONESTLY. Defining the machine does not by itself make the writers
// obey it; wiring each writer to consult it is the larger and riskier half,
// and it is deliberately NOT in this file. What this gives is a single
// definition to wire them TO, and a `status` richer than the active/closed
// that monitored_positions carries today.
// ---------------------------------------------------------------------------

/**
 * §40's happy path, in order. A position advances through these; it does not
 * skip backwards except through an explicit exception.
 */
export const STATES = Object.freeze([
  'filled',                 // broker confirms the fill, protection not yet verified
  'protection_pending',     // bracket requested, not yet confirmed at the broker
  'protected',              // broker-side stop confirmed — §36.1's Layer 0 is live
  'actively_managed',       // a management layer has authority and is watching
  'risk_reduced',           // stop moved to breakeven or better
  'partial_profit_taken',   // some volume closed at a target
  'runner_managed',         // remainder held under trailing rules
  'exit_requested',         // a close was sent, broker has not confirmed
  'broker_closed',          // broker confirms flat
  'reconciled',             // transferred to WS-06, economics settled
])

/**
 * §40's exception states. These are NOT failures of the machine — they are the
 * machine reporting a condition that the happy path cannot describe. Each one
 * exists because it was observed in production at least once.
 */
export const EXCEPTIONS = Object.freeze([
  'naked',                  // open with no broker stop (the ETHUSD short, 2026-07-29)
  'stale_price',            // quote stopped moving while its market was open
  'broker_unavailable',     // the sidecar reconnect loop, 2026-08-04
  'amend_uncertain',        // stop amend sent, result unknown
  'conflicting_authority',  // two writers acted inside the same window
  'manual_intervention',    // the owner acted at the broker directly
  'margin_emergency',       // margin level below the floor
  'exit_uncertain',         // close sent, broker neither confirmed nor refused
  'locally_closed_broker_open',  // our books say flat, the broker does not
  'broker_closed_locally_open',  // the broker says flat, our books do not
])

/** §41, highest authority first. Lower index wins a conflict. */
export const AUTHORITIES = Object.freeze([
  'broker_native',          // 1 — the broker's own SL/TP
  'emergency_control',      // 2 — loss cap, profit ratchet, equity stop
  'tick_safety',            // 3 — the C++ TrailEngine
  'fast_manager',           // 4 — profit keeper, trade guards, loss guardian
  'per_minute_policy',      // 5 — §70.4, does not exist yet
  'bar_close_strategy',     // 6 — restrategize, weekend bank
  'human_owner',            // 7 — /actions/*, Telegram
  'reconciliation',         // 8 — the reconciler correcting the record
])

/** Which authority each known writer holds. Mirrors docs/position-write-authority.md. */
export const WRITER_AUTHORITY = Object.freeze({
  'cpp-trail-engine': 'tick_safety',
  'loss-cap': 'emergency_control',
  'profit-ratchet': 'emergency_control',
  'profit-keeper': 'fast_manager',
  'trade-guard': 'fast_manager',
  'loss-guardian': 'fast_manager',
  'restrategize': 'bar_close_strategy',
  'weekend-bank': 'bar_close_strategy',
  'position-protect': 'human_owner',
  'reconciler': 'reconciliation',
})

/**
 * The same mapping again, keyed by the `source` string that actually appears in
 * `position_events`.
 *
 * WHY A SECOND TABLE. WRITER_AUTHORITY is keyed by module name, which is how
 * docs/position-write-authority.md talks about these components. The event
 * journal was written earlier and uses its own snake_case vocabulary, and some
 * of its sources are not modules at all — `manual` is a route, `telegram` is a
 * button, `position_manager` is the loop's default `source` argument to
 * executeBrokerAction. Every entry below was taken from a call site, not
 * guessed: see recordPositionEvent's callers in loop.js, profit-keeper.js,
 * loss-cap.js, position-protect.js and routes/actions.js.
 */
export const EVENT_SOURCE_AUTHORITY = Object.freeze({
  manual: 'human_owner',                  // routes/actions.js → protectPosition
  telegram: 'human_owner',                // telegram-control.js Set-TP button
  loss_cap: 'emergency_control',
  profit_ratchet: 'emergency_control',
  equity_stop: 'emergency_control',       // loop.js:3573
  cpp_trail_engine: 'tick_safety',
  profit_keeper: 'fast_manager',
  trade_guard: 'fast_manager',
  loss_guardian: 'fast_manager',
  fast_monitor: 'fast_manager',           // fast-monitor.js:239
  session_open_guard: 'fast_manager',     // session-open-guard.js:117
  position_manager: 'bar_close_strategy', // executeBrokerAction's default
  llm_monitor: 'bar_close_strategy',      // loop.js:1698
  restrategize: 'bar_close_strategy',
  weekend_bank: 'bar_close_strategy',
  reconciler: 'reconciliation',
})

/**
 * §70.6 — "ensure rapid markets use tick or event-driven safeguards."
 *
 * WHY THIS IS PER RULE AND NOT PER MODULE. The trigger was always chosen per
 * MODULE, and the rules inside one module do not share a shape. The profit
 * keeper's chandelier ratchet is a price crossing; its spike-tighten reads
 * COMPLETED BARS and cannot be evaluated any finer than the bar period. The
 * loss guardian's headline job — putting a stop on a naked position — is not a
 * price decision at all; it fires on a STATE. Running a whole module on ticks
 * because one of its rules is tick-shaped is how a bar rule gets evaluated on
 * a partial bar, and running it on a timer because one rule is slow is how a
 * price crossing waits sixty seconds.
 *
 * Values:
 *   'tick' — a price crossing a level. Belongs on a price trigger; the timer
 *            remains the backstop.
 *   'bar'  — needs a CLOSED bar. Evaluating it on a tick reads an incomplete
 *            candle and produces a verdict the rule did not earn.
 *   'poll' — an account aggregate, a position state, or elapsed time. Nothing
 *            about a single instrument's spot price moves it.
 *
 * `human` marks the two owner entry points, which have no cadence of their own.
 */
export const TRIGGERS = Object.freeze(['tick', 'bar', 'poll', 'human'])

/**
 * Every management rule, and the trigger it is entitled to.
 *
 * Keys are `<writer>:<rule>`. The writer half must exist in WRITER_AUTHORITY —
 * a rule whose writer is unknown has no authority, and a test enforces that.
 */
export const RULE_TRIGGER = Object.freeze({
  // ── trade-guard: three price crossings, nothing else. The purest
  // tick-shaped module of the five, and the cheapest — one broker call.
  'trade-guard:break_even': 'tick',
  'trade-guard:trailing': 'tick',
  'trade-guard:take_profit_ladder': 'tick',   // a limit order the bot emulates

  // ── profit-keeper: mixed, which is the whole reason this table exists.
  'profit-keeper:chandelier_ratchet': 'tick', // ALREADY in C++ (TrailEngine)
  'profit-keeper:chandelier_breach': 'tick',
  'profit-keeper:take_profit_usd': 'tick',
  'profit-keeper:arm': 'tick',                // slow threshold, price crossing
  'profit-keeper:giveback': 'tick',
  'profit-keeper:scale_out': 'tick',          // one-shot, gated on the arm
  'profit-keeper:spike_tighten': 'bar',       // completed bars — cannot go finer

  // ── loss-cap: one rule. Floating P&L is monotone in price for a fixed
  // position, so the cap is a synthetic stop. Now screened on every guardian
  // tick and escalated to the full reconcile-and-close pass only on a breach.
  'loss-cap:position_dollar_cap': 'tick',

  // ── loss-guardian: genuinely split, and the split is not what the module
  // name suggests. Only the "already blown through" branch is about price.
  'loss-guardian:naked_past_max_loss': 'tick',
  'loss-guardian:naked_stop': 'poll',         // fires on STATE: "there is no stop"
  'loss-guardian:time_cap': 'poll',           // elapsed hours; price-independent

  // ── profit-ratchet: every rule reads account equity or elapsed time.
  // Nothing here crosses a price, and its `confirmReads` hysteresis exists
  // SPECIFICALLY to suppress tick reactions — on 2026-08-01 06:39 UTC it
  // flattened an account off one 60-second equity read, and the fix was
  // hysteresis, not speed. Ticking these would have made that worse.
  'profit-ratchet:floor_advance': 'poll',
  'profit-ratchet:soft_band': 'poll',
  'profit-ratchet:hard_trip': 'poll',
  'profit-ratchet:auto_rearm': 'poll',

  // ── bar-close and owner layers, for completeness.
  'restrategize:bar_close_review': 'bar',
  'weekend-bank:session_close': 'poll',
  'position-protect:set_stop': 'human',
  'position-protect:set_target': 'human',
})

/** The trigger a rule is entitled to, or null when the rule is not classified. */
export function triggerForRule(key) {
  return RULE_TRIGGER[String(key ?? '')] ?? null
}

/** Every classified rule belonging to one writer. */
export function rulesForWriter(writer) {
  const prefix = `${writer}:`
  return Object.keys(RULE_TRIGGER).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
}

/** §41 level for a `position_events.source`, or null when the source is unknown. */
export function authorityForSource(source) {
  return EVENT_SOURCE_AUTHORITY[String(source ?? '')] ?? null
}

/** True when this event source is the owner acting directly — a route or a button. */
export function isOwnerSource(source) {
  return authorityForSource(source) === 'human_owner'
}

/**
 * True when this source is one of §41's capital-safety layers (levels 1–2).
 *
 * This is the ONE place §41.1's numbered list and §41.2's prose agree: capital
 * safety overrides the owner. Everything else that outranks `human_owner` does
 * so only because the numbered list says so — the §41.1-vs-§41.2 tension is
 * recorded in docs/position-write-authority.md — and that distinction is what
 * the minute review reports on.
 */
export function isCapitalSafetySource(source) {
  const a = authorityForSource(source)
  return a === 'broker_native' || a === 'emergency_control'
}

/** True when `state` is one of §40's exception states rather than a happy-path one. */
export const isException = (state) => EXCEPTIONS.includes(state)

