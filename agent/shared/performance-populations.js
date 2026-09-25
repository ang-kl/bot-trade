// Report-only arithmetic shared by server and UI. No admission/risk consumer.
// Money on historical trades has no verified conversion provenance. It may be
// added within one stamped account, never across accounts or onto an identity.
import { REPORT_SESSIONS, sessionHint } from './report-sessions.js'
// The session table lives in report-sessions.js (V3 WEB-6: exchange cash hours
// in each exchange's IANA zone). Re-exported so this stays the one import for
// report arithmetic.
export { REPORT_SESSIONS }
export function emptyPopulation() {
  return { n: 0, pricedN: 0, wins: 0, net: 0, gw: 0, gl: 0, tp: 0, part: 0, sl: 0, manual: 0,
    rrSum: 0, rrN: 0, realSum: 0, realN: 0, mismatch: 0, externalN: 0, externalNet: 0, unattributedN: 0,
    high: null, low: null }
}
const SUM_FIELDS = Object.keys(emptyPopulation()).filter(k => !['high', 'low'].includes(k))
export function populationStats(groups, { available = true, accountId = 'all' } = {}) {
  if (!available) return { n: null, pricedN: null, unpricedN: null, pnl: null, wr: null, pf: null,
    tp: null, part: null, sl: null, edge: null, state: 'unavailable', moneyState: 'unavailable' }
  const st = emptyPopulation(), ids = new Set()
  for (const g of groups) {
    if (g.stats.n) ids.add(g.accountId)
    for (const k of SUM_FIELDS) st[k] += g.stats[k]
    if (g.stats.high != null) st.high = st.high == null ? g.stats.high : Math.max(st.high, g.stats.high)
    if (g.stats.low != null) st.low = st.low == null ? g.stats.low : Math.min(st.low, g.stats.low)
  }
  const comparable = !ids.has(null) && ids.size <= 1 && (ids.size === 1 || accountId !== 'all')
  const hasMoney = comparable && (st.pricedN > 0 || st.n === 0)
  const rr = st.rrN ? st.rrSum / st.rrN : null
  const wr = st.pricedN ? st.wins / st.pricedN * 100 : null
  const payoff = hasMoney && st.gl > 0 && st.wins > 0 && st.pricedN > st.wins
    ? st.gw / st.wins / (st.gl / (st.pricedN - st.wins)) : null
  return { ...st, net: hasMoney ? st.net : null, pnl: hasMoney ? st.net : null,
    gw: hasMoney ? st.gw : null, gl: hasMoney ? st.gl : null,
    high: hasMoney ? st.high : null, low: hasMoney ? st.low : null,
    externalNet: hasMoney ? st.externalNet : null,
    avg: hasMoney && st.pricedN ? st.net / st.pricedN : null,
    median: hasMoney && groups.length === 1 ? groups[0].stats.median ?? null : null,
    unpricedN: st.n - st.pricedN, wr, rr,
    pf: hasMoney && st.gl > 0 ? st.gw / st.gl : null,
    pfInfinite: hasMoney && st.gl === 0 && st.gw > 0,
    edge: wr != null && rr != null ? wr - 100 / (1 + rr) : null,
    payoff, requiredWinPctRealised: payoff == null ? null : 100 / (1 + payoff),
    state: st.n === 0 ? 'verified_zero' : 'observed',
    moneyState: !comparable ? 'unverified_cross_account_units' : !hasMoney ? 'unavailable'
      : st.pricedN < st.n ? 'partial_recorded_account_units' : 'recorded_account_units',
  }
}
export function reportGroups(report, key, accountId = 'all', predicate = () => true) {
  return (report?.windows?.find(w => w.key === key)?.groups || [])
    .filter(g => (accountId === 'all' || g.accountId === String(accountId)) && predicate(g))
}
export function reportStats(report, key, accountId = 'all', predicate = () => true) {
  return populationStats(reportGroups(report, key, accountId, predicate), {
    accountId, available: report?.status === 'complete' && report.windows.some(w => w.key === key),
  })
}
export function reportLedger(report, accountId = 'all') {
  const windows = (report?.windows || []).filter(w => w.ledger).map(w => {
    const st = reportStats(report, w.key, accountId)
    const shape = s => ({ net: s.pnl, trades: s.n, pricedTrades: s.pricedN, unpricedTrades: s.unpricedN,
      winPct: s.wr, pf: s.pf, pfInfinite: s.pfInfinite, tp: s.tp, part: s.part, sl: s.sl,
      manual: s.manual, avgRr: s.rr, requiredWinPct: s.rr == null ? null : 100 / (1 + s.rr),
      edge: s.edge, avgRealisedRr: s.realN ? s.realSum / s.realN : null, realisedRrN: s.realN,
      payoffRatio: s.payoff, requiredWinPctRealised: s.requiredWinPctRealised,
      edgeRealised: s.wr != null && s.requiredWinPctRealised != null ? s.wr - s.requiredWinPctRealised : null,
      pnlPriceMismatch: s.mismatch, moneyState: s.moneyState })
    return { key: w.key, label: w.label, from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(),
      ...shape(st), carryIn: null, carryOut: null, balanceHistoryState: 'requires_cashflow_reconciled_history',
      lastTradeAt: report.lastCloseByAccount[accountId] || null,
      markets: Object.fromEntries(report.markets.map(m => [m, shape(reportStats(report, w.key, accountId, g => g.market === m))])),
      external: { n: st.externalN, net: st.externalNet, unattributed: st.unattributedN, byOrigin: {} } }
  })
  return { generatedAt: report?.generatedAt ?? null, accountId, balance: null,
    balanceSource: 'use_identified_account_snapshot', windows, population: 'all_recorded_closes', currency: null }
}
/** The "Today by market session" rows, read from the report alone (V3 WEB-6).
 * Each exchange row carries the report's own UTC intervals and its open-now
 * reading. A report without them (an older server during a deploy) yields
 * rows with no intervals and `open: null` — never an invented reading. */
export function sessionBuckets(report, accountId = 'all') {
  const stat = key => {
    const a = reportStats(report, `session:${key}`, accountId)
    return { n: a.n, pricedN: a.pricedN, pos: a.gw, neg: a.gl == null ? null : -a.gl,
      high: a.high, low: a.low, avg: a.avg, sum: a.pnl, median: a.median }
  }
  const windowOf = key => report?.windows?.find(w => w.key === `session:${key}`)?.session
  const buckets = REPORT_SESSIONS.map(s => {
    const w = windowOf(s.key), intervals = Array.isArray(w?.intervals) ? w.intervals : null
    return { key: s.key, exchange: s.exchange, intervals, hint: sessionHint(s, intervals),
      open: typeof w?.openNow === 'boolean' ? w.openNow : null, ...stat(s.key) }
  })
  // Two rows with the same UTC intervals show the same figures by
  // construction; the card marks the pair instead of leaving it to look a bug.
  const sig = b => b.intervals?.length ? b.intervals.map(i => `${i.from}-${i.to}`).join(',') : null
  for (const b of buckets) b.twin = sig(b) ? buckets.find(o => o !== b && sig(o) === sig(b))?.key ?? null : null
  const sw = report?.sessionWindow
  return { source: sw?.source ?? null, exceptions: sw?.exceptions ?? null, buckets, off: stat('OFF'), total: stat('ALL') }
}
