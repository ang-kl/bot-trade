import { accountWhere } from '../lib/account-scope.js'
import { hourlyOpenings } from './hourly-openings.js'
import { hourlyBalances } from './balance-edges.js'
import { depositCurrencies } from './deposit-currencies.js'
// The hourly money pools (V3 WEB-5) are poolByCurrency: the one pooling rule
// (splitByCurrency) in the hourly contract's shape, pure and shared with the
// browser's tests.
import { poolByCurrency, reportCurrency } from '../shared/performance-populations.js'

// One bounded aggregate over all ledger rows, independent of journal paging.
// Legacy net_pnl carries no currency of its own; each account's broker deposit
// currency (recorded evidence on its own host) names its unit. Money is added
// within one account, and across accounts only within one recorded currency.
export function hourlyActivity(db, scope, options) {
  const report = hourlyOpenings(db, scope, options)
  const account = accountWhere(scope)
  const groups = db.prepare(`
    WITH population AS (
      SELECT account_id, net_pnl,
        CAST(ROUND(unixepoch(closed_at, 'subsec') * 1000) AS INTEGER) AS closed_ms
      FROM trades WHERE status = 'closed'${account.active ? ` AND ${account.where}` : ''}
    )
    SELECT CASE WHEN closed_ms IS NULL THEN -1 ELSE CAST((closed_ms - ?) / 3600000 AS INTEGER) END AS bucket,
      account_id, COUNT(*) AS n,
      SUM(CASE WHEN typeof(net_pnl) IN ('real','integer') AND abs(net_pnl) <= 1.7976931348623157e308 THEN 1 ELSE 0 END) AS priced,
      SUM(CASE WHEN typeof(net_pnl) IN ('real','integer') AND abs(net_pnl) <= 1.7976931348623157e308 THEN net_pnl ELSE 0 END) AS net,
      SUM(CASE WHEN typeof(net_pnl) IN ('real','integer') AND net_pnl > 0 AND net_pnl <= 1.7976931348623157e308 THEN 1 ELSE 0 END) AS wins
    FROM population WHERE closed_ms IS NULL OR (closed_ms >= ? AND closed_ms < ?)
    GROUP BY bucket, account_id
  `).all(...account.params, report.from, report.from, report.observedThrough)
  // ONE currency source (V3 WEB-7 / WEB-3m): each account's recorded broker
  // deposit currency, read once per request and through reportCurrency — the
  // reader the populations report's pools, the ledger carry and the balance
  // columns below use. The same map goes to hourlyBalances, so the money
  // pools and the balance columns of one response cannot disagree on it.
  // A failed read names no currency: every close is counted in `unpooled`,
  // no pool is made, and the balance reader below re-reads and fails into its
  // own "unavailable" — the activity counts still stand (V3 WEB-3's rule).
  let currencyByAccount = null
  try { currencyByAccount = depositCurrencies(db) } catch { currencyByAccount = null }
  const currencies = { currencyByAccount }
  const currencyOf = id => reportCurrency(currencies, id)
  const rows = report.rows.map(r => ({ ...r, closedN: 0, pricedN: 0, wins: 0, moneyByAccount: [], net: null }))
  let unknownCloseTimeN = 0
  const totals = new Map()
  for (const g of groups) {
    if (g.bucket === -1) { unknownCloseTimeN += g.n; continue }
    const row = rows[g.bucket]
    if (!row) throw new Error('invalid close bucket')
    const currency = currencyOf(g.account_id)
    const amount = { accountId: g.account_id, currency, recordedNet: Number.isFinite(g.net) ? g.net : null, closedN: g.n, pricedN: g.priced }
    row.closedN += g.n; row.pricedN += g.priced; row.wins += g.wins
    row.moneyByAccount.push(amount)
    const sum = totals.get(g.account_id) || { accountId: g.account_id, currency, recordedNet: 0, closedN: 0, pricedN: 0 }
    sum.recordedNet += g.net; sum.closedN += g.n; sum.pricedN += g.priced
    totals.set(g.account_id, sum)
  }
  for (const row of rows) {
    row.net = row.closedN === 0 ? 0
      : row.moneyByAccount.length === 1 && row.pricedN === row.closedN ? row.moneyByAccount[0].recordedNet : null
    Object.assign(row, poolByCurrency(row.moneyByAccount, currencyOf))
  }
  const moneyByAccount = [...totals.values()].map(a => ({ ...a, recordedNet: Number.isFinite(a.recordedNet) ? a.recordedNet : null }))
  const closedN = rows.reduce((n, r) => n + r.closedN, 0)
  const pricedN = rows.reduce((n, r) => n + r.pricedN, 0)
  const wins = rows.reduce((n, r) => n + r.wins, 0)
  // V3 WEB-3: the balance columns are OBSERVED broker balances at each hour's
  // edges (account_history), never reconstructed from trade P&L. A read that
  // fails leaves them explicitly unavailable; the activity counts still stand.
  let balanceHistory
  try {
    const b = hourlyBalances(db, scope, rows, report.observedThrough, currencies)
    rows.forEach((row, i) => Object.assign(row, b.rows[i]))
    balanceHistory = { status: 'complete', ...b.balanceHistory }
  } catch {
    for (const row of rows) Object.assign(row, { openBal: null, closeBal: null, floating: null, balanceCurrency: null, balance: null })
    balanceHistory = { status: 'unavailable', reason: 'balance_history_read_failed' }
  }
  return { ...report, activityVersion: 1, rows, closedN, pricedN, wins, unknownCloseTimeN, moneyByAccount,
    net: closedN === 0 ? 0 : moneyByAccount.length === 1 && pricedN === closedN ? moneyByAccount[0].recordedNet : null,
    ...poolByCurrency(moneyByAccount, currencyOf),
    currencyStatus: 'not_recorded_in_trade_ledger', currencySource: 'account_deposit_currency_evidence',
    currencyPolicy: 'pool_within_one_recorded_deposit_currency_never_across', cashflowsReconciled: false,
    balanceReconstruction: balanceHistory.status === 'complete' ? 'observed_broker_balance_at_edges' : 'unavailable',
    balanceHistory }
}
