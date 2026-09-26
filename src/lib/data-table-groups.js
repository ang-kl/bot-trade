// data-table-groups — pure helpers for common/DataTable.jsx: turn a UTC
// timestamp into the calendar day it falls on IN A GIVEN TIME ZONE, and fold
// rows into date-headed groups (26-09 UI plan §8 item 2, UI-2).
//
// Mirrors agent/lib/date-zones.js's server-side twin. The two are not shared
// code — the frontend bundle never imports from agent/ — but they must agree
// on behaviour, since UI-3's blockers card sends server-grouped `days` while
// every OTHER table using this shared DataTable groups client-side with this
// file. Both files are covered by their own tests pinning the same example:
// '2026-09-25 22:45:24' (UTC, no zone marker — the shape decision_log and
// risk_events rows are actually stored in) falls on 26-09 in Asia/Singapore
// and on 25-09 in America/New_York.

const zoneFormatters = new Map()
function dayFormatterFor(timeZone) {
  if (zoneFormatters.has(timeZone)) return zoneFormatters.get(timeZone)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  if (zoneFormatters.size >= 32) zoneFormatters.delete(zoneFormatters.keys().next().value)
  zoneFormatters.set(timeZone, formatter)
  return formatter
}

/** true only for a string Intl actually accepts as an IANA time zone. */
export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 100) return false
  try { dayFormatterFor(zone); return true } catch { return false }
}

/** The browser's own zone, or the plan's stated default when it cannot be read. */
export function defaultTimeZone() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimeZone(z) ? z : 'Asia/Singapore'
  } catch { return 'Asia/Singapore' }
}

// Mutation target (CLAUDE.md #1; the plan names this exact check: "a mutation
// check (remove the `Z` in `toMs`)"). A bare 'YYYY-MM-DD HH:MM:SS' row (no
// zone marker) is explicitly read as UTC by appending 'Z' after normalising
// the separator — never left to the runtime's own default interpretation of
// an ambiguous, non-standard date string.
export function toMs(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** 'YYYY-MM-DD' for the calendar day `ms` falls on in `timeZone`. null on an invalid zone or non-finite ms. */
export function dayKeyInZone(ms, timeZone) {
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null
  const parts = Object.fromEntries(dayFormatterFor(timeZone).formatToParts(ms).map(p => [p.type, p.value]))
  if (!parts.year || !parts.month || !parts.day) return null
  return `${parts.year}-${parts.month}-${parts.day}`
}

const weekdayFormatters = new Map()
function weekdayFormatterFor(timeZone) {
  if (weekdayFormatters.has(timeZone)) return weekdayFormatters.get(timeZone)
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  if (weekdayFormatters.size >= 32) weekdayFormatters.delete(weekdayFormatters.keys().next().value)
  weekdayFormatters.set(timeZone, f)
  return f
}

/** "Sat 26 Sep 2026" — built from formatToParts so ICU/locale drift (month
 * length, part order) cannot change the shape callers render. */
export function dayLabelInZone(ms, timeZone) {
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null
  const parts = Object.fromEntries(weekdayFormatterFor(timeZone).formatToParts(ms).map(p => [p.type, p.value]))
  if (!parts.weekday || !parts.day || !parts.month || !parts.year) return null
  return `${parts.weekday} ${parts.day} ${parts.month.slice(0, 3)} ${parts.year}`
}

export const UNPARSEABLE_GROUP_KEY = '\u0000unparseable'

/**
 * Fold `rows` into date-headed groups, newest day first, for a table that has
 * no server-side grouping of its own. `getAt(row)` returns the row's raw
 * timestamp (any shape `toMs` accepts); rows whose time cannot be parsed get
 * their own trailing group instead of silently joining "today" or vanishing.
 *
 * Returns [{ key, label, ms, rows }], where `key` is UNPARSEABLE_GROUP_KEY for
 * the unparseable bucket and `ms` is null there (nothing to sort it against
 * a real day, so it always sorts last).
 */
export function groupRowsByDate(rows, { timeZone, getAt = r => r.at } = {}) {
  const zone = isValidTimeZone(timeZone) ? timeZone : defaultTimeZone()
  const byKey = new Map()
  const unparseable = []
  for (const row of rows || []) {
    const ms = toMs(getAt(row))
    const key = ms == null ? null : dayKeyInZone(ms, zone)
    if (key == null) { unparseable.push(row); continue }
    if (!byKey.has(key)) byKey.set(key, { key, label: dayLabelInZone(ms, zone), ms, rows: [] })
    byKey.get(key).rows.push(row)
  }
  const groups = [...byKey.values()].sort((a, b) => b.ms - a.ms)
  if (unparseable.length) groups.push({ key: UNPARSEABLE_GROUP_KEY, label: 'Unparseable time', ms: null, rows: unparseable })
  return groups
}
