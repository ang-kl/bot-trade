// ---------------------------------------------------------------------------
// agent/services/divergence.js — backtest→live divergence per armed combo.
//
// Owner "plan #1" (02-09-2026), from the question "could my prediction and
// actual be closer?". The day-one answer was a MECHANISM gap, not a model gap:
// donchian_breakout went 1W/4L on combos no backtest verdict had ever judged,
// because a strategy-level arm under autotrade_scope 'all' unlocked every
// symbol×timeframe. So this report answers three things, all measured:
//
//   1. Per ARMED combo: the evidence it was armed on (combo_arms snapshot)
//      vs its live closes since — PF/WR/expectancy deltas, plus execution
//      cost (slippage in R, spread as a fraction of the stop) so a
//      "diverging" verdict can say whether the gap is statistical or paid
//      at the fill.
//   2. Every live trade classified by EVIDENCE LEVEL — combo (the exact
//      strategy×symbol×timeframe was armed on a verdict), symbol_tf (the
//      matrix row was armed by a DIFFERENT strategy — the matrix is
//      strategy-blind), strategy_only, none — with P&L per level.
//   3. Backtest OPTIMISM: mean(backtest WR − live WR) and mean(PF − PF) over
//      combos with enough live closes — the calibration number for the arm
//      bar. Reported, never auto-applied.
//
// Measurement only. No actuator reads this; the edge watchdog already owns
// live-decay disarms, and a second actuator on one signal is the
// two-evaluator hole this repo has already paid for twice.
// ---------------------------------------------------------------------------

import { strategyAttrSql } from '../lib/strategy-attribution.js'

export const DIVERGENCE_DEFAULTS = Object.freeze({ days: 30, minLive: 10, wrGapPts: 15 })

// ---------------------------------------------------------------------------
// Per-sweep histogram (owner order, 02-09-2026). persistVerdictHistory keeps
// only bar-clearing or armed verdicts, so nothing on record said what the
// WHOLE sweep looked like — the base rate a shrinkage prior needs. One row
// per sweep, fixed bins, written from ALL verdicts. Measurement only: no
// shrinkage is computed here.
// ---------------------------------------------------------------------------

/** Fixed bin edges; a bin is [lo, hi) with the last open-ended. Labels are for readers. */
export const SWEEP_HIST_BINS = Object.freeze({
  pf: Object.freeze({ edges: [0.8, 1.0, 1.1, 1.3, 1.5, 2.0], labels: ['<0.8', '0.8–1.0', '1.0–1.1', '1.1–1.3', '1.3–1.5', '1.5–2.0', '≥2.0'] }),
  wr: Object.freeze({ edges: [40, 50, 55, 60, 70], labels: ['<40', '40–50', '50–55', '55–60', '60–70', '≥70'] }),
  n: Object.freeze({ edges: [10, 20, 30], labels: ['<10', '10–20', '20–30', '≥30'] }),
})

/** Index of the bin `x` falls in: the count of edges ≤ x. */
export function sweepBinIndex(edges, x) {
  let i = 0
  while (i < edges.length && x >= edges[i]) i++
  return i
}

/**
 * Bin every verdict of one sweep. Verdicts with no finite PF (no losses —
 * ∞ — or no trades) are left out of the PF bins rather than forced into
 * one; win rate and n bin every verdict that carries a number.
 */
export function sweepHistogramOf(verdicts) {
  const zeros = (b) => new Array(b.edges.length + 1).fill(0)
  const pf = zeros(SWEEP_HIST_BINS.pf), wr = zeros(SWEEP_HIST_BINS.wr), n = zeros(SWEEP_HIST_BINS.n)
  const list = Array.isArray(verdicts) ? verdicts : []
  for (const v of list) {
    if (Number.isFinite(v?.pf)) pf[sweepBinIndex(SWEEP_HIST_BINS.pf.edges, Number(v.pf))]++
    if (Number.isFinite(v?.winRate)) wr[sweepBinIndex(SWEEP_HIST_BINS.wr.edges, Number(v.winRate))]++
    if (Number.isFinite(v?.trades)) n[sweepBinIndex(SWEEP_HIST_BINS.n.edges, Number(v.trades))]++
  }
  return { combos: list.length, pf, wr, n }
}

