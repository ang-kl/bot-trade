import { populationStats } from '../../agent/shared/performance-populations.js'
import { calendarDate } from '../../agent/shared/performance-calendar.js'
/** Complete daily recorded-close series, starting at zero in the chosen
 * range. Neither cash balance nor floating equity. Never pools account units. */
export function performanceCurve(report, accountId, dailyDecisions, rangeDays) {
  const asOf = report?.asOfMs
  const cutoff = rangeDays && asOf ? asOf - rangeDays * 86400000 : 0
  const inRange = day => report?.timeZone
    ? !cutoff || day >= calendarDate(cutoff, report.timeZone)
    : Date.parse(day) + 86400000 > cutoff
  const groups = (report?.daily || []).filter(g => (accountId === 'all' || g.accountId === String(accountId)) && inRange(g.day))
  const total = populationStats(groups, { available: report?.status === 'complete', accountId })
  const moneyAvailable = total.pnl != null && total.unpricedN === 0
  const days = new Map()
  const bucket = day => {
    if (!days.has(day)) days.set(day, { t: Date.parse(day), approved: 0, vetoed: 0, pnl: null })
    return days.get(day)
  }
  if (Array.isArray(dailyDecisions)) for (const d of dailyDecisions) {
    if (!Number.isFinite(Date.parse(d.day)) || !inRange(d.day)) continue
    const b = bucket(d.day); b.approved = Number(d.approved) || 0; b.vetoed = Number(d.vetoed) || 0
  }
  const byDay = new Map()
  for (const g of groups) { if (!byDay.has(g.day)) byDay.set(g.day, []); byDay.get(g.day).push(g) }
  for (const [day, list] of byDay) bucket(day).pnl = populationStats(list, { accountId }).pnl
  // Calendar reports continue through today even when no new trade closed.
  // These are known zero-close days, not fabricated floating equity samples.
  if (report?.status === 'complete' && report.timeZone && asOf) {
    const today = calendarDate(asOf, report.timeZone)
    const first = [...days.keys()].sort()[0] || today
    for (let d = Date.parse(first); d <= Date.parse(today); d += 86400000) bucket(new Date(d).toISOString().slice(0, 10))
  }
  let profit = 0, peak = 0
  const rows = [...days.values()].sort((a, b) => a.t - b.t).map(row => {
    if (moneyAvailable) { profit += row.pnl ?? 0; peak = Math.max(peak, profit) }
    return { ...row, equity: moneyAvailable ? profit : null, peak: moneyAvailable ? peak : null, dd: moneyAvailable ? profit - peak : null }
  })
  return { rows, moneyAvailable, pricedN: total.pricedN, unpricedN: total.unpricedN,
    decisionState: Array.isArray(dailyDecisions) ? 'recorded_daily_aggregate' : 'unavailable',
    reason: moneyAvailable ? 'recorded_close_units' : total.unpricedN > 0 ? 'unpriced_closes' : total.moneyState }
}
