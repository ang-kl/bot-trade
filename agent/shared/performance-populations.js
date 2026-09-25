import { ledgerCarry } from './balance-carry.js'
// Report-only arithmetic shared by server and UI. No admission/risk consumer.
// Money on historical trades has no verified conversion provenance. It may be
// added within one stamped account, never across accounts or onto an identity.
export const REPORT_SESSIONS = [
  { key: 'SYD (ASX)', fromMin: 0, toMin: 360 },
  { key: 'SG', fromMin: 60, toMin: 540 },
  { key: 'HK', fromMin: 90, toMin: 480 },
  { key: 'JPN', fromMin: 0, toMin: 360 },
  { key: 'EUR', fromMin: 420, toMin: 930 },
  { key: 'NY', fromMin: 810, toMin: 1200 },
]
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
      // Carry is the OBSERVED broker balance at each edge (V3 WEB-3), per
      // currency in the all-accounts scope; an edge without one stays null
      // with its reason. It is never reconstructed from recorded P&L.
      ...shape(st), ...ledgerCarry(report.balanceEdges, w.key, accountId),
      lastTradeAt: report.lastCloseByAccount[accountId] || null,
      markets: Object.fromEntries(report.markets.map(m => [m, shape(reportStats(report, w.key, accountId, g => g.market === m))])),
      external: { n: st.externalN, net: st.externalNet, unattributed: st.unattributedN, byOrigin: {} } }
  })
  return { generatedAt: report?.generatedAt ?? null, accountId, balance: null,
    balanceSource: 'use_identified_account_snapshot', windows, population: 'all_recorded_closes', currency: null }
}
