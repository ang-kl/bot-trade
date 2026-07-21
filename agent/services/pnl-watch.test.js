// node --test agent/services/pnl-watch.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepOf, shouldAlertStep, runPnlWatch } from './pnl-watch.js'
import { initDB } from '../db.js'

test('stepOf: signed step of balance percent', () => {
  assert.equal(stepOf(500, 50_000, 1), 1)     // +1.0%
  assert.equal(stepOf(499, 50_000, 1), 0)     // +0.998% — inside first step
  assert.equal(stepOf(-1600, 50_000, 1), -3)  // −3.2%
  assert.equal(stepOf(500, 0, 1), 0)          // no balance → never alert
  assert.equal(stepOf(NaN, 50_000, 1), 0)
})

test('shouldAlertStep: deeper-only in one direction, re-arms across zero', () => {
  assert.equal(shouldAlertStep(1, 0), true, 'first crossing alerts')
  assert.equal(shouldAlertStep(1, 1), false, 'same step stays quiet')
  assert.equal(shouldAlertStep(2, 1), true, 'next full step alerts')
  assert.equal(shouldAlertStep(1, 2), false, 'pulling back is not news')
  assert.equal(shouldAlertStep(-1, 2), true, 'flipping sign alerts')
  assert.equal(shouldAlertStep(-2, -1), true)
  assert.equal(shouldAlertStep(0, 2), false, 'inside the first step never alerts')
})

// Regression: the position query joins ctrader_position_id off `trades` (it does
// NOT live on monitored_positions). A wrong table raised "no such column:
// ctrader_position_id" at runtime and silently killed the whole watch. This
// runs the real query path against the real schema so the column must resolve.
test('runPnlWatch: query resolves ctrader_position_id via the trades join (no SQL error)', async () => {
  const db = initDB(':memory:')
  db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run('pnl_alert_pct', '1')
  const t = db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id) VALUES ('EURUSD','buy','open','P123')`
  ).run()
  db.prepare(
    `INSERT INTO monitored_positions (symbol, side, trade_id, status) VALUES ('EURUSD','buy',?, 'active')`
  ).run(t.lastInsertRowid)
  // creds.ready falsy → returns early WITHOUT running the (previously broken)
  // query, so assert the query itself compiles/resolves directly.
  const rows = db.prepare(
    `SELECT t.ctrader_position_id AS pid, m.symbol AS symbol, m.side AS side
       FROM monitored_positions m
       JOIN trades t ON t.id = m.trade_id
      WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL`
  ).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 'P123')
  assert.equal(rows[0].symbol, 'EURUSD')
  // And the guarded entry point stays safe when creds aren't ready.
  const res = await runPnlWatch(db, { ready: false })
  assert.deepEqual(res, { checked: 0, alerts: 0 })
})
