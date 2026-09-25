// ---------------------------------------------------------------------------
// agent/services/data-feed-report.js — what the Performance page's Data-feed
// card can say from MEASURED records (8,989-A row 11, WEB-9).
//
// The card used to print fees as prose, latency as a hard-coded '—', and no
// quote freshness at all — while the per-trade fields it needed were already
// stored: `trades.entry_latency_ms` (submit → execution event, loop.js), and
// `trades.commission` / `trades.swap` (from the broker's deal history). A
// dash where a measurement exists is the same failure as a number where none
// exists: the reader cannot tell "not collected" from "not shown".
//
// THREE RULES, each one a thing this file refuses to do:
//
//   1. COVERAGE TRAVELS WITH EVERY FIGURE. A p50 over 154 of 300 closes is a
//      different fact from a p50 over 300 of 300; the count is returned beside
//      the number, and a figure with no measured rows is null, never 0.
//   2. MONEY IS NEVER SUMMED ACROSS CURRENCIES (WEB-5 default). Commission
//      and swap are stored in the account's deposit currency, so they are
//      grouped by the BROKER-VERIFIED deposit currency
//      (`acct:<id>:deposit_currency_evidence_json`, written only from the
//      broker's asset list). An account with no verified currency — or a row
//      with no account — gets its own bucket with `currency: null`, never a
//      guessed one.
//   3. READ-ONLY. Nothing here writes, and nothing is recomputed from a price
//      move: the sums are of the stored fields exactly as the broker gave them
//      (broker sign: a charged commission is negative).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

/** How many recent closes the execution figures cover by default. */
export const EXECUTION_WINDOW_DEFAULT = 300
/** Upper bound on the window — a read route must stay cheap. */
export const EXECUTION_WINDOW_MAX = 1000

const cents = v => Math.round(v * 100) / 100
const finite = v => typeof v === 'number' && Number.isFinite(v)

/**
 * Nearest-rank percentile of an ASCENDING array: the smallest value with at
 * least p % of the sample at or below it. Deterministic, no interpolation —
 * every reported latency is one that was actually measured.
 * @param {number[]} sortedAsc
 * @param {number} p  0 < p <= 100
 * @returns {number|null}
 */
export function nearestRank(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]
}

/**
 * The broker-verified deposit currency of one account, or null when nothing
 * verified it. Never falls back to the registry's base_currency or to 'USD':
 * a default currency is a guess, and rule 2 above exists to refuse guesses.
 */
export function verifiedDepositCurrency(db, accountId) {
  if (accountId == null || accountId === '') return null
  try {
    const ev = JSON.parse(getState(db, `acct:${accountId}:deposit_currency_evidence_json`) || 'null')
    if (!ev || String(ev.accountId) !== String(accountId)) return null
    return typeof ev.currency === 'string' && /^[A-Z]{3}$/.test(ev.currency) ? ev.currency : null
  } catch {
    return null
  }
}

/**
 * Entry latency and stored fees/swap over the latest `limit` closed trades.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{where?: string, params?: unknown[], limit?: number}} [opts]
 *   `where`/`params` are an account-scope fragment from accountWhere().
 */
