// ---------------------------------------------------------------------------
// agent/lib/stuck-resolutions.js — the record of how a stuck record ended
// (V3 I3, owner 25-09-2026 21:30 SGT, the write-off rule):
//
//   "settle each stuck record from broker evidence where it exists; otherwise
//    mark it terminal 'unresolved: no broker evidence' with reason + evidence
//    + timestamp, EXCLUDED from P&L and money totals, STILL SHOWN in the UI,
//    and no longer counted as stuck (a visible notice instead). Never delete
//    a record."
//
// ONE ROW PER RECORD THE RESOLVER ENDED, in `stuck_resolutions` (db.js). The
// stuck record itself is never deleted: a trade row written off keeps its
// status ('submitting' / 'unconfirmed' — the trades CHECK constraint has no
// honest terminal value for "no broker evidence", and 'rejected' means the
// broker refused it, which nobody observed), and this row is what makes it
// terminal. Every reader that treats an in-flight trade as live exposure
// reads it through `inflightLiveSql`, so a written-off row stops holding a
// symbol cap or a tick position slot; every lifecycle rule that counted it as
// stuck reads the same table and counts it as a notice instead (STK-12).
//
// Subjects: `trade:<id>` (an in-flight trade, STK-03), `pending:<id>` (a
// resting-order row, STK-01 / ORD-10), `capture:<acct>:<pid>` (a capture that
// gave up, STK-06), `target:<acct>:<pid>` (a targetless position, STK-09).
// ---------------------------------------------------------------------------

export const RESOLUTIONS_TABLE = 'stuck_resolutions'

/** The terminal verdicts that are a write-off (outcome 'unresolved'). */
export const UNRESOLVED_NO_EVIDENCE = 'unresolved: no broker evidence'
export const UNRESOLVED_AMBIGUOUS = 'unresolved: broker evidence ambiguous'
export const UNRESOLVED_NO_RECORD = 'unresolved: the missing field is recorded nowhere upstream'
export const UNRESOLVED_NO_TARGET = 'unresolved: no recorded target'

export const KINDS = Object.freeze(['trade_inflight', 'resting_order', 'capture', 'targetless'])

export const subjectFor = Object.freeze({
  trade: id => `trade:${id}`,
  pending: id => `pending:${id}`,
  capture: (acct, pid) => `capture:${acct ?? ''}:${pid}`,
  target: (acct, pid) => `target:${acct ?? ''}:${pid}`,
})

const tableSeen = new WeakMap()
/** True when the database carries the resolutions table (every initDB database does). Cached only once seen. */
export function hasResolutionsTable(db) {
  if (tableSeen.get(db) === true) return true
  let ok = false
  try { ok = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(RESOLUTIONS_TABLE) != null } catch { ok = false }
  if (ok) tableSeen.set(db, true)
  return ok
}

/**
 * The SQL clause that keeps a trades row counted as LIVE in-flight exposure
 * only while the resolver has not ended it. Appended to a WHERE that already
 * selects the in-flight statuses. A database without the table (a partial
 * test schema) gets '' — exactly the reading before I3, never a wider gate
 * from a query that throws into an empty catch.
 */
export function inflightLiveSql(db, alias = 'trades') {
  if (!hasResolutionsTable(db)) return ''
  return ` AND NOT EXISTS (SELECT 1 FROM ${RESOLUTIONS_TABLE} sr WHERE sr.trade_id = ${alias}.id AND sr.kind = 'trade_inflight')`
}
