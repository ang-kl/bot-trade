// ---------------------------------------------------------------------------
// agent/services/session-holidays.js — V3 WEB-6b: the broker-listed holidays
// and early closes of each report session's exchange, for the "Today by
// market session" buckets (performance-populations.js). REPORTING ONLY: no
// entry, risk or order path reads this module (the entry path reads the
// account calendar itself — services/entry-hours.js, V3 S-8).
//
// Source: the stored broker calendars (market-calendar.js storedHolidays —
// intact payloads only) of the stocks listed on the exchange, found by the
// symbol suffix in SESSION_HOLIDAY_EVIDENCE (HKEX ← .HK, NYSE ← .US), with
// the name read from that account's own symbol map (V3 K2). The union of
// their holiday rows is applied: if any listed stock's calendar is closed,
// the exchange row is closed (OD-7's direction — closed when open, never the
// reverse). An exchange with no such calendar reports `no_evidence` and keeps
// regular hours; it is never presented as holiday-free.
//
// Bounded: at most MAX_PER_ACCOUNT calendars per (exchange, account) and
// MAX_ROWS distinct rows per exchange are read. Pure reads; no broker call.
// ---------------------------------------------------------------------------
import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { storedHolidays } from './market-calendar.js'
import { SESSION_HOLIDAY_EVIDENCE } from '../shared/report-sessions.js'

const PREFIX = 'market_calendar:v1:'
export const SESSION_HOLIDAYS_MAX_PER_ACCOUNT = 16
const MAX_ROWS = 512

/**
 * { [exchange]: { identities, observedAt (oldest), rows: [{ dateIso,
 * startSecond, endSecond, scheduleTimeZone, isRecurring, name }] } } for every
 * exchange in SESSION_HOLIDAY_EVIDENCE that has at least one calendar.
 */
export function sessionHolidayRows(db) {
  const suffixes = Object.entries(SESSION_HOLIDAY_EVIDENCE)
  const keys = db.prepare("SELECT key FROM agent_state WHERE key LIKE 'market_calendar:v1:%' ORDER BY key").all().map(r => r.key)
  const names = new Map() // accountId → Map(symbolId → NAME)
  const nameOf = (accountId, symbolId) => {
    if (!names.has(accountId)) {
      const map = getAccountSymbolMap(db, accountId)?.map
      names.set(accountId, new Map(map ? Object.entries(map).map(([n, id]) => [String(id), String(n).toUpperCase()]) : []))
    }
    return names.get(accountId).get(String(symbolId)) ?? null
  }
  const out = {}, perAccount = new Map()
  for (const key of keys) {
    let parts
    try { parts = JSON.parse(key.slice(PREFIX.length)) } catch { continue }
    if (!Array.isArray(parts) || parts.length !== 4) continue
    const [, host, accountId, symbolId] = parts
    const name = nameOf(String(accountId), symbolId)
    const hit = name && suffixes.find(([, sfx]) => name.endsWith(sfx))
    if (!hit) continue
    const exchange = hit[0], quota = `${exchange}|${accountId}`
    if ((perAccount.get(quota) ?? 0) >= SESSION_HOLIDAYS_MAX_PER_ACCOUNT) continue
    const stored = storedHolidays(db, { host, accountId, symbolId })
    if (!stored?.holidays) continue
    perAccount.set(quota, (perAccount.get(quota) ?? 0) + 1)
    const e = out[exchange] ??= { identities: 0, observedAt: null, rows: [], seen: new Set() }
    e.identities++
    if (stored.observedAt && (e.observedAt == null || stored.observedAt < e.observedAt)) e.observedAt = stored.observedAt
    for (const h of stored.holidays) {
      const row = { dateIso: h.dateIso, startSecond: h.startSecond ?? null, endSecond: h.endSecond ?? null,
        scheduleTimeZone: h.scheduleTimeZone, isRecurring: h.isRecurring, name: h.name ?? null }
      const k = JSON.stringify([row.dateIso, row.startSecond, row.endSecond, row.scheduleTimeZone, row.isRecurring])
      if (e.seen.has(k) || e.rows.length >= MAX_ROWS) continue
      e.seen.add(k); e.rows.push(row)
    }
  }
  for (const e of Object.values(out)) delete e.seen
  return out
}
