// ---------------------------------------------------------------------------
// agent/services/perf-ledger.js — the Performance Ledger aggregation engine
// (design_claude handoff, PR B). Server-side so the page stays thin: one
// closed-trade ledger sliced three ways — time windows × market categories ×
// accounts — with carry-forward maths. Totals reconcile across lenses;
// nothing is double-counted (each trade appears once per lens).
//
// Anchors (design spec): the trading DAY rolls at 22:00 UTC (AU open); the
// broker WEEK anchors Sunday 22:00 UTC. Rolling windows (1H…12M) are
// now-relative. All comparisons run on epoch ms parsed from closed_at with
// the same space/'T' separator tolerance as the risk gate.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

// --- market categorization (6 design categories) ---------------------------
// Stocks (.US/.UK/.DE/.AU tickers) ride in 'index' — same session behaviour,
// and the design has no seventh column. Unknowns land in 'other' and are
// EXCLUDED from the six market cells but still count in window totals.
const CRYPTO = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|DOT|LINK|AVAX|TRX)[A-Z]{3,4}$/
const METAL = /^X(AU|AG|PT|PD)[A-Z]{3}$|^COPPER/
const ENERGY = /^(NATGAS|SPOTCRUDE|BRENT|UKOIL|USOIL|OIL|WTI)/
const GRAIN = /^(WHEAT|CORN|SOYBEAN|SUGAR|COFFEE|COCOA|COTTON|OATS|RICE)/
const INDEX = /^(US30|US500|NAS100|USTEC|US2000|GER40|UK100|FRA40|JPN225|AUS200|EUSTX|VIX|DOW|HK50|CHINA50|SPAIN35|ITALY40|SWISS20|NETH25)/

export function categorize(symbol) {
  const s = String(symbol || '').toUpperCase()
  if (CRYPTO.test(s)) return 'crypto'
  if (METAL.test(s)) return 'metal'
  if (ENERGY.test(s)) return 'energy'
  if (GRAIN.test(s)) return 'grain'
  if (INDEX.test(s) || /\.(US|UK|DE|AU)$/.test(s)) return 'index'
  if (/^[A-Z]{6}$/.test(s)) return 'fx'
  return 'other'
}

export const MARKETS = ['crypto', 'fx', 'index', 'metal', 'energy', 'grain']

// --- time anchors ----------------------------------------------------------
const H = 3600_000
const D = 24 * H

/** Most recent 22:00 UTC at or before `now` — the trading-day anchor. */
export function dayAnchor(nowMs) {
  const d = new Date(nowMs)
  const today22 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22)
  return nowMs >= today22 ? today22 : today22 - D
}

/** Most recent Sunday 22:00 UTC at or before `now` — the broker week open. */
export function weekAnchor(nowMs) {
  let a = dayAnchor(nowMs)
  // walk back to Sunday (getUTCDay() of the anchor instant: Sunday = 0)
  while (new Date(a).getUTCDay() !== 0) a -= D
  return a
}

/** The design's ledger windows, oldest-logic preserved: [from, to) in ms. */
export function ledgerWindows(nowMs = Date.now()) {
  const day0 = dayAnchor(nowMs)
  const monthStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1)
  const prevMonthStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth() - 1, 1)
  return [
    { key: '1h', label: '1H', from: nowMs - H, to: nowMs },
    { key: '4h', label: '4H', from: nowMs - 4 * H, to: nowMs },
    { key: '12h', label: '12H', from: nowMs - 12 * H, to: nowMs },
    { key: 'yesterday', label: 'Yesterday', from: day0 - D, to: day0 },
    { key: '3d', label: '3D', from: day0 - 3 * D, to: day0 }, // excludes today by design
    { key: 'wtd', label: 'WTD', from: weekAnchor(nowMs), to: nowMs },
    { key: '1w', label: '1W', from: nowMs - 7 * D, to: nowMs },
    { key: '2w', label: '2W', from: nowMs - 14 * D, to: nowMs },
    { key: '30d', label: '30D', from: nowMs - 30 * D, to: nowMs },
    { key: 'mtd', label: 'MTD', from: monthStart, to: nowMs },
    { key: 'lastmonth', label: 'Last month', from: prevMonthStart, to: monthStart },
    { key: '3m', label: '3M', from: nowMs - 91 * D, to: nowMs },
    { key: '6m', label: '6M', from: nowMs - 182 * D, to: nowMs },
    { key: '12m', label: '12M', from: nowMs - 365 * D, to: nowMs },
  ]
}

// --- trade shaping ---------------------------------------------------------
/** closed_at → epoch ms, tolerant of the space/'T' separator split. */
export function closedAtMs(row) {
  if (row.closed_at_ms != null && Number.isFinite(Number(row.closed_at_ms))) return Number(row.closed_at_ms)
  const raw = String(row.closed_at || '').replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z')
  return Number.isFinite(t) ? t : null
}

/** tp | part | sl | manual from close_reason + prices (heuristic, tested). */
export function classifyOutcome(row) {
  const r = String(row.close_reason || '').toLowerCase()
  if (/partial|scale/.test(r)) return 'part'
  const hasTp = /\btp\b|take.?profit|target|bank/.test(r)
  const hasSl = /\bsl\b|stop.?loss|stopped|stop hit/.test(r)
  // A reason naming BOTH (the generic broker-close string says "broker-side
  // SL/TP fill") is ambiguous — fall through to price proximity.
  if (hasTp && !hasSl) return 'tp'
  if (hasSl && !hasTp) return 'sl'
  if (r) {
    // broker-side close with prices available: infer by proximity
    const exit = Number(row.exit_price)
    if (Number.isFinite(exit)) {
      const near = (p) => Number.isFinite(Number(p)) && Math.abs(exit - p) <= Math.abs(exit) * 0.001
      if (near(row.tp_price)) return 'tp'
      if (near(row.sl_price)) return 'sl'
    }
    return 'manual'
  }
  return (row.net_pnl ?? 0) > 0 ? 'tp' : 'manual'
}

