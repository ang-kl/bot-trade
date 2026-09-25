// T2 (V3 P0-1b): competing exits and the momentum partial plan.
//
// A position with a registered partial plan may have a partial or rank close
// request in flight. A second closer acting at that moment can close volume
// the first one is already closing: two requests, one intended exit. The plan
// row is the durable record of that request, so every other closer reads it.
//
// Two rules, one per kind of closer:
//   - The protective closers (the loss cap, the profit ratchet's flatten)
//     defer only while a request can still be IN FLIGHT: the row is SENDING
//     or RANK_SENDING AND the request was claimed no more than the transport
//     horizon ago (TRANSPORT_HORIZON_MS, 50 s: every close wait plus grace).
//     The row's state alone is not that bound: SENDING stays until deal
//     history resolves it, which can be never (history unreadable, an order
//     filled in several deals). After the horizon no request can still be
//     executing, so a full close of the broker's CURRENT volume is correct
//     whatever the earlier request did, and the protective close proceeds.
//     An attempt time that cannot be read defers nothing.
//   - The manual close and partial routes also refuse while the partial's
//     outcome is AMBIGUOUS, and refuse on the state alone, with no time
//     limit: a manual partial then could close the same volume twice. The
//     owner can still flatten through /actions/close-all.
// Plans absent (recordedPlans 0) means no row, and every closer behaves
// exactly as it did before.
import { TRANSPORT_HORIZON_MS } from './momentum-broker-evidence.js'

export const IN_FLIGHT_EXIT_STATES = Object.freeze(['SENDING', 'RANK_SENDING'])
export const MANUAL_REFUSED_EXIT_STATES = Object.freeze(['SENDING', 'AMBIGUOUS', 'RANK_SENDING'])

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

/** The partial plan's state for one position on one account, or null when
 * there is no plan (or no plan table). attemptedAt is when the current
 * request was claimed: the plan row's own for a partial, the rank claim's
 * for a RANK_ state; null when it cannot be read. A read failure is null:
 * coordination never blocks a protective close on a database error. */
export function momentumPlanForPosition(db, accountId, positionId) {
  try {
    if (accountId == null || positionId == null) return null
    if (!hasTable(db, 'momentum_partial_plans')) return null
    const row = db.prepare('SELECT state, trade_id, attempted_at FROM momentum_partial_plans WHERE account_id=? AND position_id=?')
      .get(String(accountId), String(positionId))
    if (!row) return null
    let attemptedAt = row.attempted_at
    if (String(row.state).startsWith('RANK_')) {
      attemptedAt = hasTable(db, 'momentum_rank_exits')
        ? db.prepare('SELECT attempted_at FROM momentum_rank_exits WHERE account_id=? AND trade_id=?')
          .get(String(accountId), row.trade_id)?.attempted_at ?? null
        : null
    }
    return { state: row.state, tradeId: row.trade_id, attemptedAt: Number.isSafeInteger(attemptedAt) ? attemptedAt : null }
  } catch { return null }
}

const refusalText = (plan, positionId) =>
  `momentum partial plan ${plan.state} on position ${positionId} (trade ${plan.tradeId}) — a close request may be in flight or unresolved; no competing close sent`

/** A refusal reason when the plan is in one of `states`, else null. On the
 * state alone: the manual routes' rule. */
export function competingExitRefusal(db, { accountId, positionId, states }) {
  const plan = momentumPlanForPosition(db, accountId, positionId)
  if (!plan || !states.includes(plan.state)) return null
  return refusalText(plan, positionId)
}

/** The protective closers' rule: a deferral reason only while a partial or
 * rank close request claimed within the transport horizon may still be in
 * flight; null otherwise, and then the protective close proceeds. The age is
 * bounded on both sides, so an attempt time the clock cannot place (in the
 * future by more than the horizon) defers nothing either. */
export function protectiveExitDeferral(db, { accountId, positionId, nowMs }) {
  const plan = momentumPlanForPosition(db, accountId, positionId)
  if (!plan || !IN_FLIGHT_EXIT_STATES.includes(plan.state)) return null
  if (!Number.isSafeInteger(plan.attemptedAt) || !Number.isFinite(nowMs)) return null
  const ageMs = nowMs - plan.attemptedAt
  if (ageMs > TRANSPORT_HORIZON_MS || ageMs < -TRANSPORT_HORIZON_MS) return null
  return `${refusalText(plan, positionId)} (claimed ${Math.round(ageMs)} ms ago; deferred at most ${TRANSPORT_HORIZON_MS} ms)`
}
