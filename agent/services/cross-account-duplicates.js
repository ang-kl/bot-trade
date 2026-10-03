// Cross-account duplicate rows: find them by evidence, void them, and put a
// falsely-closed original back (02-10-2026, № 10,448; owner № 10,447: "remove
// duplicates, I keep saying the cpp-verify has to do its job").
//
// WHAT HAPPENED. At 30-09 07:45:55Z one reconcile reply for …0058 carried
// …9908's four open positions. The reconciler adopted them as …0058's (trades
// 1729–1732, "phantoms") and, not seeing …0058's own five in that reply, closed
// them (1489/1490/1491/1711/1712 — "closed at the broker", no deal, no P&L).
// Three minutes later the next reply was right: the five were re-adopted as
// NEW rows 1733–1737 (opened_at 30-09, lineage lost) and the phantoms closed
// with no deal. cpp-verify's independent reading at 07:46:42Z said …0058: 5,
// …9908: 4 the whole time.
//
// Two shapes, both selected by evidence and nothing else:
//   · PHANTOM — a row on account A for a position another account B's row
//     holds with deal evidence (closed with exit price / P&L, or open and in
//     the verifier's list for B), while A's own row has no deal evidence.
//     Voided.
//   · PAIR — a closed row on account A with no deal evidence (the false close)
//     whose position a LATER open row on the SAME account holds (the
//     re-adoption). The original is reopened and its management rows
//     relinked; the twin is voided.
// Nothing is deleted from `trades`: a voided row keeps its history under
// status 'cancelled' — the withdrawn-row status the table's CHECK constraint
// allows (open/closed/cancelled/rejected/submitting/unconfirmed) and every
// reader that selects open/closed already excludes — with the marker in
// close_reason ('cross_account_duplicate:' / 'duplicate_adoption:').
import { normPosId } from '../lib/pos-id.js'
import { resetPnlVerdict } from './pnl-verdict-supersede.js'

export const VOID_STATUS = 'cancelled'
const NO_DEAL = "(exit_price IS NULL AND net_pnl IS NULL AND gross_pnl IS NULL)"

/** The verifier's position → account map from the stored independent reading. */
function verifierHeld(verifierState) {
  const held = new Map()
  for (const row of verifierState?.accounts || []) {
    if (!Array.isArray(row?.positions) || row.ok !== true) continue
    for (const p of row.positions) if (p?.positionId != null) held.set(normPosId(p.positionId), String(row.accountId))
  }
  return held
}

/**
 * The plan: what would be voided and what reopened, with the evidence for
 * each. Reads only. `verifierState` is the parsed `independent_protection_json`.
 */
export function planCrossAccountDuplicates(db, { verifierState = null } = {}) {
  const held = verifierHeld(verifierState)
  const phantoms = []
  const pairs = []
  const seen = new Set()
  const rows = db.prepare(`SELECT id, account_id, symbol, ctrader_position_id, status, opened_at, closed_at, close_reason, exit_price, net_pnl
                             FROM trades WHERE status IN ('open', 'closed') AND ctrader_position_id IS NOT NULL AND account_id IS NOT NULL ORDER BY id`).all()
  for (const t of rows) {
    const pid = normPosId(t.ctrader_position_id)
    const acct = String(t.account_id)
    const ownNoDeal = t.exit_price == null && t.net_pnl == null
    if (!ownNoDeal) continue
    // PHANTOM: another account's row holds this position with evidence.
    const twin = db.prepare(`SELECT id, account_id, status, exit_price, net_pnl FROM trades
                               WHERE ctrader_position_id IN (?, ?) AND account_id IS NOT NULL AND account_id <> ? AND status IN ('open', 'closed')
                               ORDER BY (exit_price IS NOT NULL OR net_pnl IS NOT NULL) DESC, id LIMIT 1`).get(pid, `${pid}.0`, acct)
    if (twin) {
      const twinAcct = String(twin.account_id)
      const twinEvidence = twin.exit_price != null || twin.net_pnl != null ? `closed with deal evidence (trade ${twin.id})`
        : twin.status === 'open' && held.get(pid) === twinAcct ? `open and in the verifier's list for …${twinAcct.slice(-4)} (trade ${twin.id})` : null
      const ownAtVerifier = t.status === 'open' && held.get(pid) === acct
      if (twinEvidence && !ownAtVerifier && !seen.has(t.id)) {
        seen.add(t.id)
        phantoms.push({ tradeId: t.id, accountId: acct, symbol: t.symbol, positionId: pid, status: t.status, heldBy: twinAcct, twinTradeId: twin.id, evidence: twinEvidence })
        continue
      }
    }
    // PAIR: the false close on this account, re-adopted later on this account.
    if (t.status === 'closed' && /^closed at the broker/i.test(String(t.close_reason || ''))) {
      const later = db.prepare(`SELECT id, opened_at FROM trades WHERE ctrader_position_id IN (?, ?) AND account_id = ? AND status = 'open' AND id > ? ORDER BY id LIMIT 1`).get(pid, `${pid}.0`, acct, t.id)
      if (later && !seen.has(t.id) && !seen.has(later.id)) {
        seen.add(t.id); seen.add(later.id)
        pairs.push({ originalTradeId: t.id, twinTradeId: later.id, accountId: acct, symbol: t.symbol, positionId: pid, falselyClosedAt: t.closed_at, twinOpenedAt: later.opened_at })
      }
    }
  }
  return { phantoms, pairs, verifierAccounts: [...new Set([...held.values()])] }
}

