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
  const head = (cut === -1 ? s : s.slice(0, cut)).trim()
  return head.length > 80 ? head.slice(0, 80) : head
}

/**
 * Per-guard veto/skip counts over the last `days` (UTC-naive against the
 * stored `datetime('now')` timestamps, same convention as every other read).
 * `account` filters decision_log rows (risk_events carries no account column
 * before M1; rows are reported as-is with that caveat in the payload).
 */
export function vetoBreakdown(db, { days = 7, account = null } = {}) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const sinceExpr = `datetime('now', '-${d} days')`

  const riskRows = db.prepare(
    `SELECT approved, veto_reason, symbol, created_at
       FROM risk_events
      WHERE created_at >= ${sinceExpr}`
  ).all()

  const acctScope = account != null ? 'AND (account_id = ? OR account_id IS NULL)' : ''
  const decisionRows = db.prepare(
    `SELECT stage, decision, reason, symbol, account_id, created_at
       FROM decision_log
      WHERE created_at >= ${sinceExpr}
        AND decision IN ('skip', 'veto')
        ${acctScope}`
  ).all(...(account != null ? [String(account)] : []))

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

  const guards = [...groups.values()]
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

  return {
    ok: true,
    windowDays: d,
    account: account != null ? String(account) : null,
    note: account != null
      ? 'risk_events rows are account-unscoped (pre-M1 schema) and are reported for ALL accounts; the upstream decision_log rows are filtered to this account (NULL-account rows included).'
      : null,
    summary: {
      proposalsApproved: approved,
      proposalsVetoed: vetoed,
      approvalRate: approved + vetoed > 0
        ? Math.round(approved / (approved + vetoed) * 1000) / 10
        : null,
      upstreamSkips: decisionRows.length,
      distinctGuards: guards.length,
    },
    guards,
  }
}
