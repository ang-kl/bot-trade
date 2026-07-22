// node --test agent/keeper-broker-sql.test.js
//
// SQL-only integration tests for the broker wiring added in PR-B, plus
// closeTradeRow (agent/db.js) — the single converged close-writer used by
// loop.js's markTradeClosed call sites and reconciler.js's three — so schema
// regressions are caught in CI without needing a live cTrader demo.
//
// The WebSocket path itself is validated at runtime against a Pepperstone
// demo account; those tests live outside CI.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, closeTradeRow } from './db.js'

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

test('closeTradeRow stamps exit_price, pnl, close_reason, closed_at + closed_at_ms, hold_duration_ms', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '111' })
  const openedAtMs = Date.parse(`${s.readTrade.get(tradeId).opened_at.replace(' ', 'T')}Z`)

  const closedAtMs = openedAtMs + 5 * 60_000
  const res = closeTradeRow(db, tradeId, {
    exitPrice: 3425.5, closeReason: 'time_cap_expired', grossPnl: 51.2, netPnl: 48.6, closedAtMs,
  })

  assert.equal(res.changed, true)
  assert.equal(res.holdDurationMs, 5 * 60_000)
  const row = s.readTrade.get(tradeId)
  assert.equal(row.status, 'closed')
  assert.equal(row.exit_price, 3425.5)
  assert.equal(row.close_reason, 'time_cap_expired')
  assert.equal(row.gross_pnl, 51.2)
  assert.equal(row.net_pnl, 48.6)
  assert.ok(row.closed_at, 'closed_at must be set')
  assert.equal(row.closed_at_ms, closedAtMs)
  assert.equal(row.hold_duration_ms, 5 * 60_000)
})

test('closeTradeRow preserves existing values when passed null', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '222' })

  // Pre-seed an exit_price to assert COALESCE keeps it
  db.prepare(`UPDATE trades SET exit_price = 3420, gross_pnl = 40 WHERE id = ?`).run(tradeId)

  closeTradeRow(db, tradeId, { closeReason: 'already_closed' })

  const row = s.readTrade.get(tradeId)
  assert.equal(row.exit_price, 3420, 'exit_price should be preserved')
  assert.equal(row.gross_pnl, 40, 'gross_pnl should be preserved')
  assert.equal(row.close_reason, 'already_closed')
  assert.equal(row.status, 'closed')
})

test('closeTradeRow idempotency: two closes fired for one trade_id result in exactly one write', () => {
  const db = mkDb()
  const s = prep(db)
  const { tradeId } = seedTradeAndMonitor(db, { ctraderPositionId: '333' })

  // Simulates the real race this fixes: the position-manager's FULL_EXIT
  // path and the reconciler's orphan sweep both reaching the same trade —
  // loop.js's markTradeClosed had NO status guard before this convergence,
  // so a second call would silently re-stamp closed_at / overwrite pnl.
  const first = closeTradeRow(db, tradeId, { exitPrice: 100, closeReason: 'first_writer', grossPnl: 10, netPnl: 9 })
  const second = closeTradeRow(db, tradeId, { exitPrice: 200, closeReason: 'second_writer', grossPnl: 99, netPnl: 88 })

  assert.equal(first.changed, true)
  assert.equal(second.changed, false, 'second close must be a no-op — status is no longer open')
  const row = s.readTrade.get(tradeId)
  assert.equal(row.exit_price, 100, 'first writer wins — second must not overwrite')
  assert.equal(row.close_reason, 'first_writer')
  assert.equal(row.gross_pnl, 10)
  assert.equal(row.net_pnl, 9)
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
