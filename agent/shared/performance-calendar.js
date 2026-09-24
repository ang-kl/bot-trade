// Reporting calendar only. Risk limits retain their separate broker-day clock.
const formatters = new Map()
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    if (formatters.size >= 64) formatters.clear()
    formatters.set(timeZone, f)
  }
  return formatters.get(timeZone)
}
export function calendarDate(nowMs, timeZone) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(nowMs).map(p => [p.type, p.value]))
  return `${p.year}-${p.month}-${p.day}`
}
// Find the first instant of the date, including midnight offset changes. No
// fixed 24-hour subtraction: local days can last 23 or 25 hours at DST changes.
export function calendarStart(date, timeZone) {
  const noon = Date.parse(`${date}T12:00:00Z`)
  let lo = noon - 36 * 3600000, hi = noon + 36 * 3600000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (calendarDate(mid, timeZone) < date) lo = mid + 1
    else hi = mid
  }
  return lo
}
export const calendarDay = (nowMs, timeZone) => calendarStart(calendarDate(nowMs, timeZone), timeZone)
export function calendarLedgerWindows(windows, nowMs, timeZone) {
  const date = calendarDate(nowMs, timeZone), day = Date.parse(`${date}T12:00:00Z`)
  const shift = n => calendarStart(new Date(day + n * 86400000).toISOString().slice(0, 10), timeZone)
  const month = date.slice(0, 7) + '-01'
  const m = new Date(`${month}T12:00:00Z`); m.setUTCMonth(m.getUTCMonth() - 1)
  const bounds = { yesterday: [shift(-1), shift(0)], '3d': [shift(-3), shift(0)],
    wtd: [shift(-((new Date(day).getUTCDay() + 6) % 7)), nowMs],
    mtd: [calendarStart(month, timeZone), nowMs],
    lastmonth: [calendarStart(m.toISOString().slice(0, 10), timeZone), calendarStart(month, timeZone)] }
  return windows.map(w => bounds[w.key] ? { ...w, from: bounds[w.key][0], to: bounds[w.key][1] } : w)
}
