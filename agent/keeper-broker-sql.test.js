// node --test agent/keeper-broker-sql.test.js
//
// SQL-only integration tests for the broker wiring added in PR-B. These
// exercise the new prepared statements — selectBrokerContext (JOIN
// monitored_positions → trades), markTradeClosed, reduceTradeVolume — so
// schema regressions are caught in CI without needing a live cTrader demo.
//
// The WebSocket path itself is validated at runtime against a Pepperstone
// demo account; those tests live outside CI.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'

function mkDb() {
  return initDB(':memory:')
}

function prep(db) {
  return {
    selectBrokerContext: db.prepare(`
      SELECT t.ctrader_position_id AS positionId, t.volume AS volumeLots
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.id = ?
    `),
    markTradeClosed: db.prepare(`
      UPDATE trades
      SET status = 'closed', closed_at = datetime('now'),
          exit_price = COALESCE(?, exit_price),
          close_reason = ?,
          gross_pnl = COALESCE(?, gross_pnl),
          net_pnl = COALESCE(?, net_pnl)
      WHERE id = ?
    `),
    reduceTradeVolume: db.prepare(`UPDATE trades SET volume = ? WHERE id = ?`),
    readTrade: db.prepare(`SELECT * FROM trades WHERE id = ?`),
  }
}

function seedTradeAndMonitor(db, { ctraderPositionId, volumeLots = 0.02 } = {}) {
  const { lastInsertRowid: tradeId } = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, sl_price, volume,
      opened_at, status, ctrader_position_id, source, label_strategy)
    VALUES ('XAUUSD', 'BUY', 3400, 3380, ?, datetime('now'), 'open', ?, 'autopilot', 'trend')
  `).run(volumeLots, ctraderPositionId)

  const { lastInsertRowid: mpId } = db.prepare(`
    INSERT INTO monitored_positions (symbol, trade_id, side, entry_price,
      current_sl, initial_risk, source, status)
    VALUES ('XAUUSD', ?, 'long', 3400, 3380, 20, 'autopilot', 'active')
  `).run(tradeId)

  return { tradeId, mpId }
}

// ---------------------------------------------------------------------------

test('selectBrokerContext joins monitored_positions → trades', () => {
  const db = mkDb()
  const s = prep(db)
  const { mpId } = seedTradeAndMonitor(db, { ctraderPositionId: '9876543', volumeLots: 0.05 })

  const ctx = s.selectBrokerContext.get(mpId)
  assert.equal(ctx.positionId, '9876543')
  assert.equal(ctx.volumeLots, 0.05)
})

test('selectBrokerContext returns NULL fields for legacy rows (no trade_id)', () => {
  const db = mkDb()
  const s = prep(db)
  const { lastInsertRowid: legacyId } = db.prepare(`
    INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, initial_risk, status)
    VALUES ('XAUUSD', 'long', 3400, 3380, 20, 'active')
  `).run()

  const ctx = s.selectBrokerContext.get(legacyId)
  assert.equal(ctx.positionId, null)
  assert.equal(ctx.volumeLots, null)
})

test('markTradeClosed stamps exit_price, pnl, close_reason', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '111' })

  s.markTradeClosed.run(3425.5, 'time_cap_expired', 51.2, 48.6, tradeId)

  const row = s.readTrade.get(tradeId)
  assert.equal(row.status, 'closed')
  assert.equal(row.exit_price, 3425.5)
  assert.equal(row.close_reason, 'time_cap_expired')
  assert.equal(row.gross_pnl, 51.2)
  assert.equal(row.net_pnl, 48.6)
  assert.ok(row.closed_at, 'closed_at must be set')
})

test('markTradeClosed preserves existing values when passed null', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '222' })

  // Pre-seed an exit_price to assert COALESCE keeps it
  db.prepare(`UPDATE trades SET exit_price = 3420, gross_pnl = 40 WHERE id = ?`).run(tradeId)

  s.markTradeClosed.run(null, 'already_closed', null, null, tradeId)

  const row = s.readTrade.get(tradeId)
  assert.equal(row.exit_price, 3420, 'exit_price should be preserved')
  assert.equal(row.gross_pnl, 40, 'gross_pnl should be preserved')
  assert.equal(row.close_reason, 'already_closed')
  assert.equal(row.status, 'closed')
})

test('reduceTradeVolume reflects runner leg after partial close', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '333', volumeLots: 0.10 })

  // 50% close → 0.05 runner remains
  s.reduceTradeVolume.run(0.05, tradeId)

  const row = s.readTrade.get(tradeId)
  assert.equal(row.volume, 0.05)
  assert.equal(row.status, 'open', 'trade should stay open')
})

test('monitored_positions.trade_id FK rejects orphans', () => {
  const db = mkDb()
  // foreign_keys = ON in initDB() — inserting a monitored_positions row whose
  // trade_id points nowhere must raise a constraint error so the keeper can
  // never silently end up tracking a position the trades table forgot about.
  assert.throws(
    () => db.prepare(`
      INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, initial_risk, source, status)
      VALUES ('XAUUSD', 999999, 'long', 3400, 3380, 20, 'autopilot', 'active')
    `).run(),
    /FOREIGN KEY/,
  )
})
