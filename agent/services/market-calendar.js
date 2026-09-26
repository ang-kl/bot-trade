import { createHash } from 'node:crypto'
import { getState, setState } from '../db.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'

// An observation/read-model limit, not a new trading gate. The existing hours
// refresh is approximately daily. Callers must show the actual age and policy.
export const CALENDAR_MAX_AGE_MS = 24 * 3600_000
const DAY = 86400, WEEK = 7 * DAY
const MAX_BYTES = 65536
const MODES = ['ENABLED', 'DISABLED_WITHOUT_PENDINGS_EXECUTION', 'DISABLED_WITH_PENDINGS_EXECUTION', 'CLOSE_ONLY_MODE']
const keyFor = identity => `market_calendar:v1:${marketIdentityKey(identity)}`
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const integer = (n, min, max) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

// A symbol batch can repeat the same holiday zone thousands of times. Cache
// only bounded, immutable formatters; never calendar observations or status.
const zoneFormatters = new Map()
function formatterFor(timeZone) {
  if (zoneFormatters.has(timeZone)) return zoneFormatters.get(timeZone)
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  if (zoneFormatters.size >= 32) zoneFormatters.delete(zoneFormatters.keys().next().value)
  zoneFormatters.set(timeZone, formatter)
  return formatter
}
function zonedParts(now, timeZone) {
  return Object.fromEntries(formatterFor(timeZone).formatToParts(now).map(p => [p.type, p.value]))
}
function validZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 100) return false
  try { formatterFor(zone); return true } catch { return false }
}

// V3 K1: the one code 'calendar_holiday_window_unknown' used to cover two
// different broker facts, so a reason histogram could not tell them apart:
//   holiday_bounds_omitted — a holiday whose startSecond and/or endSecond the
//     broker did not send (the API reference does not define what an omitted
//     bound means; K3 asks the owner before giving it one);
//   holiday_bounds_invalid — both bounds sent, but out of range or start >= end.
//     Production sends startSecond 0 AND endSecond 0 on its full-day "Closed"
//     rows ("25.12.2025 - Closed", "07.09.2026 Closed"; measured 26-09 on all
//     335 unresolved rows): that is this code, not an omitted bound.
// Both keep the WHOLE calendar unknown, exactly as before: no boundary is
// invented here. Rows stored under the old code are mapped on read (below).
export const HOLIDAY_BOUNDS_OMITTED = 'holiday_bounds_omitted'
export const HOLIDAY_BOUNDS_INVALID = 'holiday_bounds_invalid'
const LEGACY_HOLIDAY_WINDOW_UNKNOWN = 'calendar_holiday_window_unknown'
const present = value => value !== undefined && value !== null
function holidayBoundsReason(h) {
  if (!present(h.startSecond) || !present(h.endSecond)) return HOLIDAY_BOUNDS_OMITTED
  if (!integer(h.startSecond, 0, DAY - 1) || !integer(h.endSecond, 1, DAY)
    || h.startSecond >= h.endSecond) return HOLIDAY_BOUNDS_INVALID
  return null
}

