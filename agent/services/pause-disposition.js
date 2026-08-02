// A3 — what happens to an account's RESTING ENTRY ORDERS when it stops
// entering.
//
// docs/per-account-control-plan.md §4, and the owner's decision of 2026-07-28:
//
//   "default pending disposition should still be pending trade. and default is
//    to continue monitor until last one is traded or close if monitor deem
//    otherwise."
//
// A pending order is a resting instruction that will fire while nobody is
// watching — which is what makes this the sharp edge of pausing and why it
// gets an explicit choice rather than a default buried in code.
//
// ===========================================================================
// SCOPE LIMIT, STATED FIRST BECAUSE GETTING IT WRONG IS THE NAKED-POSITION BUG
// ===========================================================================
// This governs ENTRY orders only. Protective stop-loss and take-profit orders
// live broker-side against OPEN positions and are never touched by a pause.
// Cancelling those would leave real exposure unprotected, which is the exact
// failure the whole per-account-control plan exists to prevent. Nothing in
// this file selects a protective order: the planner only ever sees rows from
// `pending_orders`, the bot's own resting-entry ledger.
//
// ===========================================================================
// THE THREE DISPOSITIONS
// ===========================================================================
//
//   supervised-drain  (DEFAULT) pendings stay pending and stay MONITORED —
//                     until each is filled, or closed because the setup no
//                     longer holds. No new ones are created. The account goes
//                     quiet on its own once the last one resolves.
//   cancel            cancel this account's working entry orders now, logging
//                     each with its price so it can be re-armed.
//   keep              leave them armed and stop looking. Short pauses only.
//
// WHY supervised-drain BEATS cancel, which was the original recommendation.
// The argument for cancelling assumed pausing means UNWATCHED. It does not —
// §1 of the plan establishes that management never pauses, so the pending is
// not resting unsupervised: the monitor is still on it and can close it when
// the setup breaks. Cancelling would throw away committed analysis to avoid a
// risk the monitor already covers.
//
// ===========================================================================
// THE GUARD THAT KEEPS supervised-drain FROM DEGRADING INTO keep
// ===========================================================================
// A pending with no expiry and no invalidation trigger never resolves, so the
// account never goes quiet — and "drain" quietly becomes "keep". Every row
// therefore gets a DRAIN DEADLINE: its own `expires_at` if it has one, else
// the pause moment plus `drainHours` (default 24). Past that, the planner
// says cancel and names the deadline as the reason. The countdown is exposed
// so the UI can show it rather than the operator discovering it later.
//
// ===========================================================================
// "CLOSE IF THE MONITOR DEEMS OTHERWISE" NEEDS STATED CRITERIA
// ===========================================================================
// Otherwise it is a promise with no mechanism. The honest starting set is the
// invalidation signals that already exist, and each early close records WHICH
// one fired:
//
//   level_breached      a closed bar beyond the row's stop — the level the
//                       order was priced off no longer exists. (Already
//                       enforced in pending-orders.js; named here so the
//                       audit trail uses one vocabulary.)
//   drain_deadline      the row's expiry, or the drain window, has passed
//   strategy_disarmed   the edge watchdog or the operator disarmed the
//                       strategy this order belongs to
//   account_archived    the account was archived (only reachable while flat,
//                       so this is a belt-and-braces case)
//
// Signals the plan lists that are NOT implemented here are absent rather than
// faked: symbol cooldown / streak breaker and the news-window gate are
// evaluated at ENTRY time in the risk gate, not against a resting order, and
// wiring them would mean re-running the gate per pending per cycle. That is a
// real extension, not a line of glue, so it is named as a gap instead of
// being half-done. See UNIMPLEMENTED_SIGNALS.
import { getState } from '../db.js'
import { listAccounts } from './account-registry.js'
import { accountCapabilities } from './account-capabilities.js'

export const DISPOSITIONS = ['supervised-drain', 'cancel', 'keep']
export const DEFAULT_DISPOSITION = 'supervised-drain'
export const DEFAULT_DRAIN_HOURS = 24
export const STATE_KEY = 'pause_disposition_json'

export const INVALIDATION_SIGNALS = [
  'level_breached', 'drain_deadline', 'strategy_disarmed', 'account_archived',
]

/**
 * Signals the plan names that this slice does NOT evaluate. Exported so the
 * gap is greppable and cannot be mistaken for coverage.
 */
export const UNIMPLEMENTED_SIGNALS = ['symbol_cooldown', 'streak_breaker', 'news_window']

/**
 * The disposition for one account: its own params override, else the global
 * default, else supervised-drain. An unrecognised value falls back rather
 * than being obeyed — an unknown disposition must not become "keep" by
 * accident, since keep is the one that stops looking.
 */
export function dispositionFor(db, accountId) {
  const pick = (v) => (DISPOSITIONS.includes(v) ? v : null)
  let acctVal = null
  try {
    const row = listAccounts(db).find(a => String(a.account_id) === String(accountId))
    acctVal = pick(row?.params?.pauseDisposition)
  } catch { acctVal = null }
  if (acctVal) return acctVal
  let global = null
  try {
    const raw = getState(db, STATE_KEY)
    if (raw) global = pick(JSON.parse(raw)?.disposition)
  } catch { global = null }
  return global || DEFAULT_DISPOSITION
}

/** Drain window in hours: per-account override, else global, else 24. */
export function drainHoursFor(db, accountId) {
  const num = (v) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? x : null
  }
  try {
    const row = listAccounts(db).find(a => String(a.account_id) === String(accountId))
    const v = num(row?.params?.drainHours)
    if (v) return v
  } catch { /* fall through */ }
  try {
    const raw = getState(db, STATE_KEY)
    if (raw) {
      const v = num(JSON.parse(raw)?.drainHours)
      if (v) return v
    }
  } catch { /* fall through */ }
  return DEFAULT_DRAIN_HOURS
}

