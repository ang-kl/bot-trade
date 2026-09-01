// node --test agent/services/divergence.test.js
//
// Backtest→live divergence tracker (owner "plan #1", 02-09-2026). The pure
// helpers are pinned directly; the report is run over seeded combo_arms +
// trades rows so the joins are exercised where they matter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import {
  divergenceReport, liveEdgeOf, executionCostOf, evidenceLevelOf, statusOf, DIVERGENCE_DEFAULTS,
} from './divergence.js'

const T0 = '2026-09-01 10:00:00'
const later = (min) => new Date(Date.parse('2026-09-01T10:00:00Z') + min * 60_000).toISOString().slice(0, 19).replace('T', ' ')

function arm(db, row) {
  db.prepare(`INSERT INTO combo_arms (armed_at, kind, strategy, symbol, timeframe, entry_mode,
      bt_pf, bt_win_rate_pct, bt_trades, bt_wf_positive, bt_wf_active, bar_min_pf, bar_min_win, bar_min_trades, disarmed_at)
     VALUES (@armed_at, @kind, @strategy, @symbol, @timeframe, @entry_mode, @bt_pf, @bt_win, @bt_trades, @wfp, @wfa, @bpf, @bwin, @bn, @disarmed_at)`)
    .run({ armed_at: T0, kind: 'matrix', strategy: null, symbol: null, timeframe: null, entry_mode: 'close', bt_pf: null, bt_win: null, bt_trades: null, wfp: null, wfa: null, bpf: 1.5, bwin: 55, bn: 20, disarmed_at: null, ...row })
}

function trade(db, { symbol, strategy, tf, net, r = null, openedMin = 5, flagged = 0, source = 'autotrade', slip = null, spread = null }) {
  db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, realised_rr, entry_price, sl_price, opened_at, closed_at,
      label_strategy, label_timeframe, source, pnl_price_mismatch, slippage_price, spread_at_entry)
     VALUES (?, 'BUY', 'closed', ?, ?, 100, 99, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(symbol, net, r, later(openedMin), later(openedMin + 30), strategy, tf, source, flagged, slip, spread)
}

test('liveEdgeOf: PF null when no losses; expectancyR only over rows carrying R', () => {
  const e = liveEdgeOf([{ net_pnl: 10, r: 1 }, { net_pnl: -5, r: -0.5 }, { net_pnl: 20 }])
  assert.equal(e.trades, 3)
  assert.equal(e.winRatePct, 66.67)
  assert.equal(e.profitFactor, 6)
  assert.equal(e.expectancyR, 0.25)
  assert.equal(e.rSample, 2)
  assert.equal(liveEdgeOf([{ net_pnl: 5 }]).profitFactor, null, 'no losses is not an infinite edge')
})

test('executionCostOf: slippage and spread in units of the stop distance', () => {
  const c = executionCostOf([{ riskDist: 1, slippage_price: 0.2, spread_at_entry: 0.05 }, { riskDist: 2, slippage_price: 0.2, spread_at_entry: 0.1 }])
  assert.equal(c.slippageR, 0.15)
  assert.equal(c.spreadFracSl, 0.05)
  assert.equal(executionCostOf([{ riskDist: 0, slippage_price: 1 }]).sample, 0, 'no stop distance → no ratio')
})

test('statusOf: insufficient below minLive; diverging on PF<1 or WR gap; holding otherwise', () => {
  const cfg = { minLive: 10, wrGapPts: 15 }
  assert.equal(statusOf({ winRatePct: 60 }, { trades: 9, profitFactor: 0.5, winRatePct: 10 }, cfg), 'insufficient')
  assert.equal(statusOf({ winRatePct: 60 }, { trades: 10, profitFactor: 0.9, winRatePct: 60 }, cfg), 'diverging')
  assert.equal(statusOf({ winRatePct: 60 }, { trades: 10, profitFactor: 1.4, winRatePct: 44 }, cfg), 'diverging')
  assert.equal(statusOf({ winRatePct: 60 }, { trades: 10, profitFactor: 1.4, winRatePct: 50 }, cfg), 'holding')
})

test('evidenceLevelOf: exact combo > strategy-blind matrix row > strategy-level > none, judged at OPEN time', () => {
  const arms = [
    { kind: 'matrix', strategy: 'donchian_breakout', symbol: 'GER40', timeframe: '15m', armed_at: T0, disarmed_at: null },
    { kind: 'strategy', strategy: 'rsi2_reversion', symbol: null, timeframe: null, armed_at: T0, disarmed_at: later(60) },
  ]
  const at = (m) => later(m)
  assert.equal(evidenceLevelOf({ strat: 'donchian_breakout', symbol: 'GER40', label_timeframe: '15m', opened_at: at(5) }, arms), 'combo')
  assert.equal(evidenceLevelOf({ strat: 'vwap_trend', symbol: 'ger40', label_timeframe: '15m', opened_at: at(5) }, arms), 'symbol_tf')
  assert.equal(evidenceLevelOf({ strat: 'rsi2_reversion', symbol: 'EURUSD', label_timeframe: '1h', opened_at: at(5) }, arms), 'strategy_only')
  assert.equal(evidenceLevelOf({ strat: 'rsi2_reversion', symbol: 'EURUSD', label_timeframe: '1h', opened_at: at(120) }, arms), 'none', 'a disarmed strategy gives no evidence after its disarm')
  assert.equal(evidenceLevelOf({ strat: 'donchian_breakout', symbol: 'GER40', label_timeframe: '15m', opened_at: '2026-09-01 09:00:00' }, arms), 'none', 'before the arm there was no evidence')
})

