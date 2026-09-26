// Exchange cash sessions for the "Today by market session" report (V3 WEB-6).
//
// REPORTING ONLY. No admission, risk or order path reads this module: whether
// an order may be sent is decided by the account calendar (entry-hours.js, V3 S-8): the
// broker's own schedule and holidays. This table answers one question for a close that has
// already happened — was that exchange's regular cash market trading at the
// close instant? — and answers it in the exchange's own IANA zone, so every
// DST change moves the UTC window with it (ASX from Sun 4 Oct 2026, LSE from
// Sun 25 Oct 2026, NYSE from Sun 1 Nov 2026, and back in March/April).
//
// The table it replaces was fixed UTC minutes-of-day at one season's offsets:
// ASX's AEDT window crosses UTC midnight, which a minute-of-day range cannot
// express at all, and TSE was coded to its pre-November-2024 15:00 close.
//
// HOLIDAYS AND EARLY CLOSES (V3 WEB-6b, 26-09-2026) are applied only where the
// broker lists them: an exchange's closures come from the accounts' own broker
// calendars (market-calendar.js) of the stocks listed on it, found by symbol
// suffix (SESSION_HOLIDAY_EVIDENCE: HKEX ← .HK, NYSE ← .US — the only
// exchanges whose stocks the universe holds). A full-day 0/0 row closes its
// whole local day (owner OD-7), a row with explicit bounds closes that part
// (an early close is such a row); rows with omitted or other invalid bounds
// are not applied and are counted. The other four exchanges keep regular
// hours only, and the payload says so per session (`holidays.status`), as
// does the card. Worst case under OD-7: a holiday's closes land in OFF when
// the exchange was in fact trading, never the reverse.
//
// The hours are exchange rules, not facts this repo or production can verify
// (external knowledge, stated here so a reviewer can check them): ASX
// 10:00–16:00; SGX 09:00–17:00 continuous; HKEX 09:30–12:00 and 13:00–16:00;
// TSE 09:00–11:30 and 12:30–15:30 (the 15:30 close since 5 Nov 2024); LSE
// 08:00–16:30; NYSE 09:30–16:00. Monday–Friday in local time. Auctions and
// extended hours are outside the buckets.
//
// A LEAF module (imports nothing) so the server report and the browser card
// read one table: the UI's former private copy is gone.

export const SESSION_SOURCE = 'exchange_cash_hours_iana_dst'
export const SESSION_EXCEPTIONS = 'holidays_and_early_closes_not_applied'
/** WEB-6b: the payload's `exceptions` when broker closures were applied to at least one exchange. */
export const SESSION_EXCEPTIONS_APPLIED = 'broker_holidays_and_early_closes_applied_where_listed'
/** WEB-6b: which exchanges' closures the broker calendars can evidence, by stock-symbol suffix. */
export const SESSION_HOLIDAY_EVIDENCE = Object.freeze({ HKEX: '.HK', NYSE: '.US' })

const freeze = s => Object.freeze({ ...s, hours: Object.freeze(s.hours.map(h => Object.freeze([...h]))) })
export const REPORT_SESSIONS = Object.freeze([
  { key: 'SYD (ASX)', exchange: 'ASX', tz: 'Australia/Sydney', hours: [['10:00', '16:00']],
    note: 'ASX cash equities, not the FX Sydney session' },
  { key: 'SG', exchange: 'SGX', tz: 'Asia/Singapore', hours: [['09:00', '17:00']] },
  { key: 'HK', exchange: 'HKEX', tz: 'Asia/Hong_Kong', hours: [['09:30', '12:00'], ['13:00', '16:00']] },
  { key: 'JPN', exchange: 'TSE', tz: 'Asia/Tokyo', hours: [['09:00', '11:30'], ['12:30', '15:30']] },
  { key: 'EUR', exchange: 'LSE', tz: 'Europe/London', hours: [['08:00', '16:30']] },
  { key: 'NY', exchange: 'NYSE', tz: 'America/New_York', hours: [['09:30', '16:00']] },
].map(freeze))

const DAY = 86400000
const formatters = new Map()
function wallParts(ms, timeZone) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    if (formatters.size >= 64) formatters.clear()
    formatters.set(timeZone, f)
  }
  const p = {}
  for (const x of f.formatToParts(ms)) p[x.type] = x.value
  return p
}
// Local wall clock minus UTC at an instant, in ms (AEDT +11 h, EST −5 h).
function offsetAt(ms, timeZone) {
  const p = wallParts(ms, timeZone)
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000
}
/** The UTC instant of wall-clock `hhmm` on civil `date` (YYYY-MM-DD) in
 * `timeZone`. The offset is read at the first estimate and then re-read at
 * the result, so a date on the far side of a DST change gets its own offset.
 * Cash hours never sit inside a DST gap or fold (changes happen 01:00–03:00
 * local), so the second read is exact for every time this table holds. */
export function wallClockToUtc(date, hhmm, timeZone) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, h, mi)
  const first = naive - offsetAt(naive, timeZone)
  return naive - offsetAt(first, timeZone)
}
const localDate = (ms, timeZone) => { const p = wallParts(ms, timeZone); return `${p.year}-${p.month}-${p.day}` }

/** Every regular cash interval of `session` that overlaps [from, to), each
 * keyed to the exchange's own session date. Weekdays are judged in the
 * exchange's zone: ASX's Monday session opens on Sunday in UTC. */
