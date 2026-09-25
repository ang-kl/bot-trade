import { ledgerCarry } from './balance-carry.js'
// Report-only arithmetic shared by server and UI. No admission/risk consumer.
// Money on historical trades has no verified conversion provenance. It may be
// added within one stamped account, never onto an identity, and across
// accounts only when every contributing account's broker deposit currency is
// recorded and identical (owner default, 25-09-2026: money per currency, never
// summed across currencies). Nothing is ever converted.
import { REPORT_SESSIONS, sessionHint } from './report-sessions.js'
// The session table lives in report-sessions.js (V3 WEB-6: exchange cash hours
// in each exchange's IANA zone). Re-exported so this stays the one import for
// report arithmetic.
export { REPORT_SESSIONS }
const CCY = /^[A-Z]{3}$/
export function emptyPopulation() {
  return { n: 0, pricedN: 0, wins: 0, net: 0, gw: 0, gl: 0, tp: 0, part: 0, sl: 0, manual: 0,
    rrSum: 0, rrN: 0, realSum: 0, realN: 0, mismatch: 0, externalN: 0, externalNet: 0, unattributedN: 0,
    high: null, low: null }
}
const SUM_FIELDS = Object.keys(emptyPopulation()).filter(k => !['high', 'low'].includes(k))
export function populationStats(groups, { available = true, accountId = 'all', currency = null, currencyOf = null } = {}) {
  if (!available) return { n: null, pricedN: null, unpricedN: null, pnl: null, wr: null, pf: null,
    tp: null, part: null, sl: null, edge: null, state: 'unavailable', moneyState: 'unavailable', currency: null }
  const st = emptyPopulation(), ids = new Set()
  for (const g of groups) {
    if (g.stats.n) ids.add(g.accountId)
    for (const k of SUM_FIELDS) st[k] += g.stats[k]
    if (g.stats.high != null) st.high = st.high == null ? g.stats.high : Math.max(st.high, g.stats.high)
    if (g.stats.low != null) st.low = st.low == null ? g.stats.low : Math.min(st.low, g.stats.low)
  }
  // Pooled across accounts only under one named currency that every
  // contributing account is recorded in; the caller's filter is re-checked
  // here, so a wrong predicate cannot add two currencies together.
  const pooled = CCY.test(currency || '') && typeof currencyOf === 'function' && !ids.has(null)
    && [...ids].every(id => currencyOf(id) === currency)
  const comparable = pooled || (!ids.has(null) && ids.size <= 1 && (ids.size === 1 || accountId !== 'all'))
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
      : pooled ? (st.pricedN < st.n ? 'partial_recorded_currency_units' : 'recorded_currency_units')
        : st.pricedN < st.n ? 'partial_recorded_account_units' : 'recorded_account_units',
    currency: pooled ? currency : null,
  }
}
/** The recorded broker deposit currency of one account in this report, or
 * null when the report carries none for it (never a default, never a guess). */
export function reportCurrency(report, accountId) {
  const c = accountId == null ? null : report?.currencyByAccount?.[String(accountId)]?.currency
  return typeof c === 'string' && CCY.test(c) ? c : null
}
/** Money pooled across every account recorded in `currency`, and only those.
 * Unattributed closes and accounts without a recorded currency are excluded:
 * they belong to no currency. */
export function reportCurrencyStats(report, key, currency, predicate = () => true) {
  const ccy = CCY.test(currency || '') ? currency : null
  const currencyOf = id => reportCurrency(report, id)
  return populationStats(reportGroups(report, key, 'all', g => ccy != null && currencyOf(g.accountId) === ccy && predicate(g)), {
    accountId: 'all', currency: ccy, currencyOf,
    available: ccy != null && report?.status === 'complete' && report.windows.some(w => w.key === key),
  })
}
/** The closes of a window that belong to no currency: an account with no
 * recorded deposit currency, or no account stamp at all. They are counted,
 * named and never added to any currency's money. */
export function reportUnpooled(report, key, predicate = () => true) {
  return unpooledOf(reportGroups(report, key, 'all', g => reportCurrency(report, g.accountId) == null && predicate(g)))
}
/** Counts and names the closes of groups that are already known to sit in no
 * currency (reportUnpooled's arithmetic, shared with splitByCurrency). */
function unpooledOf(groups) {
  const out = { trades: 0, pricedTrades: 0, accountIds: [] }
  for (const g of groups) {
    if (!g.stats.n) continue
    out.trades += g.stats.n; out.pricedTrades += g.stats.pricedN
    if (!out.accountIds.includes(g.accountId ?? null)) out.accountIds.push(g.accountId ?? null)
  }
  return out
}
/** THE pooling rule for recorded close money across accounts (V3 WEB-7 and
 * WEB-5; owner default 25-09-2026: money per currency, never summed across
 * currencies, partial money marked). Groups ({ accountId, stats }) are
 * partitioned ONCE by each account's recorded broker deposit currency,
 * `currencyOf(accountId)` — every caller builds it on reportCurrency over a
 * depositCurrencies() map (a report's currencyByAccount), so there is one
 * currency source — and each currency is pooled by populationStats, which
 * re-checks that every contributing account is recorded in that currency and
 * marks a partly priced pool partial_recorded_currency_units. A close with no
 * account, or from an account with no recorded currency, is in no pool: it is
 * counted in `unpooled` and added to none. Currencies come in code order; a
 * currency with no close is left out. The ledger's all-accounts split
 * (reportLedger) and the rolling 24-hour activity
 * (agent/services/hourly-activity.js) both read this; neither keeps a pooling
 * rule of its own. */
