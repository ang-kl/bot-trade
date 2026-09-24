import { accountWhere } from '../lib/account-scope.js'
import { postmortemStats, pendingLessons } from './loss-postmortem.js'

function parse(s) { try { return JSON.parse(s || 'null') } catch { return null } }

/** Successful /postmortems contract, read in one worker-owned snapshot.
 * Preserve the historical account/null-row convention and original trade dates.
 * A database failure propagates; an empty lesson list must mean a real result.
 */
export function postmortemReport(db, { scope, limit = 30 } = {}) {
  const acct = accountWhere(scope, 't.account_id')
  const count = Math.min(100, Math.max(1, Number(limit) || 30))
  const rows = db.prepare(`
    SELECT pm.*, t.volume AS lot, t.tp_price AS tp1_price, t.thesis AS setup_thesis,
           t.confluence_count AS confluence_count, a.tp2_price AS tp2_price,
           t.closed_at AS trade_closed_at, t.opened_at AS trade_opened_at
      FROM trade_postmortems pm
      LEFT JOIN trades t ON t.id = pm.trade_id
      LEFT JOIN analyses a ON a.id = t.analysis_id
     WHERE (t.id IS NULL OR t.status <> 'rejected')${acct.active ? ` AND ${acct.where}` : ''}
     ORDER BY pm.id DESC LIMIT ?
  `).all(...acct.params, count).map(r => ({ ...r, bars: parse(r.bars_json), bars_json: undefined }))
  const accountId = acct.active ? scope.accountId : null
  return { rows, stats: postmortemStats(db, 30, { accountId }),
    pending: pendingLessons(db, { accountId, strict: true }),
    accountId: scope?.all ? 'all' : (scope?.accountId ?? null), scoped: acct.active }
}
