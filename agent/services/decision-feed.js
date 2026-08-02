// decision-feed — "why didn't it trade?", answered on the Performance page.
//
// decision_log has recorded every upstream skip since the 3A slice, and the
// only way to read it was GET /state/decisions returning raw rows. That is a
// developer's view: a hundred rows of `stage=style_filter decision=skip` tells
// you nothing you can act on, because ONE waiting setup re-logs the same skip
// every five-minute cycle. The mix is the information, not the volume.
//
// So the feed returns two things from one pass:
//
//   summary — stage × decision counts over the window, plus the reasons under
//             each stage, ranked. This is what "the bot did nothing today"
//             actually decomposes into.
//   rows    — the newest individual decisions, for when the summary points at
//             something and you want the instances.
//
// REPEATS ARE COUNTED AND ALSO COLLAPSED. `count` is the raw number of rows —
// the honest total, repeats included — and `distinctSymbols` is how many
// different instruments produced it. A stage with 800 rows across 3 symbols is
// three stuck setups retrying; 800 rows across 200 symbols is a filter that is
// rejecting the whole universe. Those are different problems and the old raw
// list could not tell them apart.
//
// ACCOUNT SCOPING follows the same convention as the rest of the multi-account
// read side: rows with a NULL account_id predate per-account stamping (or are
// account-independent market observations) and belong to whichever account is
// asking. `unstamped` reports how many of the returned rows were NULL, so a
// per-account reading never quietly presents shared rows as that account's own.
import { getState } from '../db.js'

/** How many reasons to rank under each stage before saying "and N more". */
export const REASONS_PER_STAGE = 6
/** Hard ceiling on returned rows, whatever the caller asks for. */
export const MAX_ROWS = 500

const DEFAULT_HOURS = 24

/**
 * @param {*} db
 * @param {{accountId?: string|null, hours?: number, limit?: number,
 *          stage?: string|null, decision?: string|null, symbol?: string|null,
 *          now?: number}} opts
 *   accountId 'all'/null = every account. Otherwise that account plus the
 *   unstamped rows, flagged as such.
 * @returns {{windowHours, since, accountId, totals, stages, rows, unstamped, truncated}}
 */
export function decisionFeed(db, {
  accountId = null, hours = DEFAULT_HOURS, limit = 100,
  stage = null, decision = null, symbol = null, now = Date.now(),
} = {}) {
  const windowHours = Number(hours) > 0 ? Number(hours) : DEFAULT_HOURS
  const n = Math.min(Math.max(1, Number(limit) || 100), MAX_ROWS)
  const acct = accountId && accountId !== 'all' ? String(accountId) : null
  const since = new Date(now - windowHours * 3_600_000).toISOString()

  const where = []
  const params = []
  // created_at is written by SQLite's datetime('now') — space-separated, no
  // zone. Comparing a 'T' ISO cutoff against it matches nothing, which on a
  // "why didn't it trade" panel would render as "no decisions at all" — the
  // most misleading possible answer. Normalise both sides, the same fix
  // strategy-liveness.js carries for the same reason.
  where.push("REPLACE(created_at, 'T', ' ') >= REPLACE(?, 'T', ' ')")
  params.push(since)
  if (acct) { where.push('(account_id = ? OR account_id IS NULL)'); params.push(acct) }
  if (stage) { where.push('stage = ?'); params.push(String(stage)) }
  if (decision) { where.push('decision = ?'); params.push(String(decision)) }
  if (symbol) { where.push('symbol = ?'); params.push(String(symbol).toUpperCase()) }
  const sql = where.join(' AND ')

  let grouped = []
  let rows = []
  try {
    grouped = db.prepare(`
      SELECT stage, decision, reason,
             COUNT(*) AS n,
             COUNT(DISTINCT symbol) AS syms,
             MAX(created_at) AS last_at,
             SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS unstamped
        FROM decision_log
       WHERE ${sql}
       GROUP BY stage, decision, reason`).all(...params)
    rows = db.prepare(`
      SELECT id, account_id, symbol, timeframe, strategy, stage, decision, reason, created_at
        FROM decision_log
       WHERE ${sql}
       ORDER BY id DESC LIMIT ?`).all(...params, n)
  } catch {
    // Table missing on an old DB. Empty is the honest answer; it is reported
    // as a window with nothing in it, not as an error the page must handle.
    grouped = []
    rows = []
  }

  const byStage = new Map()
  let total = 0
  let unstamped = 0
  const totals = { proceed: 0, skip: 0, veto: 0, other: 0 }

  for (const g of grouped) {
    const count = Number(g.n || 0)
    total += count
    unstamped += Number(g.unstamped || 0)
    const d = String(g.decision || '')
    if (d in totals) totals[d] += count
    else totals.other += count

    const key = String(g.stage || '(unstaged)')
    if (!byStage.has(key)) {
      byStage.set(key, { stage: key, count: 0, distinctSymbols: 0, lastAt: null, decisions: {}, reasonRows: [] })
    }
    const s = byStage.get(key)
    s.count += count
    s.decisions[d] = (s.decisions[d] || 0) + count
    if (s.lastAt == null || String(g.last_at) > String(s.lastAt)) s.lastAt = g.last_at
    s.reasonRows.push({
      reason: g.reason || null,
      decision: d,
      count,
      // Per-reason distinct symbols. NOT summed into the stage total — the
      // same symbol can appear under two reasons, so adding them would
      // overcount; the stage figure is computed separately below.
      distinctSymbols: Number(g.syms || 0),
      lastAt: g.last_at || null,
    })
  }

  // Distinct symbols PER STAGE, asked of the database rather than derived from
  // the per-reason numbers, which cannot be added without double-counting.
  try {
    for (const r of db.prepare(`
      SELECT stage, COUNT(DISTINCT symbol) AS syms
        FROM decision_log WHERE ${sql} GROUP BY stage`).all(...params)) {
      const s = byStage.get(String(r.stage || '(unstaged)'))
      if (s) s.distinctSymbols = Number(r.syms || 0)
    }
  } catch { /* same missing-table case as above */ }

  const stages = [...byStage.values()].map(s => {
    const ranked = s.reasonRows.sort((a, b) => b.count - a.count)
    return {
      stage: s.stage,
      count: s.count,
      distinctSymbols: s.distinctSymbols,
      lastAt: s.lastAt,
      decisions: s.decisions,
      reasons: ranked.slice(0, REASONS_PER_STAGE),
      moreReasons: Math.max(0, ranked.length - REASONS_PER_STAGE),
      // The read that separates "a few stuck setups retrying" from "a filter
      // rejecting the whole universe". Stated, not left to the eye.
      repeatRatio: s.distinctSymbols > 0 ? Math.round((s.count / s.distinctSymbols) * 10) / 10 : null,
    }
  }).sort((a, b) => b.count - a.count)

  return {
    windowHours,
    since,
    accountId: acct,
    // Present so the UI can name the account without a second call.
    activeAccountId: acct || getState(db, 'ctrader_account_id') || null,
    total,
    totals,
    unstamped,
    stages,
    rows,
    truncated: rows.length >= n,
  }
}