test('divergenceReport joins arm evidence to live closes, buckets evidence levels, excludes flagged rows', () => {
  const db = initDB(':memory:')
  arm(db, { kind: 'matrix', strategy: 'donchian_breakout', symbol: 'GER40', timeframe: '15m', bt_pf: 1.6, bt_win: 58, bt_trades: 22, wfp: 3, wfa: 4 })
  arm(db, { kind: 'strategy', strategy: 'rsi2_reversion' })
  arm(db, { kind: 'manual', strategy: 'vp_value' })
  // 12 combo trades, 7 wins, all carrying R
  for (let i = 0; i < 12; i++) trade(db, { symbol: 'GER40', strategy: 'donchian_breakout', tf: '15m', net: i < 7 ? 30 : -20, r: i < 7 ? 1.5 : -1, openedMin: 5 + i, slip: 0.1, spread: 0.05 })
  // a donchian trade on an UN-armed timeframe → strategy_only? no: no strategy-level donchian arm → none
  trade(db, { symbol: 'GER40', strategy: 'donchian_breakout', tf: '1h', net: -50, openedMin: 40 })
  // rsi2 anywhere → strategy_only
  trade(db, { symbol: 'EURUSD', strategy: 'rsi2_reversion', tf: '1h', net: 12, openedMin: 41 })
  // vwap on the armed GER40 15m row → symbol_tf (matrix is strategy-blind)
  trade(db, { symbol: 'GER40', strategy: 'vwap_trend', tf: '15m', net: 8, openedMin: 42 })
  // flagged: counted, excluded from every statistic
  trade(db, { symbol: 'GER40', strategy: 'donchian_breakout', tf: '15m', net: 999, openedMin: 43, flagged: 1 })
  // not bot-dispatched: ignored entirely
  trade(db, { symbol: 'GER40', strategy: 'donchian_breakout', tf: '15m', net: 999, openedMin: 44, source: 'external' })
  // production stamps bot trades source 'autopilot' (label pass) — must count
  trade(db, { symbol: 'GER40', strategy: 'donchian_breakout', tf: '15m', net: -20, r: -1, openedMin: 45, source: 'autopilot' })

  const r = divergenceReport(db, { days: 30 })
  assert.equal(r.combos.length, 1)
  const c = r.combos[0]
  assert.equal(c.strategy, 'donchian_breakout')
  assert.equal(c.backtest.profitFactor, 1.6)
  assert.equal(c.backtest.wf, '3/4')
  assert.equal(c.live.trades, 13, 'flagged and non-bot rows must not join the combo; source autopilot must')
  assert.equal(c.live.winRatePct, 53.85)
  assert.equal(c.live.expectancyR, r2(((7 * 1.5) + (6 * -1)) / 13))
  assert.equal(c.delta.winRatePct, r2(53.85 - 58))
  assert.equal(c.execution.slippageR, 0.1)
  assert.equal(c.status, 'holding')
  assert.deepEqual(r.unevidencedArms.map(a => a.kind).sort(), ['manual', 'strategy'])
  assert.equal(r.evidenceLevels.combo.trades, 13)
  assert.equal(r.evidenceLevels.symbol_tf.trades, 1)
  assert.equal(r.evidenceLevels.strategy_only.trades, 1)
  assert.equal(r.evidenceLevels.none.trades, 1)
  assert.equal(r.integrity.flaggedExcluded, 1)
  assert.equal(r.optimism.combos, 1)
  assert.equal(r.optimism.winRatePts, r2(58 - 53.85))
})

test('divergenceReport: insufficient below minLive; empty DB yields an empty, well-shaped report', () => {
  const db = initDB(':memory:')
  const empty = divergenceReport(db)
  assert.deepEqual(empty.combos, [])
  assert.equal(empty.optimism.combos, 0)
  assert.equal(empty.window.minLive, DIVERGENCE_DEFAULTS.minLive)
  arm(db, { kind: 'matrix', strategy: 'ema_pullback', symbol: 'COTTON', timeframe: '1h', bt_pf: 1.7, bt_win: 60, bt_trades: 25 })
  for (let i = 0; i < 3; i++) trade(db, { symbol: 'COTTON', strategy: 'ema_pullback', tf: '1h', net: -10, openedMin: 5 + i })
  const r = divergenceReport(db)
  assert.equal(r.combos[0].status, 'insufficient')
  assert.equal(r.optimism.combos, 0, 'an insufficient combo never feeds the optimism aggregate')
})

// Wiring pins — a report nothing serves, or a prune nothing runs, is failure mode #4.
test('wiring: route declared once, housekeeping prunes both tables, applyChanges snapshots arms', () => {
  const state = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8')
  assert.equal((state.match(/router\.get\('\/divergence'/g) || []).length, 1)
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.ok(loop.includes("'prune-autopilot-verdicts'") && loop.includes("'prune-combo-arms'"))
  const ap = readFileSync(new URL('./strategy-autopilot.js', import.meta.url), 'utf8')
  assert.ok(ap.includes('recordComboArms(db, changes, opts)'), 'applyChanges must snapshot arms')
  assert.ok(ap.includes('persistVerdictHistory(db, verdicts, current, armBar)'), 'every sweep must persist its verdict history')
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.ok(actions.includes("kind: 'manual'"), 'a hand-arm must be recorded as evidence-less')
})

function r2(x) { return Math.round(x * 100) / 100 }