// V3 K1b: a NON-recurring holiday row whose bounds cannot be read, dated so
// far before the observation that it cannot touch any window this observation
// is evaluated in, is skipped instead of making the whole calendar unknown.
// The arithmetic, with D = holidayDate (the row's local date, in days since
// the epoch) and O = the observation's UTC day:
//   - local date D ends, in the westernmost zone (UTC-12), at D + 36 h UTC,
//     so the row can cover no instant at or after that;
//   - every reader evaluates at now >= observedAt (readMarketCalendar refuses
//     a future observation); calendarAt matches only today's local date; the
//     contract window (calendar-intervals.js contractCalendar) starts at the
//     UTC day of now minus one day, so at day O - 1 at the earliest;
//   - D + 36 h <= (O - 1) days exactly when D <= O - 2.5, i.e. D <= O - 3.
// So a row with D <= O - 3 lies wholly before every window; D = O - 2 can
// still reach the first contract day and stays unknown, as does every current
// or future row. This gives an unreadable bound NO meaning — what a current
// 0/0 row means (a whole local day?) is the owner's K3 decision, not made
// here. The row stays in the stored payload (the version hash is unchanged),
// is never evaluated (calendarAt skips it), and is listed as
// holiday_expired_ignored, never silently dropped. A recurring row returns
// every year, so it never expires.
export const HOLIDAY_EXPIRED_IGNORED = 'holiday_expired_ignored'
export const HOLIDAY_EXPIRY_UTC_DAYS = 3
function holidayExpired(h, observedMs) {
  return h.isRecurring === false && integer(h.holidayDate, 0, 2932896) && Number.isFinite(observedMs)
    && h.holidayDate <= Math.floor(observedMs / (DAY * 1000)) - HOLIDAY_EXPIRY_UTC_DAYS
}
// A row's bounds verdict for one observation: null (explicit valid bounds),
// holiday_expired_ignored, or the bounds code that keeps the calendar unknown.
function holidayStatus(h, observedMs) {
  const bounds = holidayBoundsReason(h)
  return bounds && holidayExpired(h, observedMs) ? HOLIDAY_EXPIRED_IGNORED : bounds
}

// Validate the full message. Silently dropping an invalid interval can turn
// incomplete broker evidence into a false CLOSED/OPEN result. `observedMs` is
// the observation's own receipt time (V3 K1b: it decides which unreadable
// holiday rows already lie behind every evaluation window); without a valid
// one nothing is skipped.
function validateCalendar(raw, observedMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'calendar_malformed'
  if (!validZone(raw.scheduleTimeZone)) return 'calendar_timezone_invalid'
  if (!Array.isArray(raw.schedule) || raw.schedule.length === 0) return 'calendar_schedule_missing'
  if (raw.schedule.length > 128 || raw.schedule.some(iv => !iv
    || !integer(iv.startSecond, 0, WEEK - 1) || !integer(iv.endSecond, 0, WEEK)
    || iv.startSecond === iv.endSecond)) return 'calendar_schedule_invalid'
  // Repeated fields may be omitted in protobuf JSON; absence means no holiday
  // entries in this full symbol response. Explicit null/malformed is unknown.
  if (!Array.isArray(raw.holiday) || raw.holiday.length > 366) return 'calendar_holidays_invalid'
  // Precedence, independent of holiday order: a structurally broken holiday,
  // then present-but-invalid bounds, then omitted bounds. So a calendar reads
  // holiday_bounds_omitted only when omitted bounds are its ONLY defect.
  let omitted = false, invalid = false
  for (const h of raw.holiday) {
    if (!h || !validZone(h.scheduleTimeZone) || !integer(h.holidayDate, 0, 2932896)
      || typeof h.isRecurring !== 'boolean') return 'calendar_holiday_invalid'
    // The API reference does not define the business meaning of omitted
    // optional holiday boundaries, nor of the 0/0 pair production sends.
    // Keep these unknown rather than invent a full-day closure or ignore the
    // holiday — unless the row already lies behind every window (K1b, above).
    // Explicit broker bounds work.
    const bounds = holidayStatus(h, observedMs)
    if (bounds === HOLIDAY_BOUNDS_OMITTED) omitted = true
    else if (bounds === HOLIDAY_BOUNDS_INVALID) invalid = true
  }
  if (invalid) return HOLIDAY_BOUNDS_INVALID
  if (omitted) return HOLIDAY_BOUNDS_OMITTED
  if (raw.tradingMode !== null && !MODES.includes(raw.tradingMode)) return 'calendar_trading_mode_invalid'
  return null
}

