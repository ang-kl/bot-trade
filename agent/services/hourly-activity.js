import { accountWhere } from '../lib/account-scope.js'
import { hourlyOpenings } from './hourly-openings.js'
import { depositCurrencies } from './performance-populations.js'

const CCY = /^[A-Z]{3}$/

/** Recorded money pooled per broker deposit currency, never across two
 * (owner default 25-09-2026; V3 WEB-5, 8,989-A rows 5 and 7). `amounts` are
 * per-account entries ({ accountId, currency, recordedNet, closedN, pricedN }).
 * An account with no recorded currency, and an unattributed close, belongs
 * to no currency: it is counted in `unpooled`, never added to a pool. A pool
 * with no priced close has no money figure (null), never a zero. */
export function poolByCurrency(amounts) {
  const pools = new Map()
  const unpooled = { closedN: 0, pricedN: 0, accountIds: [] }
  for (const a of amounts) {
    if (!a.closedN) continue
    const ccy = a.accountId != null && CCY.test(a.currency || '') ? a.currency : null
    if (ccy == null) {
      unpooled.closedN += a.closedN; unpooled.pricedN += a.pricedN; unpooled.accountIds.push(a.accountId ?? null)
      continue
    }
    const p = pools.get(ccy) || { currency: ccy, recordedNet: 0, closedN: 0, pricedN: 0, accountIds: [] }
    // A non-finite account sum poisons its pool: the pool has no figure.
    if (a.pricedN) p.recordedNet = p.recordedNet == null || !Number.isFinite(a.recordedNet) ? null : p.recordedNet + a.recordedNet
    p.closedN += a.closedN; p.pricedN += a.pricedN; p.accountIds.push(a.accountId)
    pools.set(ccy, p)
  }
  const moneyByCurrency = [...pools.values()].sort((x, y) => x.currency.localeCompare(y.currency)).map(p => ({
    ...p, recordedNet: p.pricedN ? p.recordedNet : null,
    moneyState: !p.pricedN || p.recordedNet == null ? 'unavailable'
      : p.pricedN < p.closedN ? 'partial_recorded_currency_units' : 'recorded_currency_units',
  }))
  return { moneyByCurrency, unpooled }
}

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
  const currencyByAccount = depositCurrencies(db)
  const currencyOf = id => id == null ? null : currencyByAccount[String(id)]?.currency ?? null
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
    Object.assign(row, poolByCurrency(row.moneyByAccount))
  }
  const moneyByAccount = [...totals.values()].map(a => ({ ...a, recordedNet: Number.isFinite(a.recordedNet) ? a.recordedNet : null }))
  const closedN = rows.reduce((n, r) => n + r.closedN, 0)
  const pricedN = rows.reduce((n, r) => n + r.pricedN, 0)
  const wins = rows.reduce((n, r) => n + r.wins, 0)
  return { ...report, activityVersion: 1, rows, closedN, pricedN, wins, unknownCloseTimeN, moneyByAccount,
    net: closedN === 0 ? 0 : moneyByAccount.length === 1 && pricedN === closedN ? moneyByAccount[0].recordedNet : null,
    ...poolByCurrency(moneyByAccount),
    currencyStatus: 'not_recorded_in_trade_ledger', currencySource: 'account_deposit_currency_evidence',
    currencyPolicy: 'pool_within_one_recorded_deposit_currency_never_across', cashflowsReconciled: false,
    balanceReconstruction: 'unavailable_without_currency_and_cashflow_reconciliation' }
}