function voidTrade(db, { tradeId, accountId, positionId, closeReason, at }) {
  db.prepare(`UPDATE trades SET status = ?, close_reason = ?, closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ?`).run(VOID_STATUS, closeReason, tradeId)
  db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE trade_id = ? AND status <> 'closed'`).run(tradeId)
  db.prepare(`UPDATE momentum_book SET status = 'closed', exited_at = COALESCE(exited_at, ?), note = ? WHERE trade_id = ? AND status <> 'closed'`).run(at, closeReason, tradeId)
  db.prepare(`DELETE FROM position_history_incomplete WHERE account_id = ? AND ctrader_position_id IN (?, ?)`).run(accountId, positionId, `${positionId}.0`)
}

/**
 * Apply a plan from planCrossAccountDuplicates. One transaction per item;
 * every write is recorded in action_log. Returns what was written.
 */
export function applyCrossAccountDuplicates(db, plan, { at = new Date().toISOString() } = {}) {
  const out = { voided: [], reopened: [], errors: [] }
  const audit = db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
  for (const p of plan.phantoms || []) {
    try {
      db.transaction(() => {
        const reason = `cross_account_duplicate: position ${p.positionId} belongs to …${p.heldBy.slice(-4)} (trade ${p.twinTradeId}; ${p.evidence})`
        voidTrade(db, { tradeId: p.tradeId, accountId: p.accountId, positionId: p.positionId, closeReason: reason, at })
        audit.run('VOID_CROSS_ACCOUNT_DUPLICATE', '/actions/positions/void-cross-account-duplicates', JSON.stringify({ ...p, at }).slice(0, 2000), p.accountId)
      })()
      out.voided.push(p.tradeId)
    } catch (err) { out.errors.push({ tradeId: p.tradeId, error: String(err?.message || err) }) }
  }
  for (const pr of plan.pairs || []) {
    try {
      db.transaction(() => {
        // The original comes back as the live row: every field closeTradeRow
        // and the close stamp wrote is cleared, since the close never happened.
        db.prepare(`UPDATE trades SET status = 'open', closed_at = NULL, closed_at_ms = NULL, hold_duration_ms = NULL, close_reason = NULL,
                      exit_price = NULL, gross_pnl = NULL, net_pnl = NULL, realised_rr = NULL, pnl_price_mismatch = NULL WHERE id = ?`).run(pr.originalTradeId)
        // Rule 1 (03-10-2026, #1489 JNJ.US): the P&L verdict accumulated
        // against the close that did not happen — six refused attempts, the
        // write-off, the reader's memory, the capture give-up — goes with it,
        // or the next REAL close inherits a terminal verdict about this one.
        resetPnlVerdict(db, pr.originalTradeId, { method: 'PNL_VERDICT_RESET_ON_REOPEN', path: '/actions/positions/void-cross-account-duplicates', at,
          note: `reopened: the 30-09 close was false (twin ${pr.twinTradeId} voided)` })
        // Management rows follow the position, not the row id: the twin's
        // monitor and book rows (the stop they trailed since 30-09 included)
        // are relinked to the original; the original's own stale rows close.
        db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE trade_id = ? AND status <> 'closed'`).run(pr.originalTradeId)
        db.prepare(`UPDATE momentum_book SET status = 'closed', exited_at = COALESCE(exited_at, ?), note = 'superseded: management relinked from the duplicate adoption' WHERE trade_id = ? AND status <> 'closed'`).run(at, pr.originalTradeId)
        db.prepare(`UPDATE monitored_positions SET trade_id = ? WHERE trade_id = ?`).run(pr.originalTradeId, pr.twinTradeId)
        db.prepare(`UPDATE momentum_book SET trade_id = ? WHERE trade_id = ?`).run(pr.originalTradeId, pr.twinTradeId)
        const reason = `duplicate_adoption: superseded by trade ${pr.originalTradeId} (reopened; this row was the 30-09 re-adoption)`
        db.prepare(`UPDATE trades SET status = ?, close_reason = ?, closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ?`).run(VOID_STATUS, reason, pr.twinTradeId)
        db.prepare(`DELETE FROM position_history_incomplete WHERE account_id = ? AND ctrader_position_id IN (?, ?)`).run(pr.accountId, pr.positionId, `${pr.positionId}.0`)
        audit.run('REOPEN_FALSE_CLOSE', '/actions/positions/void-cross-account-duplicates', JSON.stringify({ ...pr, at }).slice(0, 2000), pr.accountId)
      })()
      out.reopened.push({ originalTradeId: pr.originalTradeId, voidedTwin: pr.twinTradeId })
    } catch (err) { out.errors.push({ tradeId: pr.originalTradeId, error: String(err?.message || err) }) }
  }
  return out
}