const clipText = value => typeof value === 'string' ? value.slice(0, 200) : value == null ? null : String(value).slice(0, 200)
/**
 * V3 K1 diagnostic: the broker's own holiday rows that keep this calendar
 * unknown (omitted or invalid bounds), read from the STORED latest
 * observation — the payload no GET could show before, because an unknown
 * calendar is returned with `calendar: null`. At most 366 entries (the
 * validator's own holiday bound). A bound the broker did not send is ABSENT
 * here, never filled in; a bound it sent is copied as sent. Changes no status.
 * V3 K1b: `reason` stays the row's bounds verdict as sent; a row skipped
 * because it lies behind every window of THIS observation (`observedMs`) also
 * carries `ignored: 'holiday_expired_ignored'`. `which` selects: 'all',
 * 'unresolved' (rows that keep the calendar unknown) or 'expired' (the rows
 * skipped — listed, so nothing is hidden).
 */
function holidayRows(calendar, which, observedMs) {
  if (!calendar || typeof calendar !== 'object' || !Array.isArray(calendar.holiday)) return null
  const out = []
  for (const h of calendar.holiday) {
    if (out.length >= 366) break
    if (!h || typeof h !== 'object') continue
    const reason = holidayBoundsReason(h)
    const ignored = reason != null && holidayStatus(h, observedMs) === HOLIDAY_EXPIRED_IGNORED
    if (which === 'unresolved' && (!reason || ignored)) continue
    if (which === 'expired' && !ignored) continue
    const date = integer(h.holidayDate, 0, 2932896) ? new Date(h.holidayDate * DAY * 1000).toISOString().slice(0, 10) : null
    out.push({ reason, ...(ignored ? { ignored: HOLIDAY_EXPIRED_IGNORED } : {}), holidayId: h.holidayId ?? null, name: clipText(h.name), description: clipText(h.description),
      holidayDate: h.holidayDate ?? null, dateIso: date, isRecurring: h.isRecurring ?? null, scheduleTimeZone: clipText(h.scheduleTimeZone),
      ...('startSecond' in h ? { startSecond: h.startSecond } : {}), ...('endSecond' in h ? { endSecond: h.endSecond } : {}) })
  }
  return out
}

/**
 * V3 K1 (the coverage read): EVERY holiday row of the stored latest
 * observation, bounded or not, each with its bounds reason (null = explicit
 * valid bounds) — so a question such as "does the broker list 1 October for
 * this instrument" can be answered whether or not the calendar resolved.
 * V3 K1b: a row skipped as behind every window of that observation carries
 * `ignored: 'holiday_expired_ignored'` (judged at the observation's own time).
 * Only an intact payload (stored version matches) is described; else null.
 */
export function storedHolidays(db, input) {
  const identity = marketIdentity(input)
  if (!identity) return null
  let envelope
  try { envelope = JSON.parse(getState(db, keyFor(identity)) || 'null') } catch { return null }
  const snapshot = envelope?.latest
  if (!snapshot || marketIdentityKey(snapshot.identity) !== marketIdentityKey(identity)
    || snapshot.calendar == null || snapshot.version !== hash(snapshot.calendar)) return null
  const observedAt = typeof snapshot.observedAt === 'string' ? snapshot.observedAt : null
  return { observedAt, holidays: holidayRows(snapshot.calendar, 'all', Date.parse(observedAt)) }
}

function calendarFields(symbol) {
  const mode = symbol?.tradingMode
  return {
    scheduleTimeZone: symbol?.scheduleTimeZone ?? null,
    schedule: symbol?.schedule ?? null,
    holiday: symbol?.holiday === undefined ? [] : symbol.holiday,
    tradingMode: mode == null ? null : typeof mode === 'number' ? MODES[mode] ?? 'INVALID' : mode,
  }
}

