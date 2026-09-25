import { ACCOUNT_HISTORY_SUMMARY_EXPRS } from '../db.js'
import { currencyGroups } from '../shared/balance-carry.js'

// V3 WEB-3 (8,989-A rows 5 and 7). Broker balance at a window edge, read from
// the observations account_history already stores (every 2-3 minutes per
// account since 2026-09-22 ~17:26 UTC). Nothing here asks the broker, derives
// a balance from trade P&L, carries one forward past its tolerance or fills a
// gap: an edge is either an OBSERVED broker balance with its read time and
// source, or it is NOT STORED with the reason. Never a zero, never invented.
//
// The rule for an edge at time E: the latest balance the broker returned at or
// before E and no more than BALANCE_EDGE_MAX_AGE_MS before it. At-or-before,
// not nearest: a close that settles between an after-edge read and E would
// otherwise land in both the carry and the window's net. The read time is
// stated so the owner can see how far from the edge it was.
export const BALANCE_EDGE_MAX_AGE_MS = 15 * 60_000
// broker_equity rows are written up to 60 s after the trader read their
// balance came from (broker-history-recorder MAX_SKEW_MS), so a row received
// just after E can hold a balance read at or before E.
const WRITE_SKEW_MS = 60_000
const HOSTS = { 0: 'demo.ctraderapi.com', 1: 'live.ctraderapi.com' }

const field = name => `CASE WHEN json_valid(observation_json) THEN json_extract(observation_json, '$.${name}') END`
const BALANCE_FIELDS = `id, source, received_ms AS receivedMs, ${field('balance')} AS balance, ${field('currency')} AS currency,
  ${field('error')} AS error, ${field('balanceReceivedAt')} AS balanceAt`
// A usable balance: a finite number, a stamped deposit currency, no error and a
// known broker read time. A snapshot whose balance time is unknown is skipped.
const balanceOk = r => typeof r.balance === 'number' && Number.isFinite(r.balance)
  && typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) && r.error == null && Number.isSafeInteger(r.balanceAt)
const floatOk = r => typeof r.openPnl === 'number' && Number.isFinite(r.openPnl)
  && typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) && r.error == null && Number.isSafeInteger(r.pnlAt)

/** Reader over one database snapshot. Caches per account; bounded queries. */
export function balanceReader(db, { maxAgeMs = BALANCE_EDGE_MAX_AGE_MS } = {}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new RangeError('invalid balance edge tolerance')
  // Reconcile rows (about 70 % of the table) never carry a balance; skipping
  // them by column keeps the JSON reads to the rows that can answer.
  const edgeSql = db.prepare(`SELECT ${BALANCE_FIELDS} FROM account_history
    WHERE account_id = ? AND host = ? AND received_ms >= ? AND received_ms <= ? AND source <> 'broker_reconcile'
    ORDER BY received_ms DESC, id DESC`)
  const valued = `AND source <> 'broker_reconcile' AND ${field('balance')} IS NOT NULL AND ${field('currency')} IS NOT NULL AND ${field('error')} IS NULL
    AND ${field('balanceReceivedAt')} IS NOT NULL`
  // No fixed LIMIT: the SQL filter already keeps only valued rows, so the scan
  // stops at the first row the JS check accepts (and, for the first stored
  // balance, the write-skew window after it). A fixed LIMIT would read "not
  // stored" if that many valued rows in a row failed the JS check.
  const firstSql = db.prepare(`SELECT ${BALANCE_FIELDS} FROM account_history WHERE account_id = ? AND host = ? ${valued}
    ORDER BY received_ms, id`)
  const latestSql = db.prepare(`SELECT ${BALANCE_FIELDS} FROM account_history WHERE account_id = ? AND host = ? ${valued}
    ORDER BY received_ms DESC, id DESC`)
  // Floating rows are exactly the rows with an equity value (balance + broker
  // P&L), which the covering summary index already carries; only those are
  // read from the table.
  const [currencyExpr, equityExpr, errorExpr] = ACCOUNT_HISTORY_SUMMARY_EXPRS
  const floatSql = db.prepare(`SELECT id, source, received_ms AS receivedMs, host, ${currencyExpr} AS currency, ${errorExpr} AS error,
    ${field('openPnl')} AS openPnl, ${field('pnlReceivedAt')} AS pnlReceivedAt
    FROM account_history INDEXED BY idx_account_history_summary
    WHERE account_id = ? AND received_ms >= ? AND received_ms <= ? AND host = ? AND ${equityExpr} IS NOT NULL ORDER BY received_ms, id`)
  const accounts = new Map(db.prepare('SELECT account_id, is_live FROM accounts ORDER BY account_id').all()
    .map(a => [String(a.account_id), HOSTS[a.is_live ? 1 : 0]]))
  const meta = new Map(), edges = new Map()

  /** The account's routing host, deposit currency and first stored balance. */
  function account(accountId) {
    const id = String(accountId)
    if (meta.has(id)) return meta.get(id)
    const host = accounts.get(id) ?? null
    let historyStartsAt = null, currency = null
    if (host) {
      let first = null
      for (const r of firstSql.iterate(id, host)) {
        if (!balanceOk(r)) continue
        if (first == null) first = r
        else if (r.receivedMs > first.receivedMs + WRITE_SKEW_MS) break
        historyStartsAt = historyStartsAt == null ? r.balanceAt : Math.min(historyStartsAt, r.balanceAt)
      }
      for (const r of latestSql.iterate(id, host)) if (balanceOk(r)) { currency = r.currency; break }
    }
    const out = { accountId: id, host, registered: host != null, currency, historyStartsAt }
    meta.set(id, out)
    return out
  }

  /** Observed balance at an edge, or the reason there is none. */
  function at(accountId, atMs) {
    const a = account(accountId), key = `${a.accountId}:${atMs}`
    if (edges.has(key)) return edges.get(key)
    let out
    if (!Number.isSafeInteger(atMs)) out = { status: 'not_stored', reason: 'invalid_edge' }
    else if (!a.registered) out = { status: 'not_stored', reason: 'account_not_registered' }
    else if (a.historyStartsAt == null) out = { status: 'not_stored', reason: 'no_balance_stored' }
    else if (atMs < a.historyStartsAt) out = { status: 'not_stored', reason: 'before_balance_history', storedFrom: a.historyStartsAt }
    else {
      let best = null
      for (const r of edgeSql.iterate(a.accountId, a.host, atMs - maxAgeMs, atMs + WRITE_SKEW_MS)) {
        if (!balanceOk(r) || r.balanceAt > atMs || r.balanceAt < atMs - maxAgeMs) continue
        if (best == null || r.balanceAt > best.balanceAt) best = r
      }
      out = best
        ? { status: 'observed', value: best.balance, currency: best.currency, at: best.balanceAt, source: best.source, ageMs: atMs - best.balanceAt }
        : { status: 'not_stored', reason: 'no_observation_near_edge', maxAgeMs }
    }
    edges.set(key, out)
    return out
  }

  /** The last broker floating P&L reading in each [from, to) span. */
  function floatingBySpan(accountId, spans) {
    const a = account(accountId)
    const out = spans.map(() => ({ status: 'not_stored', reason: a.registered ? 'no_floating_reading' : 'account_not_registered' }))
    if (!a.registered || !spans.length) return out
    const lo = Math.min(...spans.map(s => s.from)), hi = Math.max(...spans.map(s => s.to))
    for (const row of floatSql.iterate(a.accountId, lo, hi + WRITE_SKEW_MS, a.host)) {
      const r = { ...row, pnlAt: Number.isSafeInteger(row.pnlReceivedAt) ? row.pnlReceivedAt : row.receivedMs }
      if (!floatOk(r)) continue
      const i = spans.findIndex(s => r.pnlAt >= s.from && r.pnlAt < s.to)
      if (i < 0) continue
      if (out[i].status !== 'observed' || r.pnlAt >= out[i].at) {
        out[i] = { status: 'observed', value: r.openPnl, currency: r.currency, at: r.pnlAt, source: r.source }
      }
    }
    return out
  }

  return { account, at, floatingBySpan, accountIds: () => [...accounts.keys()], maxAgeMs }
}

