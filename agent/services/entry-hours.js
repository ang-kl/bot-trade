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
//             calendar's reason.
//
// BROKER READS THAT CAN CURE AN UNKNOWN, AND THEIR BOUND. autoTrade is awaited
// serially, so every second spent here is a second of the loop.
//   - A missing or stale calendar: one read of that symbol
//     (wsGetSymbolById). A symbol the collector does not demand
//     (watchdog-calendar-refresh.js) is then not refused for that alone.
//   - A missing account map: the id is resolved by resolveSymbolId, the
//     function autoTrade places with, so the id judged is the id placed. When
//     it can, it reads the account's own symbol list (fetchAccountSymbolMap →
//     wsGetSymbolsList); when it cannot read at all, its network-free answer
//     is taken. After a failed read, its global-map fallback is NOT judged:
//     autoTrade's own, unbounded read could still place another id. The K2
//     refresher (account-symbol-maps.js) is still what keeps the maps.
//   The bound, all of it:
//   - ONE attempt per read: maxRetries 0, so no retry and no backoff;
//   - no reactive token refresh (recoverAuth false): an auth error is left to
//     the loop's other broker calls, whose refresh is cooldown-limited;
//     wsGetSymbolById's errors carry no account, so B7's skip could not tell a
//     refused account from a rotated token, and the refresh itself is an
//     OAuth request with no timeout of its own;
//   - the gate waits for a read at most its timeout — 2 s for one symbol's
//     calendar, 5 s for an account's symbol list — enforced HERE by a
//     deadline, so the bound also holds in the pooled transport
//     (CTRADER_WS_POOL=1, whose session auth has its own 20 s budget). A read
//     still running after its deadline is not waited for: a late calendar is
//     discarded; a late symbol list is stored by fetchAccountSymbolMap (the
//     K2 writer, identity-checked), where a later pass finds it;
//   - at most ENTRY_HOURS_REFRESHES_PER_PASS (2) reads per loop pass
//     (`loop:<loopCount>`) and, separately, 2 per minute for callers outside
//     the loop's cycle (`route:<minute>`: the manual-assisted routes), so
//     neither can starve the other; past it, UNKNOWN stands for that pass;
//   - at most one read per identity (calendar) or per ACCOUNT (symbol list)
//     every 5 min, so a failing account costs one list read per 5 min, not
//     one per symbol per pass;
//   - no read at all, and no budget spent, for an account without usable
//     credentials or one the broker token was refused for (B7).
//   Worst case per loop pass, FOR THIS GATE: 2 × 5 s = 10 s (two accounts'
//   symbol lists). It does not bound autoTrade's own reads after the gate:
//   resolveSymbolId at loop.js:647-651, and in the closed-market branch at
//   closed-market-limits.js:372-373, still read an account's list with the
//   defaults (30 s timeout, 3 attempts, 2 s + 4 s backoff) when that
//   account's own map is older than its 24 h TTL. The gate never lets them
//   meet a missing map they could read (it reads it first, or refuses the
//   entry), and K2 keeps every map younger than 23 h, so they read only when
//   K2 has been failing for that account for a day. Bounding them would
//   change what succeeds (a list that arrives after 5 s lets the entry
//   proceed today; bounded, it would be refused): a follow-up, not done
//   here. A socket still connecting when a read times out is never closed
//   (ctrader-ws.js wsRunInner cleanup, ctrader-session.js destroy): a
//   pre-existing follow-up for every caller.
//   The collector's own attempt map is per refresher instance and is not
//   shared: the two can overlap only when a calendar is past 24 h and the
//   collector tried it within the same 5 min.
//
// OD-8 (owner decision, open at build time): WHICH hours source gates
// entries. Built with the plan's recommended answer, the account calendar for
// every entry. ENTRY_HOURS_SOURCE below is the ONE switch: set it to
// 'symbol_hours' and autoTrade reads the name-keyed weekly schedule again
// (holidays ignored, heuristic fallback, no UNKNOWN) — exactly the pre-S-8
// gate. Nothing else changes with it.
//
// OD-7 (answered 26-09): a current 0/0 holiday row is closed all local day.
// That meaning lives in market-calendar.js (V3 K3, an ancestor of this
// change); this module adds none of its own.
//
// Owner principle 1: the host is routing (which broker environment the
// account lives on); no rule here differs by environment.
// ---------------------------------------------------------------------------
import { getAccountSymbolMap, credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { readMarketCalendar, recordMarketCalendar } from './market-calendar.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import { registeredCalendarAccounts } from './watchdog-calendar-refresh.js'

export const ENTRY_HOURS_SOURCES = Object.freeze(['account_calendar', 'symbol_hours'])
/** OD-8 — the one switch. 'account_calendar' (recommended) | 'symbol_hours' (pre-S-8). */
export const ENTRY_HOURS_SOURCE = 'account_calendar'

/** Calendar reasons a fresh broker read can cure; every other UNKNOWN is left as read. */
export const ENTRY_HOURS_REFRESHABLE = Object.freeze(['calendar_missing', 'calendar_stale'])
export const ENTRY_HOURS_REFRESH_COOLDOWN_MS = 5 * 60_000
/** At most this many broker reads (calendar or symbol list) per pass; the rest stay UNKNOWN for that pass. */
export const ENTRY_HOURS_REFRESHES_PER_PASS = 2
/** No retry, so no backoff: one attempt per read. */
export const ENTRY_HOURS_REFRESH_RETRIES = 0
/**
 * One symbol's full record (ProtoOASymbolByIdReq). The same bound the K1
 * collector gives a batch of 25 of them (watchdog-calendar-refresh.js).
 */
export const ENTRY_HOURS_REFRESH_TIMEOUT_MS = 2000
/**
 * The account's whole light symbol list (ProtoOASymbolsListReq): about 1,900
 * names (symbol-hours.js header) against one symbol, on top of the same
 * connect and app/account auth, whose fixed cost was measured at about 1.8 s
 * (ctrader-ws.js wsRunInner). 5 s leaves about 3 s for the list itself. The
 * list read's own duration has not been measured in production: an estimate.
 */
export const ENTRY_HOURS_MAP_TIMEOUT_MS = 5000
/**
 * Producers autoTrade runs INSIDE the loop's cycle, so their reads share the
 * loop pass's budget. Every other caller — the manual-assisted routes, a
 * retired or unknown producer — draws on a per-minute budget of its own.
 */
export const ENTRY_HOURS_LOOP_PRODUCERS = Object.freeze(['scan_dispatch', 'daily_momentum_account', 'cross_sectional_book'])

/** The budget key for one autoTrade call (loop.js). */
export function entryHoursPassKey(producerId, loopCount, nowMs = Date.now()) {
  return ENTRY_HOURS_LOOP_PRODUCERS.includes(producerId) ? `loop:${loopCount}` : `route:${Math.floor(nowMs / 60_000)}`
}

const lastRefresh = new Map() // cooldown key → epoch ms of the last attempt
const budgets = new Map()     // pass key → reads taken
let transport = null          // test seam: { wsGetSymbolById, wsGetSymbolsList }
/** Test hook: forget refresh attempts and every pass budget. */
export function _resetEntryHoursRefresh() { lastRefresh.clear(); budgets.clear() }
/** Test seam: the broker reads autoTrade's gate makes, for tests that drive autoTrade itself. */
export function _setEntryHoursTransportForTests(t) { transport = t || null }

// Take one broker read from this pass's budget. Keys are kept per pass, so a
// route call in the middle of a loop pass neither resets nor spends the
// loop's budget; the oldest keys are dropped once 64 are held.
function takeBudget(pass) {
  const used = budgets.get(pass) ?? 0
  if (used >= ENTRY_HOURS_REFRESHES_PER_PASS) return false
  budgets.delete(pass)
  budgets.set(pass, used + 1)
  while (budgets.size > 64) budgets.delete(budgets.keys().next().value)
  return true
}
// Per-key cooldown: the same identity (or account list) is read at most every 5 min.
function takeCooldown(key, nowMs) {
  const last = lastRefresh.get(key)
  if (last != null && nowMs - last < ENTRY_HOURS_REFRESH_COOLDOWN_MS) return false
  lastRefresh.set(key, nowMs)
  if (lastRefresh.size > 4096) lastRefresh.delete(lastRefresh.keys().next().value)
  return true
}
// The gate stops waiting at `ms`, whatever the transport does. A rejection
// that arrives after the deadline lands on the race's own handler, so it is
// never an unhandled rejection (pinned by a test).
function withDeadline(promise, ms, what) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}_deadline: no answer within ${ms} ms`)), ms) })
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer))
}

/**
 * The entry's own calendar identity: the account's own symbol map (K2)
 * resolves SYMBOL on HOST (the registry's host for the account when omitted).
 * `symbolId`, when given, is an id resolved the way autoTrade resolves it
 * (ctrader-creds.js resolveSymbolId) for an account whose own map is missing.
 * Returns { identity } or { reason }.
 */
export function entryHoursIdentity(db, { symbol, accountId, host = null, symbolId = null }) {
  if (accountId == null || String(accountId) === '') return { reason: 'account_required' }
  // Routing only (owner principle 1): the account's broker host from the
  // registry, through the one helper calendar code shares for it.
  if (host == null) {
    host = registeredCalendarAccounts(db).get(String(accountId))?.host ?? null
    if (!host) return { reason: 'account_not_registered' }
  }
  let id = symbolId
  if (id == null) {
    const map = getAccountSymbolMap(db, accountId)?.map
    if (!map) return { reason: 'account_symbol_map_missing' }
    id = map[String(symbol || '').toUpperCase()]
    if (id == null) return { reason: 'symbol_not_in_account_map' }
  }
  const identity = marketIdentity({ host, accountId: String(accountId), symbolId: id })
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
export function entryMarketGate(db, { symbol, accountId, host, symbolId = null, nowMs = Date.now(), source = ENTRY_HOURS_SOURCE }) {
  if (source === 'symbol_hours') {
    const legacy = isSymbolOpenCached(db, symbol, new Date(nowMs))
    return { ...legacy, open: legacy.open === true, unknown: false, status: legacy.open ? 'OPEN' : 'CLOSED', hoursSource: 'symbol_hours' }
  }
  if (source !== 'account_calendar') return unknownGate(symbol, 'entry_hours_source_invalid')
  const { identity, reason } = entryHoursIdentity(db, { symbol, accountId, host, symbolId })
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
 * The entry path's verdict: entryMarketGate, plus the bounded broker reads
 * described in the header when they can cure the UNKNOWN. A read that is not
 * made, or fails, leaves the UNKNOWN standing and names why in `refresh`:
 * credentials_unavailable, token_refused, cooldown, pass_cap, failed: …,
 * symbol_id: … (resolveSymbolId's own reason), symbol_not_returned,
 * not_recorded: ….
 * deps: { nowMs, source, pass, credentials(accountId), fetchSymbols(creds, ids),
 *   wsGetSymbolById, wsGetSymbolsList, resolveSymbolId(db, creds, symbol, deps),
 *   mapTimeoutMs, calendarTimeoutMs }.
 */
export async function resolveEntryMarketGate(db, input, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now()
  const source = deps.source ?? ENTRY_HOURS_SOURCE
  const pass = deps.pass ?? `route:${Math.floor(nowMs / 60_000)}`
  let gate = entryMarketGate(db, { ...input, nowMs, source })
  if (!gate.unknown) return gate
  const accountId = input.accountId == null ? null : String(input.accountId)
  // Usable credentials for THIS account on its own host, or null. Asked
  // before any budget is spent, so an account that cannot be read cannot
  // starve one that can.
  const credsFor = () => {
    const c = (deps.credentials ?? (id => credsForRegisteredAccount(db, id)))(accountId)
    const host = input.host ?? registeredCalendarAccounts(db).get(accountId)?.host ?? null
    return c?.ready && String(c.accountId) === accountId && host && c.host === host ? c : null
  }
  const refused = () => tokenRefusedAccounts(db).has(accountId)

  let symbolId = null
  if (gate.calendarReason === 'account_symbol_map_missing') {
    // THE ID JUDGED IS THE ID PLACED (fix round 3, N-1). autoTrade places the
    // id resolveSymbolId returns (loop.js:647-651), so the gate asks the same
    // function, with no shortcut ahead of it: an account's own list that
    // disagrees with the global map is the one autoTrade places on. It is
    // taken only when both calls are certain to agree:
    //   - resolveSymbolId read the account's own list (bounded below): the
    //     list is stored, so autoTrade's call finds it fresh (:267-268);
    //   - resolveSymbolId could not read at all (:272 canFetch false): its
    //     answer is network-free, and autoTrade's call cannot read either.
    // After a FAILED read it falls back to the global map (:283-288), but
    // autoTrade's own read is not bounded (30 s, 3 attempts) and may succeed
    // with another id, so the gate does not judge that fallback: UNKNOWN for
    // this pass, named. The budget and the cooldown are spent only when the
    // list is really read.
    const creds = credsFor()
    if (!creds) return { ...gate, refresh: 'credentials_unavailable' }
    if (refused()) return { ...gate, refresh: 'token_refused' }
    const key = `map:${accountId}`
    const ms = deps.mapTimeoutMs ?? ENTRY_HOURS_MAP_TIMEOUT_MS
    const list = deps.wsGetSymbolsList ?? transport?.wsGetSymbolsList ?? (await import('../lib/ctrader-ws.js')).wsGetSymbolsList
    let read = null // null: resolveSymbolId never asked for the list
    // resolveSymbolId → fetchAccountSymbolMap calls this with its own
    // arguments; the entry path's bound replaces the timeout and the retry
    // settings and keeps the rest (perAccount: the account's OWN list).
    const bounded = (host, clientId, clientSecret, accessToken, acct, _timeoutMs, opts = {}) => {
      if (!takeCooldown(key, nowMs)) { read = 'cooldown'; return Promise.reject(new Error('entry_hours_cooldown')) }
      if (!takeBudget(pass)) { lastRefresh.delete(key); read = 'pass_cap'; return Promise.reject(new Error('entry_hours_pass_cap')) }
      read = 'attempted'
      return list(host, clientId, clientSecret, accessToken, acct, ms, { ...opts, maxRetries: ENTRY_HOURS_REFRESH_RETRIES, recoverAuth: false })
    }
    try {
      const resolve = deps.resolveSymbolId ?? (await import('../lib/ctrader-creds.js')).resolveSymbolId
      const r = await withDeadline(resolve(db, creds, input.symbol, { now: nowMs, wsGetSymbolsList: bounded }), ms, 'entry_hours_symbol_list')
      if (read === 'cooldown' || read === 'pass_cap') return { ...gate, refresh: read }
      if (r?.id == null) return { ...gate, refresh: `symbol_id: ${String(r?.reason || 'unresolved').slice(0, 160)}` }
      if (read === 'attempted' && r.source !== 'account') {
        return { ...gate, refresh: `symbol_id_fallback: the account's own list could not be read, and resolveSymbolId answered from its ${r.source} fallback; autoTrade reads the list again, so another id could be placed` }
      }
      symbolId = r.id
    } catch (err) {
      return { ...gate, refresh: `failed: ${String(err?.message || err).slice(0, 120)}` }
    }
    gate = { ...entryMarketGate(db, { ...input, symbolId, nowMs, source }), refresh: 'symbol_id_resolved' }
    if (!gate.unknown) return gate
  }
  if (!gate.identity || !ENTRY_HOURS_REFRESHABLE.includes(gate.calendarReason)) return gate
  const creds = credsFor()
  if (!creds || creds.host !== gate.identity.host) return { ...gate, refresh: 'credentials_unavailable' }
  if (refused()) return { ...gate, refresh: 'token_refused' }
  const key = marketIdentityKey(gate.identity)
  if (!takeCooldown(key, nowMs)) return { ...gate, refresh: 'cooldown' }
  if (!takeBudget(pass)) { lastRefresh.delete(key); return { ...gate, refresh: 'pass_cap' } }
  const ms = deps.calendarTimeoutMs ?? ENTRY_HOURS_REFRESH_TIMEOUT_MS
  try {
    const fetchSymbols = deps.fetchSymbols ?? (async (c, ids) => {
      const ws = deps.wsGetSymbolById ?? transport?.wsGetSymbolById ?? (await import('../lib/ctrader-ws.js')).wsGetSymbolById
      return ws(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, ids, ms, { maxRetries: ENTRY_HOURS_REFRESH_RETRIES, recoverAuth: false })
    })
    const res = await withDeadline(fetchSymbols(creds, [Number(gate.identity.symbolId)]), ms, 'entry_hours_calendar')
    const sym = (res?.symbol || []).find(s => String(s?.symbolId) === gate.identity.symbolId)
    if (!sym) return { ...gate, refresh: 'symbol_not_returned' }
    const rec = recordMarketCalendar(db, gate.identity, sym, { nowMs })
    if (!rec.recorded) return { ...gate, refresh: `not_recorded: ${rec.reason}` }
  } catch (err) {
    return { ...gate, refresh: `failed: ${String(err?.message || err).slice(0, 120)}` }
  }
  return { ...entryMarketGate(db, { ...input, symbolId, nowMs, source }), refresh: 'refreshed' }
}
