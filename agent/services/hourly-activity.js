import { accountWhere } from '../lib/account-scope.js'
import { hourlyOpenings } from './hourly-openings.js'

// One bounded aggregate over all ledger rows, independent of journal paging.
// Legacy net_pnl has no recorded currency. Never sum different accounts' units.
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
  const rows = report.rows.map(r => ({ ...r, closedN: 0, pricedN: 0, wins: 0, moneyByAccount: [], net: null }))
  let unknownCloseTimeN = 0
  const totals = new Map()
  for (const g of groups) {
    if (g.bucket === -1) { unknownCloseTimeN += g.n; continue }
    const row = rows[g.bucket]
    if (!row) throw new Error('invalid close bucket')
    const amount = { accountId: g.account_id, currency: null, recordedNet: Number.isFinite(g.net) ? g.net : null, closedN: g.n, pricedN: g.priced }
    row.closedN += g.n; row.pricedN += g.priced; row.wins += g.wins
    row.moneyByAccount.push(amount)
    const sum = totals.get(g.account_id) || { accountId: g.account_id, currency: null, recordedNet: 0, closedN: 0, pricedN: 0 }
    sum.recordedNet += g.net; sum.closedN += g.n; sum.pricedN += g.priced
    totals.set(g.account_id, sum)
  }
  for (const row of rows) row.net = row.closedN === 0 ? 0
    : row.moneyByAccount.length === 1 && row.pricedN === row.closedN ? row.moneyByAccount[0].recordedNet : null
  const moneyByAccount = [...totals.values()].map(a => ({ ...a, recordedNet: Number.isFinite(a.recordedNet) ? a.recordedNet : null }))
  const closedN = rows.reduce((n, r) => n + r.closedN, 0)
  const pricedN = rows.reduce((n, r) => n + r.pricedN, 0)
  const wins = rows.reduce((n, r) => n + r.wins, 0)
  return { ...report, activityVersion: 1, rows, closedN, pricedN, wins, unknownCloseTimeN, moneyByAccount,
    net: closedN === 0 ? 0 : moneyByAccount.length === 1 && pricedN === closedN ? moneyByAccount[0].recordedNet : null,
    currencyStatus: 'not_recorded_in_trade_ledger', cashflowsReconciled: false,
    balanceReconstruction: 'unavailable_without_currency_and_cashflow_reconciliation' }
}