export function sessionIntervals(session, from, to) {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return []
  if (to - from > 14 * DAY) throw new Error('report_session_window_bound')
  const out = []
  const first = Date.parse(`${localDate(from, session.tz)}T00:00:00Z`) - DAY
  const last = Date.parse(`${localDate(to, session.tz)}T00:00:00Z`) + DAY
  for (let d = first; d <= last; d += DAY) {
    const weekday = new Date(d).getUTCDay()   // a civil date's weekday is zone-free
    if (weekday === 0 || weekday === 6) continue
    const date = new Date(d).toISOString().slice(0, 10)
    for (const [open, close] of session.hours) {
      const a = wallClockToUtc(date, open, session.tz), b = wallClockToUtc(date, close, session.tz)
      if (b > from && a < to) out.push({ date, from: a, to: b })
    }
  }
  return out
}
export const inIntervals = (t, intervals) => intervals.some(i => t >= i.from && t < i.to)
/** Regular cash hours only — true on a public holiday that falls on a weekday. */
export const sessionOpenAt = (session, t) => inIntervals(t, sessionIntervals(session, t, t + 1))

const utcHhmm = ms => new Date(ms).toISOString().slice(11, 16)
/** The row's tooltip: the rule, the zone, and the UTC intervals it produced
 * for the window actually reported — so the reader can see the DST shift. */
export function sessionHint(session, intervals = null, holidays = null) {
  const rule = `${session.exchange} ${session.hours.map(([a, b]) => `${a}–${b}`).join(' and ')} ${session.tz} local time, Mon–Fri`
  const seen = intervals?.length
    ? ` · intervals overlapping today's window: ${intervals.map(i => `${i.date} ${utcHhmm(i.from)}–${utcHhmm(i.to)} UTC`).join(', ')}`
    : intervals ? ' · no cash session overlaps today\'s window' : ''
  // WEB-6b: what the REPORT says it applied; without a report, nothing is claimed.
  let exceptions = 'public holidays and early closes not applied (WEB-6b)'
  if (holidays?.status === 'applied') {
    const cut = holidays.closures?.length
      ? `; closed in today's window: ${holidays.closures.map(c => `${c.date}${c.name ? ` ${c.name}` : ''} ${c.fullDay ? 'all day' : `${utcHhmm(c.from)}–${utcHhmm(c.to)} UTC`}`).join(', ')}`
      : '; none in today\'s window'
    exceptions = `broker-listed holidays and early closes applied (${holidays.identities} ${session.exchange} calendar${holidays.identities === 1 ? '' : 's'}${cut})`
  } else if (holidays?.status === 'no_evidence' || holidays?.status === 'not_listed') {
    exceptions = `public holidays and early closes not applied: no broker calendar of a ${session.exchange} stock (WEB-6b)`
  } else if (holidays?.status === 'unavailable') {
    exceptions = 'public holidays and early closes not applied: the broker calendars could not be read (WEB-6b)'
  }
  return `${rule}${session.note ? ` (${session.note})` : ''} · ${exceptions}${seen}`
}

// --- V3 WEB-6b: broker-listed holidays and early closes ---------------------

const isInt = (n, lo, hi) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi
const pad = n => String(n).padStart(2, '0')
/** A holiday row's closed part of its local day, in seconds [start, end), or
 * null when its bounds cannot be read. 0/0 is the whole local day (owner
 * OD-7, as market-calendar.js reads it since V3 K3). */
export function holidayWindowSeconds(row) {
  const a = row?.startSecond, b = row?.endSecond
  if (a === 0 && b === 0) return { start: 0, end: 86400 }
  if (isInt(a, 0, 86399) && isInt(b, 1, 86400) && a < b) return { start: a, end: b }
  return null
}
function wallSecondToUtc(date, second, timeZone) {
  if (second >= 86400) {
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
    return wallClockToUtc(next, '00:00', timeZone)
  }
  const m = Math.floor(second / 60)
  return wallClockToUtc(date, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, timeZone) + (second % 60) * 1000
}
/**
 * The UTC closures a list of broker holiday rows makes inside [from, to).
 * Row: { dateIso: 'YYYY-MM-DD', startSecond, endSecond, scheduleTimeZone,
 * isRecurring, name }. A recurring row closes the same month-day every year.
 * Returns { closures: [{ date, from, to, name, fullDay }], unreadable }.
 */
export function closureIntervals(rows, from, to) {
  const out = []
  let unreadable = 0
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from) || !Array.isArray(rows)) return { closures: out, unreadable }
  const y0 = new Date(from).getUTCFullYear() - 1, y1 = new Date(to).getUTCFullYear() + 1
  for (const row of rows) {
    const w = holidayWindowSeconds(row)
    if (!w || typeof row?.dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.dateIso) || typeof row.scheduleTimeZone !== 'string') { unreadable++; continue }
    const dates = row.isRecurring === true
      ? Array.from({ length: y1 - y0 + 1 }, (_, i) => `${y0 + i}${row.dateIso.slice(4)}`)
      : [row.dateIso]
    for (const date of dates) {
      let a, b
      try { a = wallSecondToUtc(date, w.start, row.scheduleTimeZone); b = wallSecondToUtc(date, w.end, row.scheduleTimeZone) } catch { unreadable++; break }
      if (b > from && a < to) out.push({ date, from: a, to: b, name: row.name ?? null, fullDay: w.start === 0 && w.end === 86400 })
    }
  }
  return { closures: out.sort((x, y) => x.from - y.from), unreadable }
}
/** Session intervals with every closure cut out; each piece keeps its date. */
export function subtractIntervals(intervals, closures) {
  if (!closures?.length) return intervals
  let pieces = intervals.map(i => ({ ...i }))
  for (const c of closures) {
    const next = []
    for (const p of pieces) {
      if (c.to <= p.from || c.from >= p.to) { next.push(p); continue }
      if (c.from > p.from) next.push({ ...p, to: c.from })
      if (c.to < p.to) next.push({ ...p, from: c.to })
    }
    pieces = next
  }
  return pieces
}