/** Planned R:R from entry/sl/tp when all present. */
export function plannedRr(row) {
  // Number(null) is 0 — a NULL stop must read as "no RR", not a 100-point one.
  const num = (v) => (v == null ? NaN : Number(v))
  const e = num(row.entry_price), s = num(row.sl_price), t = num(row.tp_price)
  if (![e, s, t].every(Number.isFinite) || Math.abs(e - s) === 0) return null
  return Math.abs(t - e) / Math.abs(e - s)
}

function emptyStats() {
  return { net: 0, gross_win: 0, gross_loss: 0, trades: 0, wins: 0, tp: 0, part: 0, sl: 0, manual: 0, rrSum: 0, rrN: 0 }
}
function foldTrade(st, tr) {
  st.net += tr.pnl
  st.trades++
  if (tr.pnl > 0) { st.wins++; st.gross_win += tr.pnl } else st.gross_loss += -tr.pnl
  st[tr.out]++
  if (tr.rr != null) { st.rrSum += tr.rr; st.rrN++ }
}
function finalizeStats(st) {
  const winPct = st.trades ? (st.wins / st.trades) * 100 : null
  const pf = st.gross_loss > 0 ? st.gross_win / st.gross_loss : (st.gross_win > 0 ? Infinity : null)
  const avgRr = st.rrN ? st.rrSum / st.rrN : null
  const requiredWinPct = avgRr != null ? 100 / (1 + avgRr) : null
  const round = (v, dp = 2) => (v == null ? null : (Number.isFinite(v) ? Number(v.toFixed(dp)) : null))
  return {
    net: round(st.net), trades: st.trades,
    winPct: round(winPct, 1),
    pf: pf === Infinity ? null : round(pf),
    tp: st.tp, part: st.part, sl: st.sl, manual: st.manual,
    avgRr: round(avgRr), requiredWinPct: round(requiredWinPct, 1),
    edge: winPct != null && requiredWinPct != null ? round(winPct - requiredWinPct, 1) : null,
  }
}

// --- the ledger ------------------------------------------------------------
/**
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|null, now?: number, balance?: number|null}} opts
 *   accountId null/'all' = every account (portfolio view). `balance` may be
 *   injected (tests); defaults to the account's stamped balance (or the
 *   global key) — the CARRY-FORWARD baseline: carryOut of a window ending
 *   now equals the current balance; earlier windows subtract the net that
 *   came after them.
 */
export function buildPerfLedger(db, { accountId = null, now = Date.now(), balance = null } = {}) {
  const acct = accountId && accountId !== 'all' ? String(accountId) : null
  const scope = acct == null ? { sql: '', params: [] }
    : { sql: 'AND (account_id = ? OR account_id IS NULL)', params: [acct] }

  const rows = db.prepare(
    `SELECT symbol, side, entry_price, sl_price, tp_price, net_pnl, closed_at, closed_at_ms,
            close_reason, exit_price, account_id, label_strategy, strategy
       FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL ${scope.sql}`
  ).all(...scope.params)

  const trades = rows.map(r => ({
    t: closedAtMs(r),
    pnl: Number(r.net_pnl) || 0,
    cat: categorize(r.symbol),
    sym: String(r.symbol || '').toUpperCase(),
    out: classifyOutcome(r),
    rr: plannedRr(r),
    acc: r.account_id != null ? String(r.account_id) : null,
    strat: r.label_strategy || r.strategy || null,
  })).filter(tr => tr.t != null)

  // Carry baseline: current balance for this scope. Injectable for tests.
  let bal = balance
  if (bal == null) {
    if (acct != null) {
      const scoped = Number(getState(db, `acct:${acct}:account_balance_usd`))
      bal = Number.isFinite(scoped) && scoped > 0 ? scoped : (Number(getState(db, 'account_balance_usd')) || null)
    } else {
      bal = Number(getState(db, 'account_balance_usd')) || null
    }
  }

  const windows = ledgerWindows(now).map(w => {
    const inWin = trades.filter(tr => tr.t >= w.from && tr.t < w.to)
    const netAfter = trades.filter(tr => tr.t >= w.to && tr.t < now + 1).reduce((n, tr) => n + tr.pnl, 0)
    const st = emptyStats()
    const perMarket = Object.fromEntries(MARKETS.map(m => [m, emptyStats()]))
    for (const tr of inWin) {
      foldTrade(st, tr)
      if (perMarket[tr.cat]) foldTrade(perMarket[tr.cat], tr)
    }
    const stats = finalizeStats(st)
    const carryOut = bal != null ? Number((bal - netAfter).toFixed(2)) : null
    const carryIn = carryOut != null ? Number((carryOut - st.net).toFixed(2)) : null
    return {
      key: w.key, label: w.label,
      from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(),
      carryIn, carryOut,
      ...stats,
      markets: Object.fromEntries(MARKETS.map(m => [m, finalizeStats(perMarket[m])])),
    }
  })

  return { generatedAt: new Date(now).toISOString(), accountId: acct ?? 'all', balance: bal, windows }
}
