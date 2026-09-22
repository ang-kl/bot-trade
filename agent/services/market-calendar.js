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

// Validate the full message. Silently dropping an invalid interval can turn
// incomplete broker evidence into a false CLOSED/OPEN result.
function validateCalendar(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'calendar_malformed'
  if (!validZone(raw.scheduleTimeZone)) return 'calendar_timezone_invalid'
  if (!Array.isArray(raw.schedule) || raw.schedule.length === 0) return 'calendar_schedule_missing'
  if (raw.schedule.length > 128 || raw.schedule.some(iv => !iv
    || !integer(iv.startSecond, 0, WEEK - 1) || !integer(iv.endSecond, 0, WEEK)
    || iv.startSecond === iv.endSecond)) return 'calendar_schedule_invalid'
  // Repeated fields may be omitted in protobuf JSON; absence means no holiday
  // entries in this full symbol response. Explicit null/malformed is unknown.
  if (!Array.isArray(raw.holiday) || raw.holiday.length > 366) return 'calendar_holidays_invalid'
  for (const h of raw.holiday) {
    if (!h || !validZone(h.scheduleTimeZone) || !integer(h.holidayDate, 0, 2932896)
      || typeof h.isRecurring !== 'boolean') return 'calendar_holiday_invalid'
    // The API reference does not define the business meaning of omitted
    // optional holiday boundaries. Keep these unknown rather than invent a
    // full-day closure or ignore the holiday. Explicit broker bounds work.
    if (!integer(h.startSecond, 0, DAY - 1) || !integer(h.endSecond, 1, DAY)
      || h.startSecond >= h.endSecond) return 'calendar_holiday_window_unknown'
  }
  if (raw.tradingMode !== null && !MODES.includes(raw.tradingMode)) return 'calendar_trading_mode_invalid'
  return null
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
  let reason = validateCalendar(calendar)
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
  // invalid response or claim that an old observation was refreshed.
  const lastVerified = !reason ? observation
    : previous?.lastVerified?.schemaVersion === 1
      && marketIdentityKey(previous.lastVerified.identity) === marketIdentityKey(identity)
      && !validateCalendar(previous.lastVerified.calendar)
      && previous.lastVerified.version === hash(previous.lastVerified.calendar)
      ? previous.lastVerified : null
  setState(db, keyFor(identity), JSON.stringify({ latest: observation, lastVerified }))
  return { recorded: true, reason, version: observation.version }
}

/** Pure evaluation, using each holiday's own zone and the symbol's IANA zone. */
function calendarAt(calendar, now) {
  for (const h of calendar.holiday) {
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

/** Account/feed-specific evidence; never consults the symbol-name legacy cache. */
export function readMarketCalendar(db, input, { nowMs = Date.now(), maxAgeMs = CALENDAR_MAX_AGE_MS } = {}) {
  const identity = marketIdentity(input)
  const result = {
    identity, marketStatus: 'MARKET_STATUS_UNKNOWN', open: null, reason: null,
    observedAt: null, sourceTimestamp: null, ageMs: null, maxAgeMs,
    expiresAt: null, source: null, version: null, calendar: null,
    tradingMode: null, entryPermissionKnown: false, lastVerified: null,
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
    && !validateCalendar(last.calendar) && last.version === hash(last.calendar)) {
    result.lastVerified = { observedAt: last.observedAt, version: last.version, calendar: last.calendar }
  }
  if (result.ageMs < 0) return unknown('observation_time_future')
  if (snapshot.reason) return unknown(snapshot.reason)
  if (result.ageMs >= maxAgeMs) return unknown('calendar_stale')
  const invalid = validateCalendar(snapshot.calendar)
  if (invalid) return unknown(invalid)
  if (snapshot.version !== hash(snapshot.calendar)) return unknown('calendar_version_mismatch')
  const state = calendarAt(snapshot.calendar, new Date(nowMs))
  return {
    ...result, ...state, marketStatus: state.open ? 'OPEN' : 'CLOSED', calendar: snapshot.calendar,
    tradingMode: snapshot.calendar.tradingMode,
    entryPermissionKnown: snapshot.calendar.tradingMode !== null,
  }
}
