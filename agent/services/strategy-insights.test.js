// node --test agent/services/strategy-insights.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { strategyInsights } from './strategy-insights.js'

function mkDb() { return initDB(':memory:') }

function insertClosed(db, { strategy = 'fib_618_fade', pnl, entry = 100, sl = 98, tp = 106, status = 'closed' }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, status, net_pnl, opened_at, closed_at, label_strategy)
     VALUES ('EURUSD', 'BUY', ?, ?, ?, 0.1, ?, ?, datetime('now'), datetime('now'), ?)`
  ).run(entry, sl, tp, status, pnl, strategy)
}

test('groups by strategy with win/loss counts and win rate', () => {
  const db = mkDb()
  insertClosed(db, { strategy: 'fib_618_fade', pnl: 50 })
  insertClosed(db, { strategy: 'fib_618_fade', pnl: -30 })
  insertClosed(db, { strategy: 'fib_618_fade', pnl: -20 })
  insertClosed(db, { strategy: 'vwap_trend', pnl: 10 })
  const out = strategyInsights(db)
  const fib = out.find(r => r.strategy === 'fib_618_fade')
  assert.equal(fib.trades, 3)
  assert.equal(fib.wins, 1)
  assert.equal(fib.losses, 2)
  assert.equal(fib.winRatePct, 33.3)
  assert.equal(fib.netPnl, 0)
  const vwap = out.find(r => r.strategy === 'vwap_trend')
  assert.equal(vwap.winRatePct, 100)
})

test('planned R:R and break-even win rate come from the trades own levels', () => {
  const db = mkDb()
  // entry 100, SL 98 (risk 2), TP 106 (reward 6) -> RR 3, breakeven 25%
  insertClosed(db, { strategy: 'ema_pullback', pnl: -10, entry: 100, sl: 98, tp: 106 })
  insertClosed(db, { strategy: 'ema_pullback', pnl: -10, entry: 100, sl: 98, tp: 106 })
  const [row] = strategyInsights(db)
  assert.equal(row.plannedRR, 3)
  assert.equal(row.breakevenWinRatePct, 25)
  // 0% actual vs 25% required -> edge -25
  assert.equal(row.winRatePct, 0)
  assert.equal(row.edgePct, -25)
})

test('rejected (duplicate-repair) rows are excluded from every figure', () => {
  const db = mkDb()
  insertClosed(db, { strategy: 'fib_618_fade', pnl: -487.76 })
  insertClosed(db, { strategy: 'fib_618_fade', pnl: -487.76, status: 'rejected' })
  insertClosed(db, { strategy: 'fib_618_fade', pnl: -487.76, status: 'rejected' })
  const [row] = strategyInsights(db)
  assert.equal(row.trades, 1)
  assert.equal(row.netPnl, -487.76)
})

test('unlabelled trades bucket as manual / external', () => {
  const db = mkDb()
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, status, net_pnl, opened_at, closed_at)
     VALUES ('USDIDR', 'BUY', 17947, 0.76, 'closed', -487.76, datetime('now'), datetime('now'))`
  ).run()
  const [row] = strategyInsights(db)
  assert.equal(row.strategy, 'manual / external')
})
