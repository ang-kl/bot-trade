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
// total only when every account of that currency has a value; an account with
// no currency reading could belong to any currency and is counted apart.
export function currentTotalsByCurrency(report, accountId = 'all') {
  const rows = (report?.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  const groups = new Map()
  let unknownCurrencyAccounts = 0
  for (const a of rows) {
    if (typeof a.currency !== 'string' || !/^[A-Z]{3}$/.test(a.currency)) { unknownCurrencyAccounts++; continue }
    if (!groups.has(a.currency)) groups.set(a.currency, [])
    groups.get(a.currency).push(a)
  }
  const sum = (list, field) => list.every(a => Number.isFinite(a[field])) ? list.reduce((n, a) => n + a[field], 0) : null
  return {
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, list]) => ({
      currency, accounts: list.length, balance: sum(list, 'balance'), equity: sum(list, 'equity'), openPnl: sum(list, 'openPnl'),
      withOpenPnl: list.filter(a => Number.isFinite(a.openPnl)).length })),
    unknownCurrencyAccounts,
  }
}
