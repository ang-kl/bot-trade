// ---------------------------------------------------------------------------
// agent/services/pnl-verdict-supersede.js — a P&L verdict is about ONE close.
//
// THE DEFECT, measured on production 03-10-2026 (trade #1489, JNJ.US on
// …0058, broker position 240732676). On 30-09 a wrong-account reconcile reply
// marked the row closed at 07:45:55Z and adopted the same position again as
// #1733. The settlement for #1489 was refused six times on the ledger
// identity (another claimant: #1733), and at attempt six (09:49:45Z) the
// old-position reader recorded a terminal verdict: "unresolved: no broker
// evidence: ledger identity ambiguous … net_pnl stays NULL". On 02-10 the
// void route (cross-account-duplicates.js) voided #1733 and REOPENED #1489;
// the position then really closed at 13:31:52Z the same day. The row still
// carried `pnl_attempts 6` — LIVE_GAP_MAX_ATTEMPTS — plus the write-off and
// the reader's "judged" memory, so every repair skipped it for ever. A
// verdict about an earlier, FALSE close was being applied to a later, REAL
// close, and nothing in the ledger could tell the two apart.
//
// TWO RULES, both about the ORDER of events, neither about the money:
//
//   Rule 1 — a reopen resets the verdict. When a closed row is put back to
//   `open`, every attempt counter, last-attempt stamp, write-off and reader
//   memory that was accumulated against the close that did not happen is
//   cleared, so the next real close is judged fresh. resetPnlVerdict() is the
//   one helper that knows every place a verdict lives; the reopen path calls
//   it inside its own transaction.
//
//   Rule 2 — a close newer than the verdict supersedes it. Attempts are only
//   ever stamped on a CLOSED row, so `closed_at` later than
//   `pnl_last_attempt_at` is only possible when the row was reopened and
//   closed again after the attempts were spent. Such a row gets the same
//   reset, once, with ONE log line naming it. Rows at the cap with NO
//   last-attempt stamp carry no evidence of ordering either way: they are
//   NOT reset (that would be a guess) but they are counted and named as
//   "unordered" so they are visible rather than silently terminal.
//
// Nothing here computes, estimates or copies a P&L: net_pnl stays NULL until
// the broker's own deal history fills it. The reset only makes the row a
// repair candidate again. Every reset is audited (action_log
// PNL_VERDICT_SUPERSEDED / PNL_VERDICT_RESET_ON_REOPEN) with the verdict it
// replaced, so the earlier finding is history, not erased.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { LIVE_GAP_MAX_ATTEMPTS } from './pnl-backfill.js'

