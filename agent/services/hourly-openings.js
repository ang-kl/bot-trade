import { accountWhere } from '../lib/account-scope.js'

const HOUR = 3600_000

// The population is all confirmed ledger trade rows, including still-open
// trades and closes awaiting P&L. Rejected orders and unresolved intents did
// not establish an opening. This is ledger evidence, not broker reconciliation.
export function hourlyOpenings(db, scope, { to, nowMs = Date.now() }) {
  if (!Number.isSafeInteger(to) || to < 24 * HOUR || to > nowMs) {
    throw new RangeError('to must be a past/current UTC epoch millisecond')
  }
  const from = to - 24 * HOUR
  const account = accountWhere(scope)
  const filter = account.active ? ` AND ${account.where}` : ''
  // SQL aggregation avoids fetching an unbounded journal into Node or using
  // the paginated /trades response. SQLite parses the ledger's ISO/UTC text
  // formats and offsets; rounding preserves millisecond boundary precision.
  const groups = db.prepare(`
    WITH population AS (
      SELECT account_id, origin,
        CAST(ROUND(unixepoch(opened_at, 'subsec') * 1000) AS INTEGER) AS opened_ms
      FROM trades WHERE status IN ('open', 'closed')${filter}
    )
    SELECT CASE WHEN opened_ms IS NULL THEN -1
      ELSE CAST((opened_ms - ?) / ? AS INTEGER) END AS bucket,
      COUNT(*) AS n,
      SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS legacy,
      SUM(CASE WHEN origin = 'reconciler_adopted' THEN 1 ELSE 0 END) AS adopted
    FROM population
    WHERE opened_ms IS NULL OR (opened_ms >= ? AND opened_ms < ?)
    GROUP BY bucket
  `).all(...account.params, from, HOUR, from, to)
  const rows = Array.from({ length: 24 }, (_, i) => ({
    from: from + i * HOUR, to: from + (i + 1) * HOUR,
    openedN: 0, legacyN: 0, adoptedN: 0,
  }))
  let unknownTimeN = 0
  for (const group of groups) {
    if (group.bucket === -1) unknownTimeN = group.n
    else Object.assign(rows[group.bucket], { openedN: group.n, legacyN: group.legacy, adoptedN: group.adopted })
  }
  return {
    accountId: scope.all ? 'all' : scope.accountId,
    source: 'local_trade_ledger', brokerReconciled: false,
    generatedAt: new Date(nowMs).toISOString(), from, to, rows, unknownTimeN,
    openedN: rows.reduce((n, r) => n + r.openedN, 0),
    legacyN: rows.reduce((n, r) => n + r.legacyN, 0),
    adoptedN: rows.reduce((n, r) => n + r.adoptedN, 0),
  }
}
