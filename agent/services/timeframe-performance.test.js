// node --test agent/services/timeframe-performance.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { timeframePerformance, WINDOWS } from './timeframe-performance.js'

function mkDb(timeframes = ['4h', '1d']) {
  const db = initDB(':memory:')
  setState(db, 'autotrade_timeframes', JSON.stringify(timeframes))
  return db
}

function insertClosedTrade(db, { tf, pnl, closedAgo }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_timeframe, opened_at, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, datetime('now', ?), datetime('now', ?))`
  ).run(pnl, tf, closedAgo, closedAgo)
}

test('windows are the five agreed buckets', () => {
  assert.deepEqual(WINDOWS.map(w => w.key), ['2h', '4h', '1d', '5d', '1w'])
})

test('armed timeframes always get a row, even with zero trades', () => {
  const db = mkDb(['12h', '3d'])
  const out = timeframePerformance(db)
  assert.deepEqual(out.rows.map(r => r.timeframe), ['12h', '3d'])
  for (const row of out.rows) {
    assert.equal(row.armed, true)
    for (const w of out.windows) {
      assert.equal(row.cells[w].outcome, 'no_trade')
      assert.equal(row.cells[w].trades, 0)
    }
  }
})

test('win/loss decided by net PnL inside each window', () => {
  const db = mkDb(['4h'])
  insertClosedTrade(db, { tf: '4h', pnl: 10, closedAgo: '-1 hours' })   // in all windows
  insertClosedTrade(db, { tf: '4h', pnl: -25, closedAgo: '-3 hours' })  // outside 2h only
  const out = timeframePerformance(db)
  const cells = out.rows[0].cells
  // Last 2h: only the +10 trade → win
  assert.equal(cells['2h'].outcome, 'win')
  assert.equal(cells['2h'].trades, 1)
  assert.equal(cells['2h'].pnl, 10)
  // Last 4h and wider: 10 - 25 = -15 → loss, 2 trades
  for (const w of ['4h', '1d', '5d', '1w']) {
    assert.equal(cells[w].outcome, 'loss', w)
    assert.equal(cells[w].trades, 2, w)
    assert.equal(cells[w].pnl, -15, w)
    assert.equal(cells[w].wins, 1, w)
    assert.equal(cells[w].losses, 1, w)
  }
})

test('trades older than a window do not leak into it', () => {
  const db = mkDb(['1d'])
  insertClosedTrade(db, { tf: '1d', pnl: 50, closedAgo: '-3 days' }) // only 5d + 1w
  const out = timeframePerformance(db)
  const cells = out.rows[0].cells
  assert.equal(cells['2h'].outcome, 'no_trade')
  assert.equal(cells['4h'].outcome, 'no_trade')
  assert.equal(cells['1d'].outcome, 'no_trade')
  assert.equal(cells['5d'].outcome, 'win')
  assert.equal(cells['1w'].outcome, 'win')
})

test('zero net PnL with trades reads flat, not no_trade', () => {
  const db = mkDb(['4h'])
  insertClosedTrade(db, { tf: '4h', pnl: 20, closedAgo: '-1 hours' })
  insertClosedTrade(db, { tf: '4h', pnl: -20, closedAgo: '-1 hours' })
  const out = timeframePerformance(db)
  assert.equal(out.rows[0].cells['2h'].outcome, 'flat')
  assert.equal(out.rows[0].cells['2h'].trades, 2)
})

test('timeframes removed from the armed list keep a row while they have recent trades', () => {
  const db = mkDb(['1d'])
  insertClosedTrade(db, { tf: '12h', pnl: 5, closedAgo: '-2 days' })
  const out = timeframePerformance(db)
  assert.deepEqual(out.rows.map(r => [r.timeframe, r.armed]), [['1d', true], ['12h', false]])
  assert.equal(out.rows[1].cells['1w'].outcome, 'win')
})

test('open trades and ISO-with-T timestamps are handled', () => {
  const db = mkDb(['4h'])
  // Open trade must not count anywhere.
  db.prepare(
    `INSERT INTO trades (symbol, side, status, label_timeframe, opened_at)
     VALUES ('EURUSD', 'BUY', 'open', '4h', datetime('now'))`
  ).run()
  // ISO 8601 closed_at (older writer format) still lands in the window.
  const iso = new Date(Date.now() - 30 * 60_000).toISOString()
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_timeframe, opened_at, closed_at)
     VALUES ('EURUSD', 'SELL', 'closed', 7, '4h', ?, ?)`
  ).run(iso, iso)
  const out = timeframePerformance(db)
  assert.equal(out.rows[0].cells['2h'].trades, 1)
  assert.equal(out.rows[0].cells['2h'].outcome, 'win')
})

test('missing autotrade_timeframes state falls back to defaults', () => {
  const db = initDB(':memory:')
  const out = timeframePerformance(db)
  assert.deepEqual(out.rows.map(r => r.timeframe), ['4h', '1d'])
})