export function executionCosts(db, { where = '', params = [], limit = EXECUTION_WINDOW_DEFAULT } = {}) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(EXECUTION_WINDOW_MAX, Math.floor(Number(limit))) : EXECUTION_WINDOW_DEFAULT
  // COST NOTE (WEB-9 check, synthetic timings): this walks
  // idx_trades_status_closed newest-first and filters the account scope row
  // by row, with no temp sort. For a busy scope it stops after `n` rows
  // (1–6 ms at 200k closes); for an account with FEW closes it walks the
  // whole closed set before LIMIT is met (~20 ms at 50k, ~78 ms at 200k),
  // on the main thread. Fine at today's size; if the trades table grows
  // toward that, give this read an (account_id, status, closed_at) index.
  const rows = db.prepare(
    `SELECT id, account_id, entry_latency_ms, commission, swap, closed_at
       FROM trades
      WHERE status = 'closed'${where ? ` AND ${where}` : ''}
      ORDER BY closed_at DESC, id DESC
      LIMIT ?`
  ).all(...params, n)

  // ---- latency: submit → execution event, as stored at entry -------------
  const measured = rows.map(r => r.entry_latency_ms).filter(v => finite(v) && v >= 0).sort((a, b) => a - b)
  const latency = {
    measured: measured.length,
    of: rows.length,
    p50Ms: nearestRank(measured, 50),
    p90Ms: nearestRank(measured, 90),
    maxMs: measured.length ? measured[measured.length - 1] : null,
    field: 'trades.entry_latency_ms',
    meaning: 'order submit to the broker execution event, stamped at entry',
  }

  // ---- fees and swap, per verified deposit currency ------------------------
  const currencyOf = new Map()
  const buckets = new Map()
  let unattributed = 0
  for (const r of rows) {
    const acct = r.account_id == null ? null : String(r.account_id)
    if (acct == null) unattributed++
    if (acct != null && !currencyOf.has(acct)) currencyOf.set(acct, verifiedDepositCurrency(db, acct))
    const ccy = acct == null ? null : currencyOf.get(acct)
    const key = ccy ?? '\u0000unverified'
    let b = buckets.get(key)
    if (!b) {
      b = { currency: ccy, closes: 0, commissionKnown: 0, commission: 0, swapKnown: 0, swap: 0, accounts: new Set() }
      buckets.set(key, b)
    }
    b.closes++
    if (acct != null) b.accounts.add(acct)
    if (finite(r.commission)) { b.commissionKnown++; b.commission += r.commission }
    if (finite(r.swap)) { b.swapKnown++; b.swap += r.swap }
  }
  const costs = [...buckets.values()]
    // Verified currencies first (alphabetical), the unverified bucket last.
    .sort((a, b) => (a.currency == null) - (b.currency == null) || String(a.currency).localeCompare(String(b.currency)))
    .map(b => ({
      currency: b.currency,
      closes: b.closes,
      commissionKnown: b.commissionKnown,
      commission: b.commissionKnown ? cents(b.commission) : null,
      swapKnown: b.swapKnown,
      swap: b.swapKnown ? cents(b.swap) : null,
      accounts: [...b.accounts].sort(),
    }))

  return {
    window: {
      closes: rows.length,
      limit: n,
      newestClosedAt: rows[0]?.closed_at ?? null,
      oldestClosedAt: rows.length ? rows[rows.length - 1].closed_at ?? null : null,
      unattributed,
    },
    latency,
    costs,
    feeSign: 'as stored from broker deal history: a charged commission or a paid swap is negative',
  }
}

/**
 * Quote freshness from the fast monitor's own pass record — the same record
 * /health's `fastMonitor` block reads (`fast_monitor_pass_json`). The age of
 * the record is returned with it: a ten-minute window that stopped being
 * written an hour ago is an hour-old reading, not a current one.
 */
export function quoteFreshness(db, nowMs = Date.now()) {
  let rec = null
  try { rec = JSON.parse(getState(db, 'fast_monitor_pass_json') || 'null') } catch { rec = null }
  if (!rec?.tick) return { status: 'unavailable', reason: 'no fast-monitor pass record', at: null, ageMs: null, window10m: null, lastPass: null }
  const atMs = Date.parse(rec.at)
  const q10 = rec.tick.quotes10m
  const window10m = q10 && q10.passes
    ? {
        passes: q10.passes,
        fromSidecar: q10.fromSidecar ?? null,
        fromBroker: q10.fromBroker ?? null,
        stale: q10.stale ?? null,
        sidecarSharePct: q10.sidecarSharePct ?? null,
      }
    : null
  return {
    status: window10m ? 'measured' : 'no_priced_pass',
    reason: window10m ? null : 'the record carries no priced pass in its 10-minute window',
    at: rec.at ?? null,
    ageMs: Number.isFinite(atMs) ? Math.max(0, nowMs - atMs) : null,
    window10m,
    lastPass: rec.tick.quotes ?? null,
  }
}

/**
 * The measurements this card is asked for that no code path records yet.
 * Named so the page can say "not measured" instead of drawing a dash.
 */
export const NOT_MEASURED = Object.freeze([
  { key: 'feed_latency', label: 'market-feed latency (broker timestamp to receipt)' },
  { key: 'timeframe_receipts', label: 'per-timeframe bar receipt times (1m, 15m, 1h, 4h)' },
])