/** Capture an existing full-symbol response. No additional broker request. */
export function recordMarketCalendar(db, input, symbol, { nowMs = Date.now() } = {}) {
  const identity = marketIdentity(input)
  if (!identity || String(symbol?.symbolId) !== identity.symbolId) return { recorded: false, reason: 'identity_mismatch' }
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) return { recorded: false, reason: 'observation_time_invalid' }
  let calendar = calendarFields(symbol)
  let reason = validateCalendar(calendar, nowMs)
  if (Buffer.byteLength(JSON.stringify(calendar)) > MAX_BYTES) {
    reason = 'calendar_payload_too_large'
    calendar = null
  }
  const observation = {
    schemaVersion: 1, identity, source: 'ctrader:ProtoOASymbol',
    observedAt: new Date(nowMs).toISOString(), sourceTimestamp: null,
    version: hash(calendar), calendar, reason,
  }
  let previous = null
  try { previous = JSON.parse(getState(db, keyFor(identity)) || 'null') } catch { /* unreadable old evidence */ }
  // Retain bounded last-valid evidence for diagnosis, never to mask a newer
  // invalid response or claim that an old observation was refreshed. It is
  // re-validated at its OWN observation time (V3 K1b), never at this one.
  const lastVerified = !reason ? observation
    : previous?.lastVerified?.schemaVersion === 1
      && marketIdentityKey(previous.lastVerified.identity) === marketIdentityKey(identity)
      && !validateCalendar(previous.lastVerified.calendar, Date.parse(previous.lastVerified.observedAt))
      && previous.lastVerified.version === hash(previous.lastVerified.calendar)
      ? previous.lastVerified : null
  setState(db, keyFor(identity), JSON.stringify({ latest: observation, lastVerified }))
  return { recorded: true, reason, version: observation.version }
}

/**
 * Pure evaluation, using each holiday's own zone and the symbol's IANA zone.
 * V3 K1b: a holiday row whose bounds cannot be read is never evaluated. A
 * validated calendar holds such a row only when it lies behind every window of
 * its observation (holiday_expired_ignored); skipping it keeps the projection's
 * eight-day lookback (calendar-intervals.js projectCalendar) from reading a
 * meaning into it. Every row with explicit valid bounds is evaluated as before.
 */
export function calendarAt(calendar, now) {
  for (const h of calendar.holiday) {
    if (holidayBoundsReason(h)) continue
    const p = zonedParts(now, h.scheduleTimeZone)
    const date = new Date(h.holidayDate * DAY * 1000).toISOString().slice(0, 10)
    const today = `${p.year}-${p.month}-${p.day}`
    if ((h.isRecurring ? today.slice(5) === date.slice(5) : today === date)) {
      const second = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)
      if (second >= h.startSecond && second < h.endSecond) return { open: false, reason: 'broker_holiday' }
    }
  }
  const p = zonedParts(now, calendar.scheduleTimeZone)
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday]
  const second = day * DAY + Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)
  const open = calendar.schedule.some(({ startSecond: a, endSecond: b }) =>
    a < b ? second >= a && second < b : second >= a || second < b)
  return { open, reason: open ? null : 'broker_schedule_closed' }
}

/**
 * Account/feed-specific evidence; never consults the symbol-name legacy cache.
 * `diagnostics: true` (the identity read, GET /state/market-calendar) adds
 * `unresolvedHolidays` and (V3 K1b) `expiredHolidays`: the unreadable-bound
 * rows skipped because they lie behind every window of this observation,
 * listed so a calendar that resolved past them hides nothing. Off by default:
 * the collector reads every demanded calendar each minute on the main thread
 * and needs only the status, and the diagnostic costs a payload hash on every
 * unknown row.
 */