/** The hourly card's balance columns: open/close balance and last floating per
 * hour, per account (one account) or per currency (all accounts). */
export function hourlyBalances(db, scope, rows, observedThrough, options) {
  const reader = balanceReader(db, options)
  const ids = scope.all ? reader.accountIds() : [String(scope.accountId)]
  const members = ids.map(id => reader.account(id))
  // The live hour closes at the observed-through time, never in the future.
  const spans = rows.map(r => ({ from: r.from, to: Math.min(r.to, observedThrough) }))
  const floats = new Map(ids.map(id => [id, reader.floatingBySpan(id, spans)]))
  const entries = (evidenceOf) => members.map(m => ({ accountId: m.accountId, currency: m.currency,
    storedFrom: m.historyStartsAt, evidence: evidenceOf(m) }))
  const shaped = spans.map((s, i) => {
    const open = currencyGroups(entries(m => reader.at(m.accountId, s.from)))
    const close = currencyGroups(entries(m => reader.at(m.accountId, s.to)))
    const floating = currencyGroups(entries(m => floats.get(m.accountId)[i]))
    return { openBal: open.total, closeBal: close.total, floating: floating.total,
      balanceCurrency: open.currency ?? close.currency, balance: { open, close, floating } }
  })
  return {
    rows: shaped,
    balanceHistory: { basis: 'observed_broker_balance_at_or_before_edge', maxAgeMs: reader.maxAgeMs,
      floatingBasis: 'last_broker_floating_reading_in_hour',
      accounts: members.map(m => ({ accountId: m.accountId, currency: m.currency, historyStartsAt: m.historyStartsAt, registered: m.registered })) },
  }
}

/** Ledger carries: observed balance at every ledger window's two edges, per
 * registered account. The shared reportLedger groups them for a scope. */
export function ledgerBalanceEdges(db, windows, options) {
  const reader = balanceReader(db, options)
  const ids = reader.accountIds()
  const byWindow = {}
  for (const w of windows) {
    byWindow[w.key] = Object.fromEntries(ids.map(id => [id, { in: reader.at(id, w.from), out: reader.at(id, w.to) }]))
  }
  return { status: 'complete', basis: 'observed_broker_balance_at_or_before_edge', maxAgeMs: reader.maxAgeMs,
    accounts: ids.map(id => { const m = reader.account(id); return { accountId: id, currency: m.currency, historyStartsAt: m.historyStartsAt } }),
    windows: byWindow }
}
