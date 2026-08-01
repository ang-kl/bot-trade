// agent/lib/pos-id.js — canonical broker position-id normalisation.
//
// PRODUCTION BUG 2026-08-02: closed trades sat with net_pnl NULL forever and
// the daily-loss gate vetoed every entry ("unknown daily pnl"). Root cause:
// some open paths stored trades.ctrader_position_id as a FLOAT-formatted
// string ("234698574.0") while the broker's deal history and the reconciler
// hand around "234698574" — so the P&L backfill's WHERE never matched, the
// reconciler's known-id sets missed (spawning duplicate adopted rows), and
// the orphan sweep closed the dirty rows with NULL P&L. One id, two
// spellings, three subsystems disagreeing.
//
// Every write of a broker position id, and every in-JS comparison of one,
// goes through normPosId so there is exactly one spelling: the integer's
// digits, as TEXT. SQL matching additionally CASTs both sides (pnl-backfill)
// so rows written before the db.js repair migration still match.

/**
 * Canonical string form of a broker position id: "234698574".
 * Accepts numbers, numeric strings, float-formatted strings ("234698574.0").
 * Anything non-numeric (or unsafely large) is returned trimmed-as-is rather
 * than mangled; null/undefined/'' stay null.
 */
export function normPosId(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
    return String(Math.trunc(n))
  }
  return s
}