// Ledger timestamps come in both 'YYYY-MM-DD HH:MM:SS' (UTC) and ISO forms —
// the same normalisation as pnl-backfill.js's ledgerMs (not exported there).
export const ledgerMs = v => {
  if (v == null || v === '') return NaN
  const raw = String(v).replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`)
}

const tail = a => (a == null ? 'no account' : `…${String(a).slice(-4)}`)
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '?')

/**
 * Pure read (Rule 2): closed, unpriced rows carrying a terminal verdict, split
 * by what their timestamps prove. A verdict is EITHER the attempt cap OR a
 * write-off (`pnl_unresolvable = 1`): mark-unresolvable.js's account-level
 * sweep writes off every old unresolved row on an exhausted account, so a row
 * with ONE attempt can be terminal too (Codex P1 on #1207, 03-10-2026). Both
 * are examined; the attempt count alone is not the test.
 *   superseded — closed_at is LATER than pnl_last_attempt_at: the verdict
 *                predates this close and must not govern it.
 *   unordered  — a verdict but no last-attempt stamp: no evidence
 *                of ordering; reported, never reset by this rule.
 * Everything else (closed at or before the last attempt) is a standing
 * terminal verdict and is not returned.
 */
export function supersededPnlVerdicts(db, { maxAttempts = LIVE_GAP_MAX_ATTEMPTS } = {}) {
  const rows = db.prepare(`
    SELECT id, symbol, account_id, ctrader_position_id, closed_at, pnl_attempts, pnl_last_attempt_at,
           COALESCE(pnl_unresolvable, 0) AS pnl_unresolvable, pnl_unresolvable_reason
      FROM trades
     WHERE status = 'closed' AND net_pnl IS NULL
       AND (COALESCE(pnl_attempts, 0) >= ? OR COALESCE(pnl_unresolvable, 0) = 1)
     ORDER BY id
  `).all(Math.max(1, Number(maxAttempts) || LIVE_GAP_MAX_ATTEMPTS))
  const superseded = [], unordered = []
  for (const r of rows) {
    const closedMs = ledgerMs(r.closed_at), lastMs = ledgerMs(r.pnl_last_attempt_at)
    const entry = { ...r, closedMs, lastMs }
    if (!Number.isFinite(lastMs)) { unordered.push(entry); continue }
    if (Number.isFinite(closedMs) && closedMs > lastMs) superseded.push(entry)
  }
  return { superseded, unordered }
}

/**
 * Every place a P&L verdict for one trade lives, cleared together:
 *   - trades: pnl_attempts, pnl_last_attempt_at, and the write-off triple
 *     (pnl_unresolvable / _reason / _at) that old-position-pnl.js and
 *     mark-unresolvable.js write;
 *   - the old-position reader's "judged" memory for the trade id
 *     (agent_state position_pnl_reread:<account>), which otherwise keeps a
 *     written-off row out of its candidate list for good;
 *   - the position-capture queue's `gave_up` row for the position (same
 *     shape: six attempts then terminal), re-armed as pending with its count
 *     at zero so the record of the real close is built.
 * Returns what was found and reset, for the audit row and the log line.
 */
export function resetPnlVerdict(db, tradeId, { method = 'PNL_VERDICT_RESET', path = '/pnl-verdict', at = new Date().toISOString(), note = null } = {}) {
  const id = Number(tradeId)
  const row = db.prepare(`SELECT id, symbol, account_id, ctrader_position_id, status, closed_at, pnl_attempts, pnl_last_attempt_at,
      COALESCE(pnl_unresolvable, 0) AS pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at FROM trades WHERE id = ?`).get(id)
  if (!row) return { found: false, tradeId: id }
  const out = { found: true, tradeId: id, attempts: Number(row.pnl_attempts) || 0, lastAttemptAt: row.pnl_last_attempt_at ?? null,
    writtenOff: Number(row.pnl_unresolvable) === 1, writtenOffReason: row.pnl_unresolvable_reason ?? null, rereadCleared: false, captureRearmed: false }
  db.prepare(`UPDATE trades SET pnl_attempts = 0, pnl_last_attempt_at = NULL,
      pnl_unresolvable = 0, pnl_unresolvable_reason = NULL, pnl_unresolvable_at = NULL WHERE id = ?`).run(id)
  if (row.account_id != null) {
    const key = `position_pnl_reread:${String(row.account_id)}`
    try {
      const map = JSON.parse(getState(db, key) || 'null')
      if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, String(id))) {
        const { [String(id)]: _judged, ...rest } = map
        setState(db, key, JSON.stringify(rest))
        out.rereadCleared = true
      }
    } catch { /* unreadable memory — nothing to clear */ }
    const pid = row.ctrader_position_id == null ? null : String(row.ctrader_position_id).replace(/\.0$/, '')
    if (pid) {
      try {
        out.captureRearmed = db.prepare(`UPDATE position_capture_queue
            SET state = 'pending', attempts = 0, last_error = NULL, settled_at = NULL, due_at_ms = ?
          WHERE account_id = ? AND position_id IN (?, ?) AND state = 'gave_up'`).run(Date.now(), String(row.account_id), pid, `${pid}.0`).changes > 0
      } catch { /* table absent on an older schema — nothing to re-arm */ }
    }
  }
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run(method, path, JSON.stringify({ ...out, symbol: row.symbol, positionId: row.ctrader_position_id, status: row.status, closedAt: row.closed_at,
        writtenOffAt: row.pnl_unresolvable_at ?? null, at, note }).slice(0, 2000), row.account_id == null ? null : String(row.account_id))
  } catch { /* audit best-effort */ }
  return out
}

/**
 * Rule 2 applied: one cheap read, the resets, ONE log line. Runs at boot and
 * once per loop cycle before the P&L backfill, so a superseded row is a
 * candidate again on the very pass that follows.
 */
export function sweepSupersededPnlVerdicts(db, { log = console.log, now = Date.now() } = {}) {
  let found
  try { found = supersededPnlVerdicts(db) } catch (e) { return { superseded: [], unordered: [], error: e.message } }
  const at = new Date(now).toISOString()
  const reset = []
  for (const r of found.superseded) {
    try {
      const o = resetPnlVerdict(db, r.id, { method: 'PNL_VERDICT_SUPERSEDED', path: '/loop/pnl-verdicts', at,
        note: `closed ${iso(r.closedMs)} after the last attempt ${iso(r.lastMs)}; the verdict was about an earlier close` })
      reset.push({ ...r, reset: o })
    } catch (e) { reset.push({ ...r, error: e.message }) }
  }
  if (reset.length || found.unordered.length) {
    const named = reset.map(r => `#${r.id} ${r.symbol ?? '?'} ${tail(r.account_id)} (closed ${iso(r.closedMs)}, last attempt ${iso(r.lastMs)}${r.error ? `, reset FAILED: ${r.error}` : ''})`)
    const unordered = found.unordered.map(r => `#${r.id} ${r.symbol ?? '?'} ${tail(r.account_id)} (${r.pnl_attempts} attempts, no last-attempt stamp)`)
    const parts = [`${reset.length} row(s) closed after their last attempt${named.length ? ` — ${named.join('; ')}` : ''}`]
    if (unordered.length) parts.push(`${unordered.length} unordered (left terminal, no ordering evidence) — ${unordered.join('; ')}`)
    try { log(`[loop] P&L verdicts superseded: ${parts.join('; ')}`) } catch { /* log must not fail the sweep */ }
  }
  return { superseded: reset, unordered: found.unordered }
}
