// Account analytics — whole-period performance statistics, computed HERE
// over every qualifying trade.
//
// WHY THIS FILE EXISTS (performance/health audit 2026-08-02, findings 2.1
// and 2.2). The Performance page built its "All time" tiles — net P&L, win
// rate, expectancy, profit factor, payoff, streaks, max drawdown, best and
// worst day, hold statistics — from GET /state/trades, and that endpoint
// answers with `ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT 100`.
// Past 100 closed trades the tiles silently stopped being all-time: they
// described the most recent hundred and said "All time" above them. The
// owner is gating a live-trading decision on win rate > 68% and profit
// factor > 1.68, so a truncated denominator is not a display nit — it is
// the wrong number under the decision.
//
// The audit's second finding (2.2) says the same code path computes max
// drawdown backwards, because `pnls` came off that newest-first response
// and the drawdown loop ran before the page built its chronological array.
// The ORDER observation is correct; the CONSEQUENCE claimed for drawdown is
// not. Max drawdown is invariant under reversal: it is max(Sᵢ − Sⱼ) over
// i ≤ j on the cumulative path, and reversing maps Sᵢ ↦ total − S₍ₙ₋ᵢ₎,
// which sends every such pair to another pair with the same difference.
// Verified empirically over 20,000 random paths before this was written —
// forward and reversed always agree. So that loop was returning the right
// number for the wrong reason, and the page's streaks and day buckets were
// already reading from a sorted array.
//
// It is still wrong to depend on luck for a gate number, and the invariance
// does NOT extend to the order-sensitive figures the audit also lists —
// peak and trough DATES, recovery duration, time underwater, the equity
// curve itself. Everything path-dependent here is therefore computed only
// after an ascending sort on a canonical close timestamp, and the sort is
// asserted in the tests rather than assumed.
//
// The 100-row limit stays where it belongs — the visible trade journal.
import { closedAtMs } from '../shared/formulas.js'

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|null, days?: number|null, now?: number}} opts
 *   days: rolling window ending now; null/0 = every closed trade on record.
 * @returns {object} whole-period statistics (nulls where undefined, never 0)
 */
export function accountAnalytics(db, { accountId = null, days = null, now = Date.now() } = {}) {
  const acct = accountId && accountId !== 'all' ? String(accountId) : null
  // NULL account_id rows predate per-account stamping — they belong to
  // whichever account is asking, the same convention accountWhere() uses.
  const scope = acct == null
    ? { sql: '', params: [] }
    : { sql: 'AND (account_id = ? OR account_id IS NULL)', params: [acct] }

  const rows = db.prepare(
    `SELECT net_pnl, closed_at, closed_at_ms, opened_at, hold_duration_ms, account_id
       FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL ${scope.sql}`
  ).all(...scope.params)

  // Canonical millisecond close stamp, ASCENDING. Every path-dependent
  // figure below depends on this order being real chronology.
  const cutoff = days && days > 0 ? now - days * 86_400_000 : null
  const chron = rows
    .map(r => ({
      ms: closedAtMs(r),
      pnl: Number(r.net_pnl) || 0,
      hold: r.hold_duration_ms != null && Number.isFinite(Number(r.hold_duration_ms))
        ? Number(r.hold_duration_ms)
        : null,
    }))
    .filter(t => t.ms != null && (cutoff == null || t.ms >= cutoff))
    .sort((a, b) => a.ms - b.ms)

  const n = chron.length
  if (n === 0) {
    return {
      trades: 0, windowDays: days || null, accountId: acct,
      net: null, winRate: null, expectancy: null, profitFactor: null,
      payoff: null, avgWin: null, avgLoss: null, grossWin: 0, grossLoss: 0,
      wins: 0, losses: 0, maxDrawdown: null, bestTrade: null, worstTrade: null,
      bestDay: null, worstDay: null, greenDays: 0, tradingDays: 0,
      winStreak: 0, lossStreak: 0, medianHoldMin: null,
      firstMs: null, lastMs: null, truncated: false,
    }
  }

  const pnls = chron.map(t => t.pnl)
  // A scratch (exactly 0.00) counts as a loss — it consumed a slot and
  // returned nothing. Stated because win rate is a gate number here.
  const wins = pnls.filter(v => v > 0)
  const losses = pnls.filter(v => v <= 0)
  const net = pnls.reduce((s, v) => s + v, 0)
  const grossWin = wins.reduce((s, v) => s + v, 0)
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0))
  const avgWin = wins.length ? grossWin / wins.length : null
  const avgLoss = losses.length ? grossLoss / losses.length : null

  // Max drawdown over the CHRONOLOGICAL closed-trade equity path.
  let peak = 0, equity = 0, mdd = 0
  for (const v of pnls) {
    equity += v
    if (equity > peak) peak = equity
    const fall = peak - equity
    if (fall > mdd) mdd = fall
  }

  let winStreak = 0, lossStreak = 0, curW = 0, curL = 0
  for (const t of chron) {
    if (t.pnl > 0) { curW++; curL = 0 } else { curL++; curW = 0 }
    if (curW > winStreak) winStreak = curW
    if (curL > lossStreak) lossStreak = curL
  }

  const byDay = new Map()
  for (const t of chron) {
    const k = new Date(t.ms).toISOString().slice(0, 10)
    byDay.set(k, (byDay.get(k) || 0) + t.pnl)
  }
  const dayNets = [...byDay.values()]

  const holds = chron.map(t => t.hold).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const medianHoldMs = holds.length
    ? (holds.length % 2
        ? holds[(holds.length - 1) / 2]
        : (holds[holds.length / 2 - 1] + holds[holds.length / 2]) / 2)
    : null

  return {
    trades: n,
    windowDays: days || null,
    accountId: acct,
    net: round2(net),
    wins: wins.length,
    losses: losses.length,
    winRate: round2((wins.length / n) * 100),
    // Expectancy: what one more trade is worth on this record.
    expectancy: round2(net / n),
    // Profit factor: null (not Infinity, not 0) when there is no loss to
    // divide by — "undefined" is the honest answer with a clean record.
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    payoff: avgWin != null && avgLoss ? round2(avgWin / avgLoss) : null,
    avgWin: avgWin != null ? round2(avgWin) : null,
    avgLoss: avgLoss != null ? round2(avgLoss) : null,
    grossWin: round2(grossWin),
    grossLoss: round2(grossLoss),
    maxDrawdown: round2(mdd),
    bestTrade: round2(Math.max(...pnls)),
    worstTrade: round2(Math.min(...pnls)),
    bestDay: round2(Math.max(...dayNets)),
    worstDay: round2(Math.min(...dayNets)),
    greenDays: dayNets.filter(v => v > 0).length,
    tradingDays: byDay.size,
    winStreak,
    lossStreak,
    medianHoldMin: medianHoldMs != null ? Math.round(medianHoldMs / 60_000) : null,
    firstMs: chron[0].ms,
    lastMs: chron[n - 1].ms,
    // Explicitly false: this figure covers the whole window, not a page of
    // it. The UI says so, so a future regression to a LIMIT is visible.
    truncated: false,
  }
}

function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}