const parseStamp = (v) => {
  if (!v) return null
  const raw = String(v).replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : `${raw}Z`)
  return Number.isFinite(t) ? t : null
}

/**
 * The deadline by which a row must resolve, and where it came from.
 *
 * `placed_at` is the anchor for the drain window rather than "when the pause
 * happened", because the pause moment is not recorded per row and inventing
 * one would make the countdown a guess. Anchoring on placement is both
 * knowable and conservative: it can only bring the deadline forward.
 */
export function deadlineFor(row, { drainHours = DEFAULT_DRAIN_HOURS } = {}) {
  const expires = parseStamp(row?.expires_at)
  if (expires != null) return { at: expires, source: 'expires_at' }
  const placed = parseStamp(row?.placed_at)
  if (placed != null) return { at: placed + drainHours * 3_600_000, source: 'drain_window' }
  // No usable timestamp at all. Returning null rather than "now" matters: a
  // null deadline must read as UNKNOWN, and the planner treats unknown as
  // "keep watching", never as "expired" — cancelling a real order because its
  // timestamp was unparseable would be the worst possible failure here.
  return { at: null, source: 'unknown' }
}

/**
 * Plan what to do with each working entry order on an account.
 *
 * Pure: it decides and explains, and performs nothing. The caller executes,
 * which keeps every broker side effect on one path with one audit record.
 *
 * @param {*} db
 * @param {{accountId: string, now?: number, rows?: object[], armedStrategies?: string[]}} opts
 *   rows: working pending rows; read from the DB when omitted.
 *   armedStrategies: keys currently armed. Omit to skip the strategy_disarmed
 *     check entirely rather than guessing that everything is disarmed.
 * @returns {{accountId, disposition, drainHours, entering, actions: object[]}}
 */
export function planPendingDisposition(db, { accountId, now = Date.now(), rows = null, armedStrategies = null } = {}) {
  const id = String(accountId)
  const caps = accountCapabilities(db, id)
  const disposition = dispositionFor(db, id)
  const drainHours = drainHoursFor(db, id)

  let working = rows
  if (!working) {
    try {
      working = db.prepare(
        `SELECT * FROM pending_orders
          WHERE status = 'working' AND (account_id = ? OR account_id IS NULL)`
      ).all(id)
    } catch { working = [] }
  }

  const actions = working.map(row => {
    const dl = deadlineFor(row, { drainHours })
    const msLeft = dl.at == null ? null : dl.at - now
    const base = {
      id: row.id,
      symbol: row.symbol,
      orderId: row.order_id ?? null,
      level: row.level ?? null,
      deadlineAt: dl.at == null ? null : new Date(dl.at).toISOString(),
      deadlineSource: dl.source,
      msLeft,
    }

    // An account that may still ENTER is not paused, and its pendings are
    // ordinary working orders. The disposition does not apply.
    if (caps.enter) return { ...base, action: 'keep', reason: 'account is still entering' }

    if (disposition === 'cancel') {
      return { ...base, action: 'cancel', signal: 'pause_cancel', reason: 'disposition is cancel' }
    }
    if (disposition === 'keep') {
      return { ...base, action: 'keep', reason: 'disposition is keep — left armed, not monitored for invalidation' }
    }

    // supervised-drain.
    if (caps.mode === 'archived') {
      return { ...base, action: 'cancel', signal: 'account_archived', reason: 'the account was archived' }
    }
    if (armedStrategies && row.strategy && !armedStrategies.includes(row.strategy)) {
      return {
        ...base,
        action: 'cancel',
        signal: 'strategy_disarmed',
        reason: `strategy ${row.strategy} is no longer armed`,
      }
    }
    if (msLeft != null && msLeft <= 0) {
      return {
        ...base,
        action: 'cancel',
        signal: 'drain_deadline',
        reason: dl.source === 'expires_at'
          ? 'the order own expiry has passed'
          : `the ${drainHours}h drain window has passed`,
      }
    }
    return {
      ...base,
      action: 'watch',
      reason: msLeft == null
        ? 'no usable timestamp — kept under supervision rather than cancelled on a guess'
        : `draining: ${Math.ceil(msLeft / 60_000)} min left`,
    }
  })

  return { accountId: id, disposition, drainHours, entering: caps.enter, mode: caps.mode, actions }
}

/**
 * May this account arm a NEW resting entry order?
 *
 * The other half of every disposition: all three agree that a paused account
 * creates nothing new. Only the fate of the EXISTING orders differs.
 */
export function mayArmPending(db, accountId) {
  const caps = accountCapabilities(db, accountId)
  if (caps.enter) return { ok: true }
  // AN ACCOUNT THE REGISTRY DOES NOT KNOW IS ALLOWED, and that is a
  // deliberate departure from accountCapabilities' conservative default.
  //
  // They are different questions. "May this account enter?" is safety-critical
  // and an unknown answer must mean no. "Should I CHANGE the behaviour of a
  // path that has worked for an account I know nothing about?" is
  // regression-critical, and an unknown answer must mean no as well — which
  // here means leaving it alone. The pending-order path predates the registry
  // and still runs under the legacy single-account creds, where the row may
  // simply not exist; blocking there would silently stop pending orders in
  // production to prevent a risk that only applies to accounts the operator
  // has explicitly paused. This was caught by the existing pending-order
  // tests, not by reasoning, and the tests are right.
  if (!caps.known) {
    return { ok: true, unknownAccount: true }
  }
  return {
    ok: false,
    reason: `account ${accountId} is ${caps.mode || 'unknown'} — paused accounts arm no new pending orders`,
  }
}