/** Write one histogram row for a sweep. Returns the row id, or null on an empty sweep. */
export function persistSweepHistogram(db, verdicts, { at = null } = {}) {
  const h = sweepHistogramOf(verdicts)
  if (h.combos === 0) return null
  const r = db.prepare(
    `INSERT INTO autopilot_sweep_hist (sweep_at, combos, pf_bins, wr_bins, n_bins)
     VALUES (COALESCE(?, datetime('now')), ?, ?, ?, ?)`
  ).run(at, h.combos, JSON.stringify(h.pf), JSON.stringify(h.wr), JSON.stringify(h.n))
  return Number(r.lastInsertRowid)
}

/** The newest sweep's histogram with its bin labels, or null when no sweep has been recorded. */
export function latestSweepHistogram(db) {
  let row = null
  try { row = db.prepare('SELECT * FROM autopilot_sweep_hist ORDER BY id DESC LIMIT 1').get() } catch { return null }
  if (!row) return null
  const parse = (s) => { try { return JSON.parse(s) } catch { return null } }
  return {
    sweepAt: row.sweep_at,
    combos: row.combos,
    pf: { labels: [...SWEEP_HIST_BINS.pf.labels], counts: parse(row.pf_bins) },
    winRate: { labels: [...SWEEP_HIST_BINS.wr.labels], counts: parse(row.wr_bins) },
    trades: { labels: [...SWEEP_HIST_BINS.n.labels], counts: parse(row.n_bins) },
  }
}

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)
const num = (v) => (v == null || v === '' ? NaN : Number(v))
const ms = (s) => {
  if (s == null || s === '') return NaN
  const t = String(s).replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t + 'Z')
}

/** Live edge over trade rows that carry net_pnl and (optionally) an R figure. */
export function liveEdgeOf(rows) {
  const rs = (Array.isArray(rows) ? rows : []).filter(r => Number.isFinite(num(r?.net_pnl)))
  if (!rs.length) {
    return { trades: 0, wins: 0, winRatePct: null, profitFactor: null, netPnl: 0, expectancyR: null, rSample: 0 }
  }
  const pnls = rs.map(r => num(r.net_pnl))
  const wins = pnls.filter(p => p > 0)
  const grossWin = wins.reduce((s, p) => s + p, 0)
  const grossLoss = pnls.filter(p => p < 0).reduce((s, p) => s - p, 0)
  const rVals = rs.map(r => num(r.r)).filter(Number.isFinite)
  return {
    trades: rs.length,
    wins: wins.length,
    winRatePct: r2((wins.length / rs.length) * 100),
    // No losses is an unrepresentative sample, not an infinite edge — null.
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    netPnl: r2(pnls.reduce((s, p) => s + p, 0)),
    expectancyR: rVals.length ? r2(rVals.reduce((s, v) => s + v, 0) / rVals.length) : null,
    rSample: rVals.length,
  }
}

/** Execution cost per combo: mean slippage in R and mean spread as a fraction of the stop. */
export function executionCostOf(rows) {
  const slip = [], spread = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const risk = num(r?.riskDist)
    if (!(risk > 0)) continue
    const s = num(r?.slippage_price)
    if (Number.isFinite(s)) slip.push(s / risk)
    const sp = num(r?.spread_at_entry)
    if (Number.isFinite(sp)) spread.push(sp / risk)
  }
  const mean = (a) => (a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null)
  return { slippageR: mean(slip), spreadFracSl: mean(spread), sample: Math.max(slip.length, spread.length) }
}

/**
 * Which arms were in force when a trade opened, and what evidence level that
 * gives it. Pure; `arms` are combo_arms rows.
 */
export function evidenceLevelOf(trade, arms) {
  const t = ms(trade?.opened_at)
  const active = (Array.isArray(arms) ? arms : []).filter(a => {
    const from = ms(a.armed_at), to = ms(a.disarmed_at)
    return Number.isFinite(from) && from <= t && (!Number.isFinite(to) || to >= t)
  })
  const strat = trade?.strat ?? null
  const sym = String(trade?.symbol || '').toUpperCase()
  const tf = trade?.label_timeframe ?? null
  const comboKinds = new Set(['matrix', 'pending'])
  if (active.some(a => comboKinds.has(a.kind) && a.strategy === strat && String(a.symbol || '').toUpperCase() === sym && a.timeframe === tf)) return 'combo'
  if (active.some(a => comboKinds.has(a.kind) && String(a.symbol || '').toUpperCase() === sym && a.timeframe === tf)) return 'symbol_tf'
  if (active.some(a => (a.kind === 'strategy' || a.kind === 'manual') && a.strategy === strat)) return 'strategy_only'
  return 'none'
}

