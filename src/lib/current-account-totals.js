import { reportCurrency } from '../../agent/shared/performance-populations.js'

// Current native money can be grouped only when every requested account has
// that currency and a value. Historical close units use a separate contract.
export function currentAccountTotals(report, accountId = 'all') {
  const rows = (report?.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  const currencies = new Set(rows.map(a => a.currency))
  const comparable = rows.length > 0 && currencies.size === 1 && !currencies.has(null)
  const sum = field => comparable && rows.every(a => Number.isFinite(a[field])) ? rows.reduce((n, a) => n + a[field], 0) : null
  return { balance: sum('balance'), equity: sum('equity'), openPnl: sum('openPnl'), freeMargin: sum('freeMargin'),
    currency: comparable ? rows[0].currency : null, accounts: rows.length,
    note: comparable ? `${rows[0].currency} · ${rows.length} account${rows.length === 1 ? '' : 's'} · broker readings`
      : 'Current totals are shown separately by account where currencies differ or evidence is missing.' }
}

// V3 WEB-3 / 8,989-A WEB-5: the all-accounts view shows current money per
// deposit currency, never summed across currencies. A currency's field is a
// total only when every account of that currency has a value.
//
// ONE CURRENCY SOURCE (V3 WEB-3m): the group is the account's RECORDED broker
// deposit currency, `currencyOf(accountId)` — the page passes
// `id => reportCurrency(populationReport, id)`, the reader WEB-7's pools use.
// The overview row's own currency is only a re-check: a reading in another
// currency (or with none) is not summed and holds its currency's total open,
// named. An account with no recorded currency is in no subtotal. Without
// `currencyOf`, no account has a currency and nothing is subtotalled.
export function currentTotalsByCurrency(report, accountId = 'all', currencyOf = null) {
  const rows = (report?.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  const recorded = id => { const c = typeof currencyOf === 'function' ? currencyOf(id) : null; return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : null }
  const groups = new Map()
  const unknownAccounts = []
  for (const a of rows) {
    const currency = recorded(a.accountId)
    if (!currency) { unknownAccounts.push(String(a.accountId)); continue }
    if (!groups.has(currency)) groups.set(currency, [])
    groups.get(currency).push(a)
  }
  const counted = (a, currency, field) => a.currency === currency && Number.isFinite(a[field])
  const sum = (list, currency, field) => list.every(a => counted(a, currency, field)) ? list.reduce((n, a) => n + a[field], 0) : null
  return {
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, list]) => ({
      currency, accounts: list.length, balance: sum(list, currency, 'balance'), equity: sum(list, currency, 'equity'),
      openPnl: sum(list, currency, 'openPnl'),
      withOpenPnl: list.filter(a => counted(a, currency, 'openPnl')).length,
      missingOpenPnl: list.filter(a => !counted(a, currency, 'openPnl')).map(a => String(a.accountId)).sort() })),
    unknownCurrencyAccounts: unknownAccounts.length, unknownAccounts: unknownAccounts.sort(),
  }
}

/** The live hour's floating subtotal per currency on the all-accounts view
 * (V3 WEB-3, 8,989-A row 5): only where no single figure exists
 * (`feedOpenPnl`, the page's currentAccountTotals reading, is null), grouped
 * by each account's RECORDED deposit currency — the populations report's
 * currencyByAccount, read HERE through reportCurrency, the reader WEB-7's
 * pools use (V3 WEB-3m). The page passes the report; it never names a
 * currency itself, so no second currency reader can creep in at the call
 * site. Null on a single account or when a single figure exists. */
export function liveFloatingByCurrency(overview, populationReport, acct, feedOpenPnl) {
  if (acct !== 'all' || feedOpenPnl != null) return null
  return currentTotalsByCurrency(overview, 'all', id => reportCurrency(populationReport, id))
}