export function splitByCurrency(groups, currencyOf, { available = true, predicate = () => true } = {}) {
  const parts = new Map(), none = []
  for (const g of groups || []) {
    if (!predicate(g)) continue
    const c = typeof currencyOf === 'function' ? currencyOf(g.accountId) : null
    if (typeof c !== 'string' || !CCY.test(c)) { none.push(g); continue }
    if (!parts.has(c)) parts.set(c, [])
    parts.get(c).push(g)
  }
  const byCurrency = [...parts.keys()].sort().map(currency => {
    const list = parts.get(currency)
    return { currency, stats: populationStats(list, { accountId: 'all', currency, currencyOf, available }),
      accountIds: [...new Set(list.filter(g => g.stats.n).map(g => g.accountId))] }
  }).filter(c => c.stats.n > 0)
  return { byCurrency, unpooled: unpooledOf(none) }
}
/** The rolling 24-hour activity's money pools (V3 WEB-5, 8,989-A rows 5 and 7;
 * GET /state/hourly-activity, per report and per hour). `amounts` are
 * per-account entries ({ accountId, recordedNet, closedN, pricedN }) and
 * `currencyOf` the account's recorded deposit currency (reportCurrency over
 * depositCurrencies(), the one currency source). The pooling is
 * splitByCurrency; this only reshapes its pools for the hourly contract
 * ({ currency, recordedNet, closedN, pricedN, accountIds, moneyState } and
 * `unpooled` { closedN, pricedN, accountIds }): an account with no recorded
 * currency, and an unattributed close, is counted in `unpooled` and added to
 * no pool; a pool with no priced close has no figure (null), never a zero; a
 * partly priced pool is marked partial. */
export function poolByCurrency(amounts, currencyOf) {
  // An account whose priced sum is not finite has no figure; NaN carries that
  // into its pool, which then has no figure either (never a partial sum).
  const groups = (amounts || []).map(a => ({ accountId: a.accountId, stats: { ...emptyPopulation(), n: a.closedN, pricedN: a.pricedN,
    net: Number.isFinite(a.recordedNet) ? a.recordedNet : a.pricedN ? NaN : 0 } }))
  const { byCurrency, unpooled } = splitByCurrency(groups, currencyOf)
  return {
    moneyByCurrency: byCurrency.map(({ currency, stats, accountIds }) => {
      const recordedNet = Number.isFinite(stats.pnl) ? stats.pnl : null
      return { currency, recordedNet, closedN: stats.n, pricedN: stats.pricedN, accountIds,
        moneyState: recordedNet == null ? 'unavailable' : stats.moneyState }
    }),
    unpooled: { closedN: unpooled.trades, pricedN: unpooled.pricedTrades, accountIds: unpooled.accountIds },
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
  // Each account's recorded currency is read once per report, not once per
  // group for every currency, window and market (the WEB-5 checker measured
  // the unpartitioned split at 4.5x the ledger's cost on production).
  const known = new Map()
  const currencyOf = id => {
    const k = id == null ? null : String(id)
    if (!known.has(k)) known.set(k, reportCurrency(report, id))
    return known.get(k)
  }
  const windows = (report?.windows || []).filter(w => w.ledger).map(w => {
    const st = reportStats(report, w.key, accountId)
    const shape = s => ({ net: s.pnl, trades: s.n, pricedTrades: s.pricedN, unpricedTrades: s.unpricedN,
      winPct: s.wr, pf: s.pf, pfInfinite: s.pfInfinite, tp: s.tp, part: s.part, sl: s.sl,
      manual: s.manual, avgRr: s.rr, requiredWinPct: s.rr == null ? null : 100 / (1 + s.rr),
      edge: s.edge, avgRealisedRr: s.realN ? s.realSum / s.realN : null, realisedRrN: s.realN,
      payoffRatio: s.payoff, requiredWinPctRealised: s.requiredWinPctRealised,
      edgeRealised: s.wr != null && s.requiredWinPctRealised != null ? s.wr - s.requiredWinPctRealised : null,
      pnlPriceMismatch: s.mismatch, moneyState: s.moneyState })
    // All accounts (V3 WEB-5, owner default 25-09): money per recorded deposit
    // currency, each its own line, never summed across currencies; the closes
    // in no currency are counted apart. One account needs no split.
    //
    // splitByCurrency is the one pooling rule; each call partitions only the
    // groups its predicate keeps, in their order, so every pool equals
    // reportCurrencyStats / reportUnpooled for that currency (same groups,
    // same order, so the same sums).
    let split = () => ({})
    if (accountId === 'all') {
      const groups = reportGroups(report, w.key), available = report.status === 'complete'
      split = (predicate = () => true) => {
        const s = splitByCurrency(groups, currencyOf, { available, predicate })
        return { byCurrency: s.byCurrency.map(c => ({ currency: c.currency, ...shape(c.stats) })), unpooled: s.unpooled }
      }
    }
    return { key: w.key, label: w.label, from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(),
      // Net per currency (V3 WEB-5, above) and carry (V3 WEB-3) key on the same
      // reader. Carry is the OBSERVED broker balance at each edge, per currency
      // in the all-accounts scope; an edge without one stays null with its
      // reason. It is never reconstructed from recorded P&L. Its currency
      // groups key on currencyOf — reportCurrency, the one reader the pools
      // use (V3 WEB-3m) — never on a currency the balance carries.
      ...shape(st), ...split(), ...ledgerCarry(report.balanceEdges, w.key, accountId, currencyOf),
      lastTradeAt: report.lastCloseByAccount[accountId] || null,
      markets: Object.fromEntries(report.markets.map(m => [m, { ...shape(reportStats(report, w.key, accountId, g => g.market === m)), ...split(g => g.market === m) }])),
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
