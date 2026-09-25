import { populationStats } from '../../agent/shared/performance-populations.js'
import { calendarDate } from '../../agent/shared/performance-calendar.js'

const DAY = 86400000
/** Days the chart asks /state/decisions-daily for. risk_events rows are pruned
 * at 90 days (agent/loop.js prune-risk-events), so a day older than this has
 * no retained decision record: its count is unknown, not zero. */
export const DECISION_FEED_DAYS = 90

/** How the money line may be drawn over a set of recorded closes (WEB-10,
 * owner default 25-09: a close with no price is a labelled gap, never zero).
 *  - complete: every close is priced; the line is exact from zero.
 *  - gapped:   some closes are priced and some are not. The line breaks at
 *              every day holding an unpriced close; it is never bridged as
 *              if that close had made nothing.
 *  - withheld: no line (report unavailable, accounts pooled, or no close in
 *              the range has a price). */
export function curveMoney(total) {
  if (total.pnl != null && total.unpricedN === 0) return { moneyState: 'complete', reason: 'recorded_close_units' }
  if (total.pnl != null && total.pricedN > 0) return { moneyState: 'gapped', reason: 'unpriced_closes_drawn_as_gaps' }
  return { moneyState: 'withheld',
    reason: total.moneyState === 'unverified_cross_account_units' ? total.moneyState
      : total.unpricedN > 0 ? 'unpriced_closes' : total.moneyState }
}

/** Complete daily recorded-close series, starting at zero in the chosen
 * range. Neither cash balance nor floating equity. Never pools account units. */
export function performanceCurve(report, accountId, dailyDecisions, rangeDays, { decisionDays = DECISION_FEED_DAYS } = {}) {
  const asOf = report?.asOfMs
  const cutoff = rangeDays && asOf ? asOf - rangeDays * DAY : 0
  const dayOf = ms => report?.timeZone ? calendarDate(ms, report.timeZone) : new Date(ms).toISOString().slice(0, 10)
  const inRange = day => report?.timeZone
    ? !cutoff || day >= calendarDate(cutoff, report.timeZone)
    : Date.parse(day) + DAY > cutoff
  const groups = (report?.daily || []).filter(g => (accountId === 'all' || g.accountId === String(accountId)) && inRange(g.day))
  const total = populationStats(groups, { available: report?.status === 'complete', accountId })
  const money = curveMoney(total)
  const drawn = money.moneyState !== 'withheld'
  const hasDecisions = Array.isArray(dailyDecisions)
  // The decision feed covers the last `decisionDays`. Its border day is only
  // partly covered, so it counts as not retained along with every older day.
  const decisionBorder = hasDecisions && asOf ? dayOf(asOf - decisionDays * DAY) : null
  const days = new Map()
  const bucket = day => {
    if (!days.has(day)) days.set(day, { day, t: Date.parse(day), approved: 0, vetoed: 0, vetoedDistinct: null, pnl: null, closes: 0, unpricedN: 0 })
    return days.get(day)
  }
  if (hasDecisions) for (const d of dailyDecisions) {
    if (!Number.isFinite(Date.parse(d.day)) || !inRange(d.day)) continue
    const b = bucket(d.day); b.approved = Number(d.approved) || 0; b.vetoed = Number(d.vetoed) || 0
    b.vetoedDistinct = d.vetoed_distinct == null ? null : Number(d.vetoed_distinct) || 0
  }
  const byDay = new Map()
  for (const g of groups) { if (!byDay.has(g.day)) byDay.set(g.day, []); byDay.get(g.day).push(g) }
  for (const [day, list] of byDay) {
    const st = populationStats(list, { accountId }), b = bucket(day)
    b.pnl = st.pnl; b.closes = st.n; b.unpricedN = st.unpricedN
  }
  // Calendar reports continue through today even when no new trade closed.
  // These are known zero-close days, not fabricated floating equity samples.
  if (report?.status === 'complete' && report.timeZone && asOf) {
    const today = calendarDate(asOf, report.timeZone)
    const first = [...days.keys()].sort()[0] || today
    for (let d = Date.parse(first); d <= Date.parse(today); d += DAY) bucket(new Date(d).toISOString().slice(0, 10))
  }
  let profit = 0, peak = 0, broken = false
  const rows = [...days.values()].sort((a, b) => a.t - b.t).map(row => {
    const decisionsKnown = hasDecisions && !(decisionBorder && row.day <= decisionBorder)
    const decisions = decisionsKnown ? {} : { approved: null, vetoed: null, vetoedDistinct: null }
    // A day holding an unpriced close starts a new unbroken stretch: the
    // change into that day is unknown, so the line does not bridge it and the
    // stretch's own peak starts from its first point.
    const gap = drawn && row.unpricedN > 0
    if (drawn) {
      profit += row.pnl ?? 0
      peak = gap ? profit : Math.max(peak, profit)
      if (gap) broken = true
    }
    return { ...row, ...decisions, decisionsKnown, gap, afterGap: drawn && broken,
      equity: drawn ? profit : null, peak: drawn ? peak : null, dd: drawn ? profit - peak : null }
  })
  return { rows, moneyAvailable: drawn, moneyState: money.moneyState, pricedN: total.pricedN, unpricedN: total.unpricedN,
    unpricedDays: rows.filter(r => r.unpricedN > 0).length,
    decisionState: hasDecisions ? 'recorded_daily_aggregate' : 'unavailable',
    decisionDaysNotRetained: hasDecisions ? rows.filter(r => !r.decisionsKnown).length : 0,
    reason: money.reason }
}

/** The account the All view's chart opens on when the viewer has not picked
 * one (WEB-10), and the evidence rank it was chosen on, so the page can say
 * why only when a reason was measured:
 *  - rank 0: the first account, in the given order, whose money line is exact
 *            in every range (all its closes priced, judged over the whole
 *            report, so no range can be worse);
 *  - rank 1: no such account; the first whose line draws with labelled gaps;
 *  - rank 2: no account has a priced close; the first known-zero account (no
 *            recorded closes);
 *  - rank 3: every account's line is withheld; the first account;
 *  - rank null: nothing was judged (no complete report, or no accounts); the
 *            first account.
 * Reads only evidence, never the account's kind. */
export function defaultChartAccount(report, accounts = []) {
  const ids = accounts.map(a => String(a.account_id))
  if (report?.status !== 'complete' || !ids.length) return { accountId: ids[0] ?? 'all', rank: null }
  let best = null, bestRank = 3
  for (const id of ids) {
    const groups = (report.daily || []).filter(g => g.accountId === id)
    const total = populationStats(groups, { accountId: id })
    const { moneyState } = curveMoney(total)
    const rank = moneyState === 'complete' ? (total.n > 0 ? 0 : 2) : moneyState === 'gapped' ? 1 : 3
    if (rank < bestRank) { best = id; bestRank = rank }
  }
  return { accountId: best ?? ids[0], rank: bestRank }
}

/** What the All view may say about the account it opened on, or null when the
 * choice was not measured (WEB-10: no sentence without the evidence for it). */
export function defaultChartReason(rank) {
  if (rank === 0) return 'Opened on the first account whose recorded closes all have a price.'
  if (rank === 1) return 'Opened on the first account with priced closes: every account with closes has some without a price, so its unpriced closes show as labelled gaps.'
  if (rank === 2) return 'Opened on the first account with no recorded closes: no account has a priced close.'
  return null
}
