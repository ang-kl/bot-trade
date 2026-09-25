// T2 (V3 P0-1b): competing exits and the momentum partial plan.
//
// A position with a registered partial plan may have a partial or rank close
// request in flight. A second closer acting at that moment can close volume
// the first one is already closing: two requests, one intended exit. The plan
// row is the durable record of that request, so every other closer reads it.
//
// Two rules, one per kind of closer:
//   - The protective closers (the loss cap, the profit ratchet's flatten)
//     defer only while a request is IN FLIGHT (SENDING, RANK_SENDING): a
//     window of seconds, bounded by the manager's request budget. Once the
//     request has ended, even ambiguously, their full close of the broker's
//     current volume is correct whatever the earlier request did.
//   - The manual close and partial routes also refuse while the partial's
//     outcome is AMBIGUOUS: a manual partial then could close the same
//     volume twice. The owner can still flatten through /actions/close-all.
// Plans absent (recordedPlans 0) means no row, and every closer behaves
// exactly as it did before.

export const IN_FLIGHT_EXIT_STATES = Object.freeze(['SENDING', 'RANK_SENDING'])
export const MANUAL_REFUSED_EXIT_STATES = Object.freeze(['SENDING', 'AMBIGUOUS', 'RANK_SENDING'])

/** The partial plan's state for one position on one account, or null when
 * there is no plan (or no plan table). A read failure is null: coordination
 * never blocks a protective close on a database error. */
export function momentumPlanForPosition(db, accountId, positionId) {
  try {
    if (accountId == null || positionId == null) return null
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get()) return null
    const row = db.prepare('SELECT state, trade_id FROM momentum_partial_plans WHERE account_id=? AND position_id=?')
      .get(String(accountId), String(positionId))
    return row ? { state: row.state, tradeId: row.trade_id } : null
  } catch { return null }
}

/** A refusal reason when the plan is in one of `states`, else null. */
export function competingExitRefusal(db, { accountId, positionId, states }) {
  const plan = momentumPlanForPosition(db, accountId, positionId)
  if (!plan || !states.includes(plan.state)) return null
  return `momentum partial plan ${plan.state} on position ${positionId} (trade ${plan.tradeId}) — a close request may be in flight or unresolved; no competing close sent`
}
