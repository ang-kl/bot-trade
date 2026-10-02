// ---------------------------------------------------------------------------
// agent/lib/closed-market-hold.js — do not resend an exit the broker has just
// refused because the market is closed (02-10-2026).
//
// THE DEFECT. The position manager decides an exit every monitor cycle. When
// the rule is `time_cap_expired` and the cap lands after the exchange has shut
// (both PG.US rows, deadline 22:52Z on 01-10, US close 20:00Z), the broker
// answers MARKET_CLOSED and nothing changes, so the identical close was sent
// again about once a minute for hours: two broker requests a minute and a log
// line that buries a real exit failure.
//
// THE RULE. After a MARKET_CLOSED refusal, hold the next send for that row and
// action until the symbol's schedule says the market is open, or HOLD_MAX_MS
// has passed (the schedule can be a heuristic or stale, so the hold is
// bounded: a wrong "closed" costs at most one retry interval, never an exit
// that waits for ever). The decision itself is not suppressed: the rule
// re-fires every cycle and is simply not sent while held, so the first cycle
// after the open sends it. Only a broker refusal STARTS a hold, so a market the
// heuristic wrongly calls closed is never held on the heuristic's say-so alone.
// ---------------------------------------------------------------------------

export const HOLD_MAX_MS = 15 * 60 * 1000

const holds = new Map() // key -> { since, until }

export function resetClosedMarketHolds() { holds.clear() }

export function closedMarketHoldView() {
  return [...holds.entries()].map(([key, h]) => ({ key, since: new Date(h.since).toISOString(), until: new Date(h.until).toISOString() }))
}

/** Is this error text the broker saying the market is closed? */
export function isMarketClosedRefusal(text) {
  return /MARKET_CLOSED|market is closed/i.test(String(text ?? ''))
}

export const holdKey = (pos, action) => `${pos?.account_id ?? 'unscoped'}:${pos?.id}:${action}`

/**
 * Run one broker action under the hold. `run` sends it; `isOpen()` says whether
 * the symbol's session is open now. Returns the outcome of `run`, or
 * `{ heldClosedMarket: true, until }` when the send was withheld.
 */
export async function runWithClosedMarketHold({ pos, action, run, isOpen, now = Date.now() }) {
  const key = holdKey(pos, action)
  const hold = holds.get(key)
  if (hold) {
    let open = false
    try { open = isOpen() === true } catch { open = false }
    if (!open && now < hold.until) return { heldClosedMarket: true, until: hold.until }
    holds.delete(key) // the session opened, or the bound passed: send it again
  }
  const outcome = await run()
  if (outcome?.error && isMarketClosedRefusal(outcome.error)) {
    holds.set(key, { since: hold?.since ?? now, until: now + HOLD_MAX_MS })
    return { ...outcome, closedMarketHeld: true }
  }
  return outcome
}
