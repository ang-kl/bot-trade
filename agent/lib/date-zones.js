// ---------------------------------------------------------------------------
// agent/lib/date-zones.js — UI-2/UI-3 (26-09 plan §8 items 2-3): a small,
// dependency-free way to turn a stored UTC timestamp into the calendar date
// it falls on IN A GIVEN TIME ZONE, for grouping tables by day.
//
// Mirrors the pattern already used by market-calendar.js's `validZone` /
// `formatterFor` (a cached Intl.DateTimeFormat, invalid zones caught once),
// kept separate because this module has no calendar/holiday concerns — only
// "which day does this timestamp read as, in this zone".
// ---------------------------------------------------------------------------

const zoneFormatters = new Map()

/** A bounded, immutable formatter cache — never request data. */
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

// Rows in this database are stored as SQLite `datetime('now')` strings —
// 'YYYY-MM-DD HH:MM:SS', UTC, with NO zone designator (db.js, and V3's own
// finding: "Times are stored in UTC and printed raw"). A bare
// `new Date('2026-09-25 22:45:24')` is parsed as LOCAL time by the engines
// that accept the non-standard space separator at all — wrong whenever the
// process is not already running in UTC. So a timestamp with no zone marker
// is read as UTC EXPLICITLY, by appending 'Z' after normalising the
// separator, never left to the runtime's default interpretation.
//
// Mutation target: the appended 'Z' below. Removing it makes this function's
// answer depend on the host's TZ instead of always reading the stored value
// as UTC — silently wrong in any non-UTC process, and caught by
// date-zones.test.js's `toMs` assertions plus the grouping tests that pin an
// exact UTC instant against Asia/Singapore and America/New_York.
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

/** 'YYYY-MM-DD' for the calendar day `ms` falls on in `timeZone`. null on an invalid zone or a non-finite ms. */
export function dayKeyInZone(ms, timeZone) {
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null
  // en-CA already formats as YYYY-MM-DD; still built from parts rather than
  // trusted as a string, since a couple of ICU versions insert directional
  // marks that would otherwise sneak into a value used as a Map key.
  const parts = Object.fromEntries(dayFormatterFor(timeZone).formatToParts(ms).map(p => [p.type, p.value]))
  if (!parts.year || !parts.month || !parts.day) return null
  return `${parts.year}-${parts.month}-${parts.day}`
}

const WEEKDAY_FMT = new Map()
function weekdayFormatterFor(timeZone) {
  if (WEEKDAY_FMT.has(timeZone)) return WEEKDAY_FMT.get(timeZone)
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  if (WEEKDAY_FMT.size >= 32) WEEKDAY_FMT.delete(WEEKDAY_FMT.keys().next().value)
  WEEKDAY_FMT.set(timeZone, f)
  return f
}

/**
 * A human day header, e.g. "Sat 26 Sep 2026". null on an invalid zone or ms.
 * Built from formatToParts, not a formatted string, because locale/ICU
 * versions disagree on both month length ("Sep" vs "Sept") and part order
 * ("Sat, Sep 26, 2026") — this fixes the shape the plan's own examples use
 * regardless of the runtime's ICU data.
 */
export function dayLabelInZone(ms, timeZone) {
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null
  const parts = Object.fromEntries(weekdayFormatterFor(timeZone).formatToParts(ms).map(p => [p.type, p.value]))
  if (!parts.weekday || !parts.day || !parts.month || !parts.year) return null
  return `${parts.weekday} ${parts.day} ${parts.month.slice(0, 3)} ${parts.year}`
}
