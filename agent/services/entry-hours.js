// ---------------------------------------------------------------------------
// agent/services/entry-hours.js — the market-hours gate on the entry path
// (V3 integrated plan, Wave 3 row 3.2: S-8, 26-09-2026).
//
// Before S-8 the only entry hours gate was loop.js autoTrade's
// isSymbolOpenCached (symbol-hours.js): keyed on the symbol NAME, reading the
// broker's WEEKLY schedule only — public holidays were recorded
// (market-calendar.js) but never consulted — and falling back to the
// sessions.js heuristic when the name had no cached row. So on a holiday such
// as HKEX's 01-10 an entry read OPEN and went to the broker.
//
// S-8 moves the gate onto the ACCOUNT CALENDAR: the entry's own
// (host, account, symbolId) broker calendar — the account's own symbol map
// (V3 K2) resolves the id, never the feed account's — read by
// readMarketCalendar, which applies the weekly schedule AND the holiday rows
// in their own zones. Three readings, and what the entry does:
//   OPEN    — the entry proceeds exactly as before.
//   CLOSED  — schedule or holiday: the existing closed-market branch
//             (resting limit or the legacy queue) runs, unchanged.
//   UNKNOWN — NEVER read as open. No order and no resting limit; the refusal
//             is one decision_log skip (stage market_hours_unknown) naming the
//             calendar's reason. A missing or stale calendar is re-read from
//             the broker once (one symbol, at most every 5 min per identity)
//             before the verdict, so a symbol the collector does not demand
//             (watchdog-calendar-refresh.js) is not refused for that alone.
//
// OD-8 (owner decision, open at build time): WHICH hours source gates
// entries. Built with the plan's recommended answer, the account calendar for
// every entry. ENTRY_HOURS_SOURCE below is the ONE switch: set it to
// 'symbol_hours' and autoTrade reads the name-keyed weekly schedule again
// (holidays ignored, heuristic fallback, no UNKNOWN) — exactly the pre-S-8
// gate. Nothing else changes with it.
//
// OD-7 (answered 26-09): a current 0/0 holiday row is closed all local day.
// That meaning lives in market-calendar.js (V3 K3); this module adds none of
// its own. Until K3 is merged a 0/0 row keeps its calendar UNKNOWN, which this
// gate refuses — closed either way, never open.
//
// Owner principle 1: the host is routing (which broker environment the
// account lives on); no rule here differs by environment.
// ---------------------------------------------------------------------------
import { getAccountSymbolMap, credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { readMarketCalendar, recordMarketCalendar } from './market-calendar.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import { registeredCalendarAccounts } from './watchdog-calendar-refresh.js'

export const ENTRY_HOURS_SOURCES = Object.freeze(['account_calendar', 'symbol_hours'])
/** OD-8 — the one switch. 'account_calendar' (recommended) | 'symbol_hours' (pre-S-8). */
export const ENTRY_HOURS_SOURCE = 'account_calendar'

/** Calendar reasons a fresh broker read can cure; every other UNKNOWN is left as read. */
export const ENTRY_HOURS_REFRESHABLE = Object.freeze(['calendar_missing', 'calendar_stale'])
export const ENTRY_HOURS_REFRESH_COOLDOWN_MS = 5 * 60_000
const REFRESH_TIMEOUT_MS = 2000
const lastRefresh = new Map() // identity key → epoch ms of the last attempt
/** Test hook: forget refresh attempts. */
export function _resetEntryHoursRefresh() { lastRefresh.clear() }

/**
 * The entry's own calendar identity: the account's own symbol map (K2)
 * resolves SYMBOL on HOST (the registry's host for the account when omitted). Returns { identity } or { reason }.
 */
export function entryHoursIdentity(db, { symbol, accountId, host = null }) {
  if (accountId == null || String(accountId) === '') return { reason: 'account_required' }
  // Routing only (owner principle 1): the account's broker host from the
  // registry, through the one helper calendar code shares for it.
  if (host == null) {
    host = registeredCalendarAccounts(db).get(String(accountId))?.host ?? null
    if (!host) return { reason: 'account_not_registered' }
  }
  const map = getAccountSymbolMap(db, accountId)?.map
  if (!map) return { reason: 'account_symbol_map_missing' }
  const symbolId = map[String(symbol || '').toUpperCase()]
  if (symbolId == null) return { reason: 'symbol_not_in_account_map' }
  const identity = marketIdentity({ host, accountId: String(accountId), symbolId })
  return identity ? { identity } : { reason: 'identity_invalid' }
}

const unknownGate = (symbol, calendarReason, extra = {}) => ({
  open: false, unknown: true, status: 'UNKNOWN', hoursSource: 'account_calendar', calendarReason,
  reason: `${symbol}: market hours UNKNOWN on the account calendar (${calendarReason}) — no entry`, ...extra,
})

/**
 * Synchronous verdict. `open` is true ONLY for an OPEN reading; UNKNOWN is
 * `{ open: false, unknown: true }`, so a caller that tests `.open` alone can
 * never read it as open.
 */
export function entryMarketGate(db, { symbol, accountId, host, nowMs = Date.now(), source = ENTRY_HOURS_SOURCE }) {
  if (source === 'symbol_hours') {
    const legacy = isSymbolOpenCached(db, symbol, new Date(nowMs))
    return { ...legacy, open: legacy.open === true, unknown: false, status: legacy.open ? 'OPEN' : 'CLOSED', hoursSource: 'symbol_hours' }
  }
  if (source !== 'account_calendar') return unknownGate(symbol, 'entry_hours_source_invalid')
  const { identity, reason } = entryHoursIdentity(db, { symbol, accountId, host })
  if (!identity) return unknownGate(symbol, reason)
  const cal = readMarketCalendar(db, identity, { nowMs })
  const base = { identity, observedAt: cal.observedAt, hoursSource: 'account_calendar' }
  if (cal.marketStatus === 'OPEN' && cal.open === true) return { ...base, open: true, unknown: false, status: 'OPEN', calendarReason: null }
  if (cal.marketStatus === 'CLOSED' && cal.open === false) {
    return { ...base, open: false, unknown: false, status: 'CLOSED', calendarReason: cal.reason,
      reason: `${symbol}: closed per the account calendar (${cal.reason === 'broker_holiday' ? 'broker holiday' : 'broker trading schedule'})` }
  }
  return unknownGate(symbol, cal.reason ?? 'calendar_unknown', base)
}

/**
 * The entry path's verdict: entryMarketGate, plus one bounded broker re-read
 * of THIS identity when the calendar is missing or stale. The read only
 * records the calendar (market-calendar.js recordMarketCalendar, which
 * validates it); the verdict is then read back the ordinary way. A failed
 * read leaves the UNKNOWN standing, with the failure named.
 * deps: { nowMs, source, fetchSymbols(creds, symbolIds) → { symbol: [...] }, credentials(accountId) }.
 */
export async function resolveEntryMarketGate(db, input, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now()
  const source = deps.source ?? ENTRY_HOURS_SOURCE
  const gate = entryMarketGate(db, { ...input, nowMs, source })
  if (!gate.unknown || !gate.identity || !ENTRY_HOURS_REFRESHABLE.includes(gate.calendarReason)) return gate
  const key = marketIdentityKey(gate.identity)
  const last = lastRefresh.get(key)
  if (last != null && nowMs - last < ENTRY_HOURS_REFRESH_COOLDOWN_MS) return { ...gate, refresh: 'cooldown' }
  lastRefresh.set(key, nowMs)
  if (lastRefresh.size > 4096) lastRefresh.delete(lastRefresh.keys().next().value)
  try {
    const creds = (deps.credentials ?? (id => credsForRegisteredAccount(db, id)))(gate.identity.accountId)
    if (!creds?.ready || String(creds.accountId) !== gate.identity.accountId || creds.host !== gate.identity.host) {
      return { ...gate, refresh: 'credentials_unavailable' }
    }
    const fetchSymbols = deps.fetchSymbols ?? (async (c, ids) => {
      const { wsGetSymbolById } = await import('../lib/ctrader-ws.js')
      return wsGetSymbolById(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, ids, REFRESH_TIMEOUT_MS)
    })
    const res = await fetchSymbols(creds, [Number(gate.identity.symbolId)])
    const sym = (res?.symbol || []).find(s => String(s?.symbolId) === gate.identity.symbolId)
    if (!sym) return { ...gate, refresh: 'symbol_not_returned' }
    const rec = recordMarketCalendar(db, gate.identity, sym, { nowMs })
    if (!rec.recorded) return { ...gate, refresh: `not_recorded: ${rec.reason}` }
  } catch (err) {
    return { ...gate, refresh: `failed: ${String(err?.message || err).slice(0, 120)}` }
  }
  return { ...entryMarketGate(db, { ...input, nowMs, source }), refresh: 'refreshed' }
}
