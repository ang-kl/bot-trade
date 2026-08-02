// A5 — how much of the read side is actually account-aware, measured.
//
// This file exists because of a failure mode rather than a feature. Adding a
// viewed-account parameter to a couple of routes does not make a workspace,
// and a milestone marked "workspace reads — done" while thirty routes still
// answer from the trading account is worse than one marked "in progress": it
// stops anyone looking. So the coverage is computed from the DATABASE and
// from a declared route inventory, and the gaps are returned as data.
//
// TWO KINDS OF "GLOBAL", AND THEY ARE NOT THE SAME.
//
//   correctly global — the row is a fact about the WORLD, not about an
//     account. `regimes` and `symbol_hours` describe instruments;
//     `controller_heartbeats` is process health; `token_usage` is a process
//     cost. Duplicating these per account would multiply broker load and
//     invent differences that do not exist. These are listed as INTENDED, and
//     a future audit that "fixes" them would be making things worse.
//
//   not yet scoped — the row IS about an account and does not say which.
//     These are the gap.
//
// The route inventory is hand-declared and that is a real limitation, stated
// rather than hidden: there is no way to ask Express "which of your handlers
// read a per-account table", so a route added without touching this list will
// not appear. `declaredRoutes` is returned in the payload so the number is
// always accompanied by what it was computed from.
const PER_ACCOUNT_TABLES = [
  'accounts', 'analyses', 'broker_deals', 'broker_orders', 'cup_handle_diagnostics',
  'decision_log', 'monitored_positions', 'pending_orders', 'pending_signals',
  'performance_snapshots', 'position_events', 'risk_events', 'scans', 'signals',
  'trade_postmortems', 'trades', 'action_log', 'backtest_runs',
]

/** Global BY DESIGN. Scoping these would be a regression, not progress. */
export const INTENTIONALLY_GLOBAL = {
  regimes: 'a fact about instruments, not accounts',
  symbol_hours: 'a fact about instruments, not accounts',
  controller_heartbeats: 'process health, shared by every account',
  token_usage: 'a process cost, shared by every account',
  agent_state: 'the settings store — scoped by key convention (acct:<id>:<key>), not by column',
}

/**
 * /state routes and whether they accept an explicit account. Hand-declared;
 * see the header for why, and treat a missing entry as unmeasured rather than
 * as absent.
 */
export const DECLARED_ROUTES = [
  { path: '/state/trades', accountAware: true },
  { path: '/state/config', accountAware: true },
  { path: '/state/risk-full', accountAware: true },
  { path: '/state/account-analytics', accountAware: true },
  { path: '/state/goal-tracker', accountAware: false, note: 'reports every account at once by design' },
  { path: '/state/decision-feed', accountAware: true },
  { path: '/state/watchlist-summary', accountAware: true },
  { path: '/state/account-capabilities', accountAware: false, note: 'reports every account at once by design' },
  { path: '/state/account-traffic-lights', accountAware: false, note: 'reports every account at once by design' },
  { path: '/state/pause-plan', accountAware: true },
  { path: '/state/workspace-log', accountAware: true },
  { path: '/state/workspace-backtests', accountAware: true },
  { path: '/state/perf-ledger', accountAware: true },
  { path: '/state/decisions', accountAware: false, note: 'raw log view — filters by symbol and stage only' },
  { path: '/state/heartbeats', accountAware: false, note: 'process health, correctly global' },
  { path: '/state/storage', accountAware: false, note: 'process storage, correctly global' },
  // Partial by design, not by omission: `signals` comes from scans, which are
  // account-independent market observations. The route's payload names which
  // stages were filtered.
  { path: '/state/strategy-liveness', accountAware: true, note: 'partial — decisions/opened/closed scoped, signals global (scans are market observations)' },
  // CORRECTION. This was declared a gap in the A5 commit and it was not one:
  // the route had accepted ?account= since it was written. That is precisely
  // the failure mode the hand-declared list warns about, so the wrong entry is
  // recorded here rather than quietly overwritten.
  { path: '/state/veto-breakdown', accountAware: true, note: 'was mis-declared a gap in the A5 coverage list; it accepted ?account= all along' },
  { path: '/state/phase-audit', accountAware: true, note: 'per-account phase flips scoped; master switches and controller events stay NULL and are included' },
]

/**
 * @param {*} db
 * @returns {{tables, routes, summary}}
 */
export function workspaceCoverage(db) {
  const tables = PER_ACCOUNT_TABLES.map(name => {
    let exists = false
    let scoped = false
    let unstamped = null
    let total = null
    try {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all()
      exists = cols.length > 0
      scoped = cols.some(c => c.name === 'account_id')
    } catch { exists = false }
    if (exists && scoped) {
      try {
        total = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get()?.c || 0)
        unstamped = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${name} WHERE account_id IS NULL`).get()?.c || 0)
      } catch { total = null; unstamped = null }
    }
    return { table: name, exists, scoped, total, unstamped }
  })

  const globals = Object.entries(INTENTIONALLY_GLOBAL).map(([table, why]) => ({ table, why }))

  const routes = DECLARED_ROUTES
  const aware = routes.filter(r => r.accountAware).length
  const gaps = routes.filter(r => !r.accountAware && /real gap/.test(r.note || ''))
  const partial = routes.filter(r => /^partial/.test(r.note || ''))

  return {
    tables,
    intentionallyGlobal: globals,
    routes,
    declaredRoutes: routes.length,
    summary: {
      tablesScoped: tables.filter(t => t.exists && t.scoped).length,
      tablesMissing: tables.filter(t => t.exists && !t.scoped).map(t => t.table),
      // Rows written before the column existed. Not a fault — they are
      // included in every scoped read by convention — but the number is how
      // you tell "this workspace has no history" from "this history predates
      // scoping".
      unstampedRows: tables.reduce((n, t) => n + (t.unstamped || 0), 0),
      routesAccountAware: aware,
      routesDeclared: routes.length,
      knownGaps: gaps.map(r => r.path),
      // Scoped, but not on every field. Reported separately from both the
      // wins and the gaps, because "partial" is neither.
      partiallyScoped: partial.map(r => ({ path: r.path, note: r.note })),
      caveat: 'Route coverage is hand-declared in workspace-coverage.js; a route added without updating that list is unmeasured, not absent.',
    },
  }
}
