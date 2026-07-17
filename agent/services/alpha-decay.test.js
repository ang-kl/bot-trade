// node --test agent/services/alpha-decay.test.js
//
// Alpha decay: expectancy math, rolling window comparison + trend verdicts,
// entry-lag buckets, and the assembled DB view.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { expectancy, rollingDecay, entryLagBuckets, alphaDecayView } from './alpha-decay.js'

const trade = (pnl, i) => ({ net_pnl: pnl, closed_at: `2026-07-${String(1 + Math.floor(i / 10)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00:00` })

test('expectancy: mean net PnL, win rate, empty-safe', () => {
  assert.deepEqual(expectancy([]), { n: 0, expectancy: null, winRate: null, totalPnl: 0 })
  const e = expectancy([{ net_pnl: 10 }, { net_pnl: -5 }, { net_pnl: 4 }])
  assert.equal(e.n, 3)
  assert.equal(e.expectancy, 3)
  assert.equal(e.winRate, 0.667)
  assert.equal(e.totalPnl, 9)
})

test('rollingDecay: too few trades → insufficient, no false verdicts', () => {
  const r = rollingDecay(Array.from({ length: 15 }, (_, i) => trade(1, i)), 10)
  // 15 trades: recent window has 10, prior only 5 (< min 10) → insufficient
  assert.equal(r.trend, 'insufficient')
  assert.equal(r.delta, null)
})

test('rollingDecay: falling expectancy is flagged decaying, rising improving, flat stable', () => {
  // 20 old trades at +$2, then 20 recent at -$1 → decaying
  const decay = [
    ...Array.from({ length: 20 }, (_, i) => trade(2, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(-1, 20 + i)),
  ]
  const d = rollingDecay(decay, 20)
  assert.equal(d.trend, 'decaying')
  assert.equal(d.delta, -3)
  assert.equal(d.recent.expectancy, -1)
  assert.equal(d.prior.expectancy, 2)

  const improve = [
    ...Array.from({ length: 20 }, (_, i) => trade(-1, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(2, 20 + i)),
  ]
  assert.equal(rollingDecay(improve, 20).trend, 'improving')

  // ±10% wobble around $2 stays stable (threshold is 20% of prior)
  const flat = [
    ...Array.from({ length: 20 }, (_, i) => trade(2, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(2.2, 20 + i)),
  ]
  assert.equal(rollingDecay(flat, 20).trend, 'stable')
})

test('entryLagBuckets: trades land in the right lag bucket', () => {
  const rows = [
    { net_pnl: 10, lag_sec: 5 },
    { net_pnl: 20, lag_sec: 59 },
    { net_pnl: -5, lag_sec: 120 },
    { net_pnl: -15, lag_sec: 3000 },
    { net_pnl: 99, lag_sec: NaN }, // unknown lag → excluded
  ]
  const [fast, medium, slow] = entryLagBuckets(rows)
  assert.equal(fast.n, 2)
  assert.equal(fast.expectancy, 15)
  assert.equal(medium.n, 1)
  assert.equal(slow.n, 1)
  assert.equal(slow.expectancy, -15)
})

test('alphaDecayView: groups by strategy and computes lag from the analyses join', () => {
  const db = initDB(':memory:')
  const insA = db.prepare(`INSERT INTO analyses (symbol, analyzed_at) VALUES ('EURUSD', ?)`)
  const insT = db.prepare(
    `INSERT INTO trades (symbol, side, net_pnl, status, label_strategy, opened_at, closed_at, analysis_id)
     VALUES ('EURUSD', 'BUY', ?, 'closed', ?, ?, ?, ?)`
  )
  // 12 fib trades, signal → fill lag 30s each
  for (let i = 0; i < 12; i++) {
    const signalAt = `2026-07-10 0${i % 10}:00:00`
    const a = insA.run(signalAt)
    insT.run(5, 'fib_618_fade', `2026-07-10 0${i % 10}:00:30`, `2026-07-10 0${i % 10}:30:00`, a.lastInsertRowid)
  }
  // one open trade must be excluded
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, label_strategy) VALUES ('EURUSD', NULL, 'open', 'fib_618_fade')`).run()

  const v = alphaDecayView(db, { window: 10 })
  assert.equal(v.total_closed, 12)
  assert.equal(v.strategies.length, 1)
  assert.equal(v.strategies[0].strategy, 'fib_618_fade')
  assert.equal(v.strategies[0].total.n, 12)
  assert.equal(v.strategies[0].trend, 'insufficient') // prior window only 2
  assert.equal(v.lag_sampled, 12)
  assert.equal(v.entry_lag[0].n, 12) // all lags = 30s → fast bucket
})
