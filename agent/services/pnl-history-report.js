// Read-only diagnosis of retained, unpriced closes. A clear current FX day
// says nothing about older gaps. Match the strict position-history repair's
// account + numeric broker-position identity, including open/priced peers.
export function pnlHistoryReport(db, { nowMs = Date.now() } = {}) {
  const limit = 100
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name))
    const optional = (name, fallback) => columns.has(name) ? name : fallback
    const cte = `WITH identities AS (
      SELECT account_id, CAST(ctrader_position_id AS INTEGER) AS position_id,
             COUNT(*) AS matches, SUM(status = 'open') AS open_matches,
             SUM(status = 'closed') AS closed_matches
        FROM trades WHERE account_id IS NOT NULL AND ctrader_position_id IS NOT NULL
       GROUP BY account_id, CAST(ctrader_position_id AS INTEGER)
    ), gaps AS (
      SELECT t.id, t.account_id, t.ctrader_position_id, t.symbol, t.side,
             t.closed_at, t.close_reason, t.source,
             COALESCE(${optional('pnl_unresolvable', '0')}, 0) AS written_off,
             ${optional('pnl_attempts', 'NULL')} AS attempts,
             ${optional('pnl_last_attempt_at', 'NULL')} AS last_attempt_at,
             ${optional('pnl_unresolvable_reason', 'NULL')} AS written_off_reason,
             i.matches, i.open_matches, i.closed_matches
        FROM trades t LEFT JOIN identities i
          ON i.account_id = t.account_id
         AND i.position_id = CAST(t.ctrader_position_id AS INTEGER)
       WHERE t.status = 'closed' AND t.net_pnl IS NULL
    )`
    const totals = db.prepare(`${cte} SELECT COUNT(*) AS total,
      COALESCE(SUM(written_off != 0), 0) AS writtenOff,
      COALESCE(SUM(account_id IS NULL), 0) AS unattributed,
      COALESCE(SUM(matches > 1), 0) AS ambiguousPositionRows
      FROM gaps`).get()
    const rows = db.prepare(`${cte} SELECT * FROM gaps
      ORDER BY written_off, closed_at, id LIMIT ?`).all(limit)
    const peers = db.prepare(`SELECT id, status FROM trades WHERE account_id = ?
      AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
      ORDER BY id LIMIT 11`)
    const historyRows = rows.map(r => {
      const numericPosition = /^[1-9]\d*$/.test(String(r.ctrader_position_id))
      const identified = r.account_id != null && numericPosition
      const matches = identified ? peers.all(r.account_id, r.ctrader_position_id) : []
      const reason = r.written_off ? 'written_off'
        : r.account_id == null ? 'unattributed_account'
          : !numericPosition ? 'missing_or_invalid_position_id'
            : r.matches !== 1 || r.closed_matches !== 1 ? 'position_ledger_ambiguous'
              : 'broker_evidence_required'
      return {
        id: r.id, accountId: r.account_id, brokerPositionId: r.ctrader_position_id,
        symbol: r.symbol, side: r.side, closedAt: r.closed_at,
        closeReason: r.close_reason, source: r.source, reason,
        attempts: r.attempts, lastAttemptAt: r.last_attempt_at,
        writtenOffReason: r.written_off_reason,
        matchingLedgerRows: identified ? r.matches : null,
        matchingOpenRows: identified ? r.open_matches : null,
        matchingClosedRows: identified ? r.closed_matches : null,
        ledgerRows: matches.slice(0, 10).map(p => `${p.id}:${p.status}`),
        ledgerRowsTruncated: matches.length > 10,
      }
    })
    return {
      history: {
        ok: true, scope: 'all retained closed trades with unknown P&L; all accounts',
        observedAt: new Date(nowMs).toISOString(), ...totals,
        returned: historyRows.length, limit, truncated: totals.total > historyRows.length,
        evidence: 'Local ledger diagnosis only. A unique closed row still requires complete broker history; no money is inferred and no row is repaired or written off.',
      },
      historyRows,
    }
  } catch (err) {
    return { history: { ok: false, error: err.message, total: null }, historyRows: [] }
  }
}
