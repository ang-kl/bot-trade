// agent/services/veto-breakdown.js
//
// The data-backed answer to "should I loosen the guards / revert the
// architecture to trade more?" (owner, 2026-08-01). Instead of arguing from
// impressions, this counts WHICH gate ate HOW MANY entries over a window,
// from the two places every refusal is already recorded:
//
//   - risk_events — the risk gate's verdict per proposed entry
//     (approved 0/1 + veto_reason)
//   - decision_log — skips UPSTREAM of the risk gate (dispatch, style
//     filter, lesson decay, …), stage + decision + reason
//
// Read-only. The veto_reason strings are free-ish text with a stable
// machine-readable head ("unknown_daily_pnl (account): …"), so grouping
// normalises to the head token; the newest full string per group rides along
// as the human-readable example.

function reasonKey(reason) {
  const s = String(reason || 'unspecified').trim()
  // Head token: everything before the first ':' or ' — ', with any
  // parenthesised scope kept — "unknown_daily_pnl (account)" and
  // "unknown_daily_pnl (portfolio)" are different knobs.
  const cut = s.search(/[:—]/)
  let head = (cut === -1 ? s : s.slice(0, cut)).trim()
  // NUMBERS OUT OF THE KEY. Not every guard puts its scope before the first
  // ':' — several append live values to the head itself:
  //
  //   daily_loss_limit_hit pnl=-912.72 limit=16.16
  //   portfolio_margin_exhausted used=26266.06 cap=14383.37 source=estimate
  //
  // so the "distinct guard" count grew with every distinct P&L the guard had
  // ever seen. Production, 2026-08-04: 1,548 rows for what is really about
  // twenty guards, and a 507 KB response the browser polls. That is not a
  // display problem, it is the group key being a function of live data.
  //
  // The value is replaced by a placeholder rather than deleted, so
  // `pnl=<n> limit=<n>` still reads as the same guard with two numbers in it
  // and cannot collide with a different guard that happens to share a prefix.
  // The full original string survives untouched in `example`, so nothing an
  // operator needs is lost — it moves from the key to the sample.
  head = head.replace(/(=|\s)-?\d+(?:\.\d+)?\b/g, '$1<n>')
  return head.length > 80 ? head.slice(0, 80) : head
}

/**
 * Per-guard veto/skip counts over the last `days` (UTC-naive against the
 * stored `datetime('now')` timestamps, same convention as every other read).
 * `account` filters BOTH sources. The header used to say risk_events carried
 * no account column; that was true when this file was written and is not now —
 * M1a added it, and this read went on returning every account's vetoes under
 * one account's heading, with a note in the payload apologising for it. The
 * note has been replaced with what the query actually does.
 *
 * NULL-account rows are included on both sides, the convention every scoped
 * read here uses: a row written before stamping belongs to whoever is asking.
 */
/**
 * How many guard rows a single response may carry.
 *
 * Measured on production 2026-08-04: this route returned 506,936 bytes, of
 * which 537 KB was `guards` — 1,548 rows, each with a free-text `example` up
 * to 236 bytes. The row set is one per DISTINCT veto reason STRING, and those
 * strings embed live numbers ("daily_loss_limit_hit pnl=-912.72 limit=16.16"),
 * so the count grows with every distinct P&L the guard has ever seen. It is
 * unbounded by construction, and the browser polls it.
 *
 * A cap is the fix, but a SILENT cap would be the worse bug: the whole point
 * of this route is "which guard is eating my entries", and a truncated list
 * that does not say it was truncated reads as a complete answer. Hence
 * `truncated` in the payload rather than a quiet slice.
 */
export const MAX_GUARD_ROWS = 200

export function vetoBreakdown(db, { days = 7, account = null, limit = MAX_GUARD_ROWS } = {}) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const sinceExpr = `datetime('now', '-${d} days')`

  const acctScope = account != null ? 'AND (account_id = ? OR account_id IS NULL)' : ''
  const acctParams = account != null ? [String(account)] : []

  const riskRows = db.prepare(
    `SELECT approved, veto_reason, symbol, created_at
       FROM risk_events
      WHERE created_at >= ${sinceExpr}
        ${acctScope}`
  ).all(...acctParams)
  const decisionRows = db.prepare(
    `SELECT stage, decision, reason, symbol, account_id, created_at
       FROM decision_log
      WHERE created_at >= ${sinceExpr}
        AND decision IN ('skip', 'veto')
        ${acctScope}`
  ).all(...acctParams)

  const groups = new Map()
  const bump = (source, key, row) => {
    const k = `${source}|${key}`
    let g = groups.get(k)
    if (!g) {
      g = { source, guard: key, count: 0, symbols: new Map(), example: null, lastAt: null }
      groups.set(k, g)
    }
    g.count += 1
    if (row.symbol) g.symbols.set(row.symbol, (g.symbols.get(row.symbol) || 0) + 1)
    if (!g.lastAt || row.created_at > g.lastAt) {
      g.lastAt = row.created_at
      g.example = row.example
    }
  }

  let approved = 0
  let vetoed = 0
  for (const r of riskRows) {
    if (r.approved === 1) { approved += 1; continue }
    vetoed += 1
    bump('risk_gate', reasonKey(r.veto_reason), {
      symbol: r.symbol, created_at: r.created_at, example: r.veto_reason || null,
    })
  }
  for (const r of decisionRows) {
    bump(`upstream:${r.stage}`, reasonKey(r.reason), {
      symbol: r.symbol, created_at: r.created_at, example: r.reason || null,
    })
  }

  const allGuards = [...groups.values()]
    .map(g => ({
      source: g.source,
      guard: g.guard,
      count: g.count,
      // Top 5 symbols so "one symbol eats this gate" is visible at a glance.
      topSymbols: [...g.symbols.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([sym, n]) => ({ symbol: sym, count: n })),
      lastAt: g.lastAt,
      example: g.example,
    }))
    .sort((a, b) => b.count - a.count)

  // Sorted by count first, so the cap keeps the guards that actually matter
  // and drops the long tail of one-off reason strings.
  const cap = Math.max(1, Math.min(2000, Number(limit) || MAX_GUARD_ROWS))
  const guards = allGuards.slice(0, cap)
  const dropped = allGuards.length - guards.length
  const droppedVetoes = allGuards.slice(cap).reduce((n, g) => n + g.count, 0)

  return {
    ok: true,
    windowDays: d,
    account: account != null ? String(account) : null,
    note: account != null
      ? 'Both risk-gate vetoes and upstream decision_log skips are filtered to this account; rows written before per-account stamping (NULL account) are included.'
      : null,
    summary: {
      proposalsApproved: approved,
      proposalsVetoed: vetoed,
      approvalRate: approved + vetoed > 0
        ? Math.round(approved / (approved + vetoed) * 1000) / 10
        : null,
      upstreamSkips: decisionRows.length,
      // The TRUE distinct count, not the returned length — otherwise the cap
      // would quietly rewrite the very number an operator reads to judge how
      // fragmented the veto reasons are.
      distinctGuards: allGuards.length,
    },
    guards,
    truncated: dropped > 0
      ? {
        dropped,
        droppedVetoes,
        returned: guards.length,
        note: `${dropped} guard row(s) accounting for ${droppedVetoes} veto(es) are not in this response — raise ?limit= to see them. Rows are sorted by count, so what is missing is the tail.`,
      }
      : null,
  }
}