export function readMarketCalendar(db, input, { nowMs = Date.now(), maxAgeMs = CALENDAR_MAX_AGE_MS, diagnostics = false } = {}) {
  const identity = marketIdentity(input)
  const result = {
    identity, marketStatus: 'MARKET_STATUS_UNKNOWN', open: null, reason: null,
    observedAt: null, sourceTimestamp: null, ageMs: null, maxAgeMs,
    expiresAt: null, source: null, version: null, calendar: null,
    tradingMode: null, entryPermissionKnown: false, lastVerified: null,
    ...(diagnostics ? { unresolvedHolidays: null, expiredHolidays: null } : {}),
  }
  const unknown = reason => ({ ...result, reason })
  if (!identity) return unknown('identity_required')
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())
    || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 7 * CALENDAR_MAX_AGE_MS) return unknown('freshness_policy_invalid')
  let envelope
  try { envelope = JSON.parse(getState(db, keyFor(identity)) || 'null') }
  catch { return unknown('calendar_read_failed') }
  if (!envelope) return unknown('calendar_missing')
  const snapshot = envelope.latest
  if (!snapshot || snapshot.schemaVersion !== 1
    || marketIdentityKey(snapshot.identity) !== marketIdentityKey(identity)) return unknown('identity_mismatch')
  if (snapshot.source !== 'ctrader:ProtoOASymbol') return unknown('calendar_source_invalid')
  const validTimestamp = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value))
  if (!validTimestamp(snapshot.observedAt)) return unknown('observation_time_invalid')
  const observed = Date.parse(snapshot.observedAt)
  result.observedAt = snapshot.observedAt
  result.ageMs = nowMs - observed
  const expiry = new Date(observed + maxAgeMs)
  if (!Number.isFinite(expiry.getTime())) return unknown('observation_time_invalid')
  result.expiresAt = expiry.toISOString()
  result.version = snapshot.version
  result.source = snapshot.source
  const last = envelope.lastVerified
  if (last?.schemaVersion === 1 && marketIdentityKey(last.identity) === marketIdentityKey(identity)
    && validTimestamp(last.observedAt) && Date.parse(last.observedAt) <= nowMs
    && !validateCalendar(last.calendar, Date.parse(last.observedAt)) && last.version === hash(last.calendar)) {
    result.lastVerified = { observedAt: last.observedAt, version: last.version, calendar: last.calendar }
  }
  // Only a payload whose stored version still matches is described. Hashed
  // at most once, and only when something needs it.
  let intactMemo = null
  const intact = () => (intactMemo ??= snapshot.calendar != null && snapshot.version === hash(snapshot.calendar))
  if (diagnostics && intact()) {
    result.unresolvedHolidays = holidayRows(snapshot.calendar, 'unresolved', observed)
    result.expiredHolidays = holidayRows(snapshot.calendar, 'expired', observed)
  }
  if (result.ageMs < 0) return unknown('observation_time_future')
  // A holiday-bounds verdict is re-derived from the intact stored payload at
  // the observation's OWN time, never at `now`: a row recorded before the K1
  // split carries the old combined code, and one recorded before K1b was
  // judged without the expiry rule. Same payload, same observation time, so
  // the answer is the one recordMarketCalendar now stores; a payload that no
  // longer matches its version keeps its stored code.
  let stored = snapshot.reason
  if ((stored === LEGACY_HOLIDAY_WINDOW_UNKNOWN || stored === HOLIDAY_BOUNDS_INVALID || stored === HOLIDAY_BOUNDS_OMITTED)
    && intact()) stored = validateCalendar(snapshot.calendar, observed)
  if (stored) return unknown(stored)
  if (result.ageMs >= maxAgeMs) return unknown('calendar_stale')
  const invalid = validateCalendar(snapshot.calendar, observed)
  if (invalid) return unknown(invalid)
  if (!intact()) return unknown('calendar_version_mismatch')
  const state = calendarAt(snapshot.calendar, new Date(nowMs))
  return {
    ...result, ...state, marketStatus: state.open ? 'OPEN' : 'CLOSED', calendar: snapshot.calendar,
    tradingMode: snapshot.calendar.tradingMode,
    entryPermissionKnown: snapshot.calendar.tradingMode !== null,
  }
}
