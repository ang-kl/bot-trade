// Exchange cash sessions for the "Today by market session" report (V3 WEB-6).
//
// REPORTING ONLY. No admission, risk or order path reads this module: whether
// an order may be sent is decided by sessions.js / symbol-hours.js and the
// broker's own schedule. This table answers one question for a close that has
// already happened — was that exchange's regular cash market trading at the
// close instant? — and answers it in the exchange's own IANA zone, so every
// DST change moves the UTC window with it (ASX from Sun 4 Oct 2026, LSE from
// Sun 25 Oct 2026, NYSE from Sun 1 Nov 2026, and back in March/April).
//
// The table it replaces was fixed UTC minutes-of-day at one season's offsets:
// ASX's AEDT window crosses UTC midnight, which a minute-of-day range cannot
// express at all, and TSE was coded to its pre-November-2024 15:00 close.
//
// REGULAR HOURS ONLY. Public holidays and early closes are NOT applied yet
// (WEB-6b): on an exchange holiday its row still counts closes made in its
// usual hours. The report payload says so (`exceptions`), and so does the card.
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
export function sessionHint(session, intervals = null) {
  const rule = `${session.exchange} ${session.hours.map(([a, b]) => `${a}–${b}`).join(' and ')} ${session.tz} local time, Mon–Fri`
  const seen = intervals?.length
    ? ` · intervals overlapping today's window: ${intervals.map(i => `${i.date} ${utcHhmm(i.from)}–${utcHhmm(i.to)} UTC`).join(', ')}`
    : intervals ? ' · no cash session overlaps today\'s window' : ''
  return `${rule}${session.note ? ` (${session.note})` : ''} · public holidays and early closes not applied (WEB-6b)${seen}`
}
