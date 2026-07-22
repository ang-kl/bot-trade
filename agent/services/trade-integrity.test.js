// node --test agent/services/trade-integrity.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { findDuplicateTrades } from './trade-integrity.js'

function insertTrade(db, { symbol, side, entry, exit, pnl, posId, closedAt = "datetime('now')", strategy = null }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, label_strategy, opened_at)
    VALUES (?, ?, ?, ?, ?, 'closed', ${closedAt}, ?, ?, datetime('now'))
  `).run(symbol, side, entry, exit, pnl, posId ?? null, strategy)
}

test('finds a duplicate group sharing symbol/side/entry/exit/net_pnl (owner: 7 identical AUDUSD rows)', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 7; i++) {
    insertTrade(db, { symbol: 'AUDUSD', side: 'SELL', entry: 0.6512, exit: 0.6578, pnl: -508.37, posId: '900' })
  }
  const { groups, totalExtraRows, totalExtraPnl } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 7)
  assert.equal(groups[0].samePositionId, true)
  assert.equal(totalExtraRows, 6)
  assert.equal(totalExtraPnl, -3050.22) // 6 × -508.37
})

test('does not flag genuinely different trades', () => {
  const db = initDB(':memory:')
  insertTrade(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.11, pnl: 50 })
  insertTrade(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.09, pnl: -100 }) // different exit/pnl
  insertTrade(db, { symbol: 'GBPUSD', side: 'BUY', entry: 1.1, exit: 1.11, pnl: 50 }) // different symbol
  const { groups, totalExtraRows } = findDuplicateTrades(db)
  assert.equal(groups.length, 0)
  assert.equal(totalExtraRows, 0)
})

test('flags a group even without a shared position id, but marks samePositionId false', () => {
  const db = initDB(':memory:')
  insertTrade(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: 151, pnl: 20, posId: '1' })
  insertTrade(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: 151, pnl: 20, posId: '2' })
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].samePositionId, false)
})

test('only considers CLOSED trades with entry/net_pnl present', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,50,'open', datetime('now'))`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,NULL,'closed', datetime('now'), datetime('now'))`).run()
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 0)
})

test('a broker-side close backfilled by pnl-backfill.js (net_pnl set, exit_price still NULL) is still caught (Codex review)', () => {
  const db = initDB(':memory:')
  // Same shape pnl-backfill.js leaves behind: status closed, net_pnl filled
  // in later, exit_price never touched — the exact class of duplicate the
  // old exit_price-required predicate was blind to.
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at)
      VALUES ('AUDUSD', 'SELL', 0.6512, NULL, -508.37, 'closed', datetime('now'), '900', datetime('now'))
    `).run()
  }
  const { groups, totalExtraRows } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].samePositionId, true)
  assert.equal(totalExtraRows, 2)
})

test('flags multiple closed trades sharing one broker position id even when net_pnl differs (position-id signal)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,50,'closed', datetime('now'), '77', datetime('now'))`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at) VALUES ('EURUSD','BUY',1.1,1.12,55,'closed', datetime('now'), '77', datetime('now'))`).run()
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].samePositionId, true)
})
