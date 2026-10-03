// ---------------------------------------------------------------------------
// agent/services/exit-hours.js — the market-hours reading on the EXIT path
// (27-09 follow-up (1), built 03-10-2026).
//
// THE DEFECT. S-8 moved the entry gate onto the ACCOUNT CALENDAR
// (entry-hours.js: the (host, account, symbolId) broker calendar, weekly
// schedule AND holiday rows), but every exit deferral kept reading the
// name-keyed `isSymbolOpenCached` (symbol-hours.js), which knows no holidays:
//   - the F2 daily rank exit (momentum-account.js exitDroppedHoldings),
//   - the row-cursor rank exit (momentum-book.js),
//   - the position manager's closed-market hold (loop.js, #1186).
// So on a holiday such as HKEX's 01-10 the entry read CLOSED and the exit of
// the same name on the same account read OPEN, went to the broker, was
// refused MARKET_CLOSED, and — for the hold — was retried every 15 min on
// a schedule that would never say closed.
//
// THE RULE. The exit path asks the same account calendar the entry path
// asks, through entryMarketGate (the one reader; OD-8's switch applies to it
// too). OPEN and CLOSED are taken as read. UNKNOWN — no account given, no
// registered account, no symbol map, no calendar, a stale one — is NOT a
// reason to hold an exit (a wrongly deferred exit on an open market is the
// worse error, as both book paths already say), so the reading falls back to
// the pre-S-8 name-keyed schedule, named as such: `source` is 'broker' (a
// symbol_hours row) or the heuristic, exactly as before this change.
//
// `exitMayDefer(hours)` is the one predicate the callers use: only a reading
// from the account calendar or a broker schedule row may defer a close; the
// heuristic and an error both ATTEMPT it (one refused line at worst).
// ---------------------------------------------------------------------------
import { entryMarketGate } from './entry-hours.js'
import { isSymbolOpenCached } from './symbol-hours.js'

/** Sources whose CLOSED reading may hold a close back. */
export const EXIT_DEFERRING_SOURCES = Object.freeze(['account_calendar', 'broker'])

/**
 * The exit path's hours reading for `symbol` on `accountId` at `now`.
 * Same shape as isSymbolOpenCached — `{ open, source, reason }` — plus
 * `calendarReason` (the account calendar's own reason, or why it was UNKNOWN
 * and the name-keyed schedule answered instead).
 */
export function exitMarketHours(db, { symbol, accountId = null, now = new Date() }) {
  const at = now instanceof Date ? now : new Date(now)
  const nowMs = at.getTime()
  let gate = null
  if (accountId != null && String(accountId) !== '') {
    try { gate = entryMarketGate(db, { symbol, accountId: String(accountId), nowMs }) } catch { gate = null }
  }
  if (gate && !gate.unknown) {
    const open = gate.open === true
    return {
      open,
      source: 'account_calendar',
      calendarReason: gate.calendarReason ?? null,
      reason: open ? null : (gate.reason || `${symbol}: closed per the account calendar`),
    }
  }
  const legacy = isSymbolOpenCached(db, symbol, at)
  return { ...legacy, calendarReason: gate?.calendarReason ?? 'account_required' }
}

/** May this reading hold a close back? Only a CLOSED from a deferring source. */
export function exitMayDefer(hours) {
  return hours?.open === false && EXIT_DEFERRING_SOURCES.includes(hours?.source)
}

/** The wording the book's notes and log lines use for a deferring source. */
export function exitHoursSourceLabel(hours) {
  return hours?.source === 'account_calendar' ? 'account calendar' : 'broker schedule'
}
