// ---------------------------------------------------------------------------
// agent/services/unknown-pnl-report.js — WHY is the desk blocked?
//
// Owner, 2026-07-31, three days running: every signal vetoed with
// "unknown_daily_pnl (account): 7 closed trade(s) today have no realised P&L".
// The veto itself is correct and is NOT touched here — a daily-loss sum with a
// NULL in it cannot be trusted, and this module changes no gate, no threshold
// and no blocking decision. What was missing is the answer to the next
// question: WHICH rows, and why has the backfill not repaired them?
//
// Until now that answer took a database session. The veto reason could say how
// many rows and how old the oldest was, and nothing else — so a desk stuck for
// three days looked identical whether the cause was a broker outage, an
// unattributed row, or a row that can never fill at all.
//
// This report names, per row, the reason it is still unknown:
//
//   no_broker_position_id — the row has no ctrader_position_id. pnl-backfill
//        matches deals BY position id (pnl-backfill.js's UPDATE … WHERE
//        ctrader_position_id = ?), so no amount of deal history can ever fill
//        this row. It is unfillable by construction, not merely pending.
//   unattributed_account  — account_id IS NULL. It blocks EVERY account (see
//        unresolved-pnl.js's note) and, worse, findUnresolvableCandidates
//        filters on `account_id IN (exhausted)`, so a NULL-account row can
//        never be written off either: it blocks until it ages out of the
//        daily window.
//   account_not_enabled   — the row's account is not in the enabled registry,
//        so the loop never runs a backfill pass for it.
//   backfill_pending      — attributed, has a position id, on an enabled
//        account: the ordinary case. The backfill should fill it; if it does
//        not, the closing deal is outside the broker's deal-history window.
//
// Read-only. No writes, no broker calls, no behaviour change.
// ---------------------------------------------------------------------------

import { fxDayStartSql } from './risk.js'
import { DEFAULT_UNKNOWN_PNL_GRACE_MIN } from './unresolved-pnl.js'

/**
 * The rows currently making the daily-loss total untrustworthy, each with the
 * reason it is still unknown and whether anything can ever fill it.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.graceMin]  same grace the veto uses
 * @param {string[]} [opts.enabledAccounts] account ids the loop backfills
 * @param {string[]} [opts.exhaustedAccounts] accounts pnl-backfill gave up on
 */
export function unknownPnlReport(db, {
  graceMin = DEFAULT_UNKNOWN_PNL_GRACE_MIN,
  enabledAccounts = [],
  exhaustedAccounts = [],
} = {}) {
  const grace = Number.isFinite(Number(graceMin)) && Number(graceMin) >= 0 ? Number(graceMin) : DEFAULT_UNKNOWN_PNL_GRACE_MIN
  const enabled = new Set((enabledAccounts || []).map(String))
  const exhausted = new Set((exhaustedAccounts || []).map(String))

  // Same schema-tolerance as the veto: a database predating pnl_unresolvable
  // must not make this throw (see unresolved-pnl.js).
  let hasUnresolvable = false
  try {
    hasUnresolvable = db.prepare('PRAGMA table_info(trades)').all().some(c => c.name === 'pnl_unresolvable')
  } catch { hasUnresolvable = false }

  const dayStart = fxDayStartSql()
  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, symbol, side, account_id, closed_at, close_reason, source,
             ctrader_position_id, exit_price, strategy
             ${hasUnresolvable ? ', COALESCE(pnl_unresolvable, 0) AS unresolvable' : ', 0 AS unresolvable'}
        FROM trades
       WHERE status = 'closed'
         AND net_pnl IS NULL
         AND REPLACE(closed_at, 'T', ' ') >= ?
         AND REPLACE(closed_at, 'T', ' ') <= datetime('now', ?)
       ORDER BY closed_at
    `).all(dayStart, `-${grace} minutes`)
  } catch (err) {
    return { ok: false, error: err.message, dayStart, rows: [], summary: null }
  }

  const diagnose = (r) => {
    if (r.unresolvable) return { reason: 'written_off', fillable: false }
    if (r.ctrader_position_id == null || String(r.ctrader_position_id) === '') {
      return { reason: 'no_broker_position_id', fillable: false }
    }
    if (r.account_id == null) return { reason: 'unattributed_account', fillable: false }
    if (enabled.size > 0 && !enabled.has(String(r.account_id))) {
      return { reason: 'account_not_enabled', fillable: false }
    }
    return { reason: 'backfill_pending', fillable: true }
  }

  const out = rows.map(r => {
    const d = diagnose(r)
    return {
      id: r.id,
      symbol: r.symbol,
      side: r.side ?? null,
      accountId: r.account_id ?? null,
      closedAt: r.closed_at,
      closeReason: r.close_reason ?? null,
      source: r.source ?? null,
      strategy: r.strategy ?? null,
      brokerPositionId: r.ctrader_position_id ?? null,
      hasExitPrice: r.exit_price != null,
      backfillExhausted: r.account_id != null && exhausted.has(String(r.account_id)),
      ...d,
    }
  })

  // Blocking rows only — a written-off row is already excluded from the veto.
  const blocking = out.filter(r => r.reason !== 'written_off')
  const byReason = {}
  for (const r of blocking) byReason[r.reason] = (byReason[r.reason] || 0) + 1
  // The recurring-cause question the owner is actually asking: is the same
  // close path producing these every day? Counting close_reason answers it
  // without anyone reading rows one at a time.
  const byCloseReason = {}
  for (const r of blocking) {
    const k = r.closeReason || '(none recorded)'
    byCloseReason[k] = (byCloseReason[k] || 0) + 1
  }

  return {
    ok: true,
    dayStart,
    graceMin: grace,
    summary: {
      blocking: blocking.length,
      unfillable: blocking.filter(r => !r.fillable).length,
      writtenOff: out.length - blocking.length,
      byReason,
      byCloseReason,
      oldestClosedAt: blocking.length ? blocking[0].closedAt : null,
      // Stated plainly, because this is the sentence that decides what the
      // owner does next: waiting only helps rows the backfill can still fill.
      verdict: blocking.length === 0
        ? 'nothing is blocking — the daily-loss total is complete'
        : blocking.every(r => !r.fillable)
          ? 'every blocking row is unfillable — waiting will not clear this; the rows need attribution or a broker position id'
          : blocking.some(r => !r.fillable)
            ? 'some blocking rows can never be filled by the backfill — those will hold the desk until they age out of the day window'
            : 'all blocking rows are ordinary pending backfills — they should clear once the deal history covers them',
    },
    rows: out,
  }
}