export function statusOf(bt, live, { minLive, wrGapPts }) {
  if ((live?.trades ?? 0) < minLive) return 'insufficient'
  if (live.profitFactor != null && live.profitFactor < 1) return 'diverging'
  if (bt?.winRatePct != null && live.winRatePct != null && live.winRatePct < bt.winRatePct - wrGapPts) return 'diverging'
  return 'holding'
}

/**
 * The report. Every read is here; the shaping helpers above are pure.
 * Bot-dispatched closes only (`source = 'autotrade'`); rows flagged by the
 * consistency audit are counted but excluded from every statistic.
 */
export function divergenceReport(db, opts = {}) {
  const cfg = { ...DIVERGENCE_DEFAULTS, ...opts }
  const cutoff = new Date(Date.now() - cfg.days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  let arms = []
  let trades = []
  try {
    arms = db.prepare(
      `SELECT * FROM combo_arms
        WHERE disarmed_at IS NULL OR datetime(disarmed_at) >= datetime(?)
        ORDER BY id`
    ).all(cutoff)
    trades = db.prepare(
      `SELECT t.id, t.symbol, t.side, t.opened_at, t.closed_at, t.net_pnl, t.realised_rr,
              t.entry_price, t.exit_price, COALESCE(t.broker_sl_initial, t.sl_price) AS sl_price,
              t.slippage_price, t.spread_at_entry,
              t.label_timeframe, t.pnl_price_mismatch, t.exit_price_suspect, t.account_id,
              ${strategyAttrSql('t.label_strategy', 't.strategy')} AS strat,
              (SELECT initial_risk FROM monitored_positions WHERE trade_id = t.id ORDER BY id DESC LIMIT 1) AS initial_risk
         FROM trades t
        WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL
          AND (t.origin = 'bot_market_dispatch' OR t.source IN ('autotrade', 'autopilot'))
          AND REPLACE(COALESCE(t.closed_at, ''), 'T', ' ') >= ?`
    ).all(cutoff)
  } catch { /* first boot: tables absent — empty report stands */ }
  // Bot-dispatched only. Measured 02-09-2026 on the first production read:
  // the dispatch writes source 'autotrade', then the label pass restamps it
  // 'autopilot' — a filter on 'autotrade' alone counted ZERO of 12 bot
  // closes. `origin` is the dispatch's own stamp and the honest key; the
  // source list covers rows from before origin existed.

  for (const t of trades) {
    const e = num(t.entry_price), s = num(t.sl_price), ir = num(t.initial_risk)
    t.riskDist = Number.isFinite(e) && Number.isFinite(s) && Math.abs(e - s) > 0 ? Math.abs(e - s) : (ir > 0 ? ir : null)
    // realised_rr is NULL on most broker-side closes (10 of 12 measured
    // 02-09) — the close path stamps it only when it has an exit price in
    // hand, and the later P&L repair does not always re-stamp. Derive it
    // from the prices when they are present, same arithmetic as
    // trade-consistency.js realisedRR; null stays null.
    const x = num(t.exit_price)
    const move = Number.isFinite(e) && Number.isFinite(x) ? (String(t.side || '').toUpperCase() === 'SELL' ? e - x : x - e) : NaN
    t.r = Number.isFinite(num(t.realised_rr)) ? num(t.realised_rr)
      : (Number.isFinite(move) && t.riskDist > 0 ? r2(move / t.riskDist) : null)
    t.flagged = t.pnl_price_mismatch === 1 || t.exit_price_suspect === 1
    t.symbolU = String(t.symbol || '').toUpperCase()
  }
  const clean = trades.filter(t => !t.flagged)

  // 1. Per armed combo.
  const combos = []
  for (const a of arms) {
    if (!(a.kind === 'matrix' || a.kind === 'pending') || !a.strategy) continue
    const from = ms(a.armed_at), to = ms(a.disarmed_at)
    const live = clean.filter(t => t.strat === a.strategy && t.symbolU === String(a.symbol || '').toUpperCase()
      && t.label_timeframe === a.timeframe
      && ms(t.opened_at) >= from && (!Number.isFinite(to) || ms(t.opened_at) <= to))
    const bt = {
      profitFactor: a.bt_pf ?? null, winRatePct: a.bt_win_rate_pct ?? null, trades: a.bt_trades ?? null,
      wf: a.bt_wf_active != null ? `${a.bt_wf_positive ?? 0}/${a.bt_wf_active}` : null,
    }
    const edge = liveEdgeOf(live)
    combos.push({
      strategy: a.strategy, symbol: a.symbol, timeframe: a.timeframe, kind: a.kind,
      armedAt: a.armed_at, disarmedAt: a.disarmed_at ?? null, disarmReason: a.disarm_reason ?? null,
      bar: { minPf: a.bar_min_pf, minWin: a.bar_min_win, minTrades: a.bar_min_trades },
      backtest: bt,
      live: edge,
      delta: {
        profitFactor: bt.profitFactor != null && edge.profitFactor != null ? r2(edge.profitFactor - bt.profitFactor) : null,
        winRatePct: bt.winRatePct != null && edge.winRatePct != null ? r2(edge.winRatePct - bt.winRatePct) : null,
      },
      execution: executionCostOf(live),
      status: statusOf(bt, edge, cfg),
    })
  }
  const order = { diverging: 0, holding: 1, insufficient: 2 }
  combos.sort((x, y) => (order[x.status] - order[y.status]) || (y.live.trades - x.live.trades))

  // 2. Evidence level of every live trade in the window.
  const levels = { combo: [], symbol_tf: [], strategy_only: [], none: [] }
  for (const t of clean) levels[evidenceLevelOf(t, arms)].push(t)
  const evidenceLevels = Object.fromEntries(Object.entries(levels).map(([k, rows]) => [k, liveEdgeOf(rows)]))

  // 3. Optimism, over combos with a measurable live sample and real evidence.
  const measured = combos.filter(c => c.live.trades >= cfg.minLive && c.backtest.winRatePct != null)
  const mean = (a) => (a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null)
  // POOLED (owner plan, 02-09-2026). The per-combo figure needs minLive
  // closes on EACH combo, months away at the observed rate. Pooling every
  // combo that has backtest evidence and at least one live close — live
  // wins over live trades against the trade-weighted backtest WR — gives a
  // single calibration number that reaches ±5 pts at roughly 100–200 closes
  // across the book, and the same per strategy.
  const pooledOf = (rows) => {
    const withBt = rows.filter(c => c.backtest.winRatePct != null && c.live.trades > 0)
    const trades = withBt.reduce((s, c) => s + c.live.trades, 0)
    if (!trades) return { combos: withBt.length, trades: 0, winRatePts: null, profitFactor: null }
    const wins = withBt.reduce((s, c) => s + c.live.wins, 0)
    const btWr = withBt.reduce((s, c) => s + c.backtest.winRatePct * c.live.trades, 0) / trades
    const pfRows = withBt.filter(c => c.backtest.profitFactor != null && c.live.profitFactor != null)
    const pfTrades = pfRows.reduce((s, c) => s + c.live.trades, 0)
    return {
      combos: withBt.length, trades,
      winRatePts: r2(btWr - (wins / trades) * 100),
      profitFactor: pfTrades ? r2(pfRows.reduce((s, c) => s + (c.backtest.profitFactor - c.live.profitFactor) * c.live.trades, 0) / pfTrades) : null,
    }
  }
  const byStrategy = {}
  for (const c of combos) (byStrategy[c.strategy] ||= []).push(c)
  const optimism = {
    combos: measured.length,
    winRatePts: mean(measured.map(c => c.backtest.winRatePct - (c.live.winRatePct ?? 0))),
    profitFactor: mean(measured.filter(c => c.backtest.profitFactor != null && c.live.profitFactor != null)
      .map(c => c.backtest.profitFactor - c.live.profitFactor)),
    pooled: pooledOf(combos),
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, rows]) => [k, pooledOf(rows)])),
  }

  return {
    window: { days: cfg.days, since: cutoff, minLive: cfg.minLive, wrGapPts: cfg.wrGapPts },
    combos,
    // 'unevidenced' rows are live pairs the boot reconcile found with no
    // verdict on record (owner, 02-09-2026: "record them with no evidence").
    // They are listed so the report's arm set matches the live matrix, and
    // evidenceLevelOf ignores them, so a trade on one still reads `none`.
    unevidencedArms: arms.filter(a => a.kind === 'strategy' || a.kind === 'manual' || a.kind === 'unevidenced')
      .map(a => ({
        kind: a.kind, strategy: a.strategy, symbol: a.symbol ?? null, timeframe: a.timeframe ?? null,
        armedAt: a.armed_at, disarmedAt: a.disarmed_at ?? null,
      })),
    evidenceLevels,
    optimism,
    integrity: { closes: trades.length, flaggedExcluded: trades.length - clean.length },
    // Last sweep's PF/WR/n histogram over ALL verdicts — the base rate for a
    // shrinkage prior computed later. null until the first sweep after this
    // shipped; the prior is not computed here.
    histogram: latestSweepHistogram(db),
  }
}
