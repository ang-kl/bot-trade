// UTC projection of the existing calendar semantics for read-only consumers.
// Scanners/verifier do not invent another regional-hours or crypto calendar.
import { calendarAt, calendarHolidayWindow } from '../services/market-calendar.js'
const DAY = 86400_000, HOUR = 3600_000
const formatters = new Map(), windows = new Map()
function localStamp(at, zone) {
  if (!formatters.has(zone)) {
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value)
    formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }))
  }
  const p = Object.fromEntries(formatters.get(zone).formatToParts(at).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
}
const offset = (at, zone) => localStamp(at, zone) - Math.floor(at / 1000) * 1000

/** Resolve every local boundary using all observed offsets, including folds.
 * Offset transitions themselves are boundaries, including nonexistent times
 * in the spring gap. Work is bounded by ten UTC days and broker interval caps.
 */
export function calendarIntervals(calendar, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || to - from > 10 * DAY) throw new RangeError('calendar projection window')
  const bounds = new Set([from, to]), zones = new Map()
  const getZone = zone => {
    if (zones.has(zone)) return zones.get(zone)
    const offsets = new Set()
    let previousAt = from - 2 * DAY, previous = offset(previousAt, zone)
    offsets.add(previous)
    for (let at = previousAt + HOUR; at <= to + 2 * DAY + HOUR; at += HOUR) {
      const next = offset(at, zone); offsets.add(next)
      if (next !== previous) {
        let lo = previousAt, hi = at
        while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (offset(mid, zone) === previous) lo = mid; else hi = mid }
        if (hi > from && hi < to) bounds.add(hi)
      }
      previousAt = at; previous = next
    }
    zones.set(zone, offsets); return offsets
  }
  const addLocal = (local, zone) => {
    for (const shift of getZone(zone)) {
      const utc = local - shift
      if (utc > from && utc < to && localStamp(utc, zone) === local) bounds.add(utc)
    }
  }
  for (let day = Math.floor(from / DAY) * DAY - 2 * DAY; day <= to + 2 * DAY; day += DAY) {
    const weekday = new Date(day).getUTCDay()
    for (const iv of calendar.schedule) for (const sec of [iv.startSecond, iv.endSecond]) {
      if (Math.floor(sec / 86400) % 7 === weekday) addLocal(day + (sec % 86400) * 1000, calendar.scheduleTimeZone)
    }
    const date = new Date(day).toISOString().slice(0, 10)
    for (const h of calendar.holiday) {
      const match = new Date(h.holidayDate * DAY).toISOString().slice(0, 10)
      if (h.isRecurring ? date.slice(5) === match.slice(5) : date === match) {
        // V3 K3: a 0/0 row's window is the whole local day, so its end is
        // the next local midnight (86400 s), not 0 — the same window
        // calendarAt evaluates.
        const w = calendarHolidayWindow(h)
        addLocal(day + w.start * 1000, h.scheduleTimeZone)
        addLocal(day + w.end * 1000, h.scheduleTimeZone)
      }
    }
  }
  // Even an always-open weekly interval can cross a zone offset transition.
  getZone(calendar.scheduleTimeZone)
  const ordered = [...bounds].sort((a, b) => a - b), result = []
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i]
    if (!calendarAt(calendar, new Date(a)).open) continue
    if (result.at(-1)?.toMs === a) result.at(-1).toMs = b
    else result.push({ fromMs: a, toMs: b })
  }
  if (result.length > 256) throw new RangeError('calendar projection interval bound')
  return result
}

/**
 * V3 K1: the projection as the watchdog contract carries it — exactly the
 * fields cpp-verify's market() reads (watchdog_state.cpp:19-42: identity,
 * source, version, observedAtMs, expiresAtMs, fromMs, toMs, intervals), with
 * the window starting one UTC day before today instead of eight. The verifier
 * only asks "is `now` inside an interval" for as long as the observation is
 * fresh (24 h), and toMs is unchanged (today + 2 days), so a retained
 * contract answers the same through a Node outage. sessionOpenedAtMs,
 * sessionId and nextOpeningMs stay on the work items that need them; the
 * verifier reads them there, never from a calendar. Returns null for null.
 */
export function contractCalendar(projection, now = Date.now()) {
  if (!projection) return null
  const from = Math.max(projection.fromMs, Math.floor(now / DAY) * DAY - DAY)
  const intervals = []
  for (const iv of projection.intervals) if (iv.toMs > from) intervals.push({ fromMs: Math.max(iv.fromMs, from), toMs: iv.toMs })
  return { identity: projection.identity, source: projection.source, version: projection.version,
    observedAtMs: projection.observedAtMs, expiresAtMs: projection.expiresAtMs, fromMs: from, toMs: projection.toMs, intervals }
}

export function projectCalendar(evidence, now = Date.now()) {
  if (!evidence?.calendar || evidence.marketStatus === 'MARKET_STATUS_UNKNOWN') return null
  const from = Math.floor(now / DAY) * DAY - 8 * DAY, to = Math.floor(now / DAY) * DAY + 2 * DAY
  const key = `${evidence.version}:${from}`
  if (!windows.has(key)) {
    if (windows.size >= 128) windows.delete(windows.keys().next().value)
    windows.set(key, calendarIntervals(evidence.calendar, from, to))
  }
  const intervals = windows.get(key), current = intervals.find(i => i.fromMs <= now && now < i.toMs)
  // If our bounded lookback starts inside an already-open session, its real
  // start is unknown. Do not manufacture a daily opening for a 24/7 market.
  const opened = current && current.fromMs > from ? current.fromMs : null
  return { identity: evidence.identity, source: evidence.source, version: evidence.version,
    observedAtMs: Date.parse(evidence.observedAt), expiresAtMs: Date.parse(evidence.expiresAt), fromMs: from, toMs: to,
    intervals, sessionOpenedAtMs: opened, sessionId: opened == null ? null : `${evidence.version}:${opened}`,
    nextOpeningMs: intervals.find(i => i.fromMs > now)?.fromMs ?? null }
}
