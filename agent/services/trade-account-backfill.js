// ---------------------------------------------------------------------------
// agent/services/trade-account-backfill.js — give historical trades their
// account back.
//
// WHY. Owner, 2026-08-03, looking at the Go-Live Gate card: six panels —
// "All accounts", four "Pepperstone", one "Pepperstone LIVE", one
// "Pepperstone disabled" — every one showing 245/244 closed and 89W/156L.
// They were not per-account numbers. They were the same pooled history six
// times.
//
// The cause is the scoped-read convention, working exactly as designed. A
// scoped read is `WHERE (account_id = ? OR account_id IS NULL)`, because rows
// written before per-account stamping belong to whoever is asking — dropping
// them would understate every window spanning the migration. That is correct
// when unstamped rows are a small residue. It is ruinous when they are ALL of
// them: every account then sees the entire portfolio, including the row
// labelled LIVE, which showed 244 closed trades for an account holding
// SGD 34.30.
//
// A go-live decision made against that row would be made against somebody
// else's trades.
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO. `monitored_positions` HAS been
// carrying `account_id` since M1a (db.js:180 — it was the first table to get
// the column). Every managed trade has a monitored_positions row joined by
// `trade_id`. So for those, the account is not a guess: it is recorded, one
// join away, and this copies it across.
//
// For a trade with no monitored_positions row, or whose row is itself
// unstamped, the account is UNKNOWN and the row is left NULL. Inferring it
// from "the account that was selected around then" would manufacture history,
// and the whole point of this file is that the card stopped being trustworthy.
// A NULL that means "unknown" is honest; a wrong id is not.
// ---------------------------------------------------------------------------

/**
 * Copy `account_id` onto trades from their monitored_positions row.
 *
 * Idempotent — it only ever touches rows where trades.account_id IS NULL, so
 * running it every cycle costs one indexed scan and changes nothing once the
 * backlog is drained. Never throws: a reporting repair must not be able to
 * stop the loop it runs inside.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{limit?: number}} opts  bound per pass so a huge backlog is drained
 *   across cycles rather than in one long transaction
 * @returns {{stamped: number, remaining: number, unknowable: number}}
 */
export function backfillTradeAccounts(db, { limit = 500 } = {}) {
  const out = { stamped: 0, remaining: 0, unknowable: 0 }
  try {
    const info = db.prepare(`
      UPDATE trades SET account_id = (
        SELECT m.account_id FROM monitored_positions m
         WHERE m.trade_id = trades.id AND m.account_id IS NOT NULL
         LIMIT 1
      )
      WHERE account_id IS NULL
        AND id IN (
          SELECT t.id FROM trades t
            JOIN monitored_positions mp ON mp.trade_id = t.id
           WHERE t.account_id IS NULL AND mp.account_id IS NOT NULL
           LIMIT ?
        )
    `).run(limit)
    out.stamped = info.changes

    // Reported separately, because they are different problems. `remaining`
    // is work still to do; `unknowable` is work that CANNOT be done and must
    // not be silently counted as pending forever.
    out.remaining = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM trades t
        JOIN monitored_positions mp ON mp.trade_id = t.id
       WHERE t.account_id IS NULL AND mp.account_id IS NOT NULL
    `).get()?.n || 0)

    out.unknowable = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM trades t
       WHERE t.account_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM monitored_positions mp
            WHERE mp.trade_id = t.id AND mp.account_id IS NOT NULL
         )
    `).get()?.n || 0)
  } catch { /* a reporting repair must never break trading */ }
  return out
}

/**
 * How much of the ledger can actually answer "which account?".
 *
 * Exposed so the gate card can say "these numbers cover N% of closed trades"
 * instead of presenting a pooled figure under a per-account heading — the
 * exact failure this module exists to end. A coverage number that is low is
 * information; a per-account panel that quietly is not per-account is not.
 */
export function accountStampCoverage(db) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) AS stamped
        FROM trades WHERE status = 'closed'
    `).get()
    const total = Number(row?.total || 0)
    const stamped = Number(row?.stamped || 0)
    return {
      total,
      stamped,
      unstamped: total - stamped,
      pct: total > 0 ? Math.round((stamped / total) * 1000) / 10 : null,
    }
  } catch {
    return { total: 0, stamped: 0, unstamped: 0, pct: null }
  }
}
