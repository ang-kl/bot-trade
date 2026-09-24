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
