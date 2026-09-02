// node --test agent/services/position-events.test.js
//
// P10 tweak journal: recording never throws, rows stamp the account,
// filters work, retention prunes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordPositionEvent, prunePositionEvents } from './position-events.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'ACC1')
  return db
}

test('recordPositionEvent stamps the selected account by default, explicit id wins', () => {
  const db = fresh()
  recordPositionEvent(db, { positionId: '123', symbol: 'EURUSD', kind: 'sl_moved', fromValue: 1.1, toValue: 1.105, source: 'profit_keeper', reason: 'lock 1R' })
  recordPositionEvent(db, { accountId: 'ACC2', positionId: '456', symbol: 'XAUUSD', kind: 'close', detail: { reason: 'take_profit_usd' } })
  const rows = db.prepare('SELECT * FROM position_events ORDER BY id DESC').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].symbol, 'XAUUSD') // newest first
  assert.equal(rows[0].account_id, 'ACC2')
  assert.equal(JSON.parse(rows[0].detail_json).reason, 'take_profit_usd')
  assert.equal(rows[1].account_id, 'ACC1')
  assert.equal(rows[1].kind, 'sl_moved')
  assert.equal(rows[1].from_value, 1.1)
  assert.equal(rows[1].to_value, 1.105)
  assert.equal(rows[1].source, 'profit_keeper')
})

test('recordPositionEvent never throws — even on a closed db handle', () => {
  const db = fresh()
  db.close()
  assert.doesNotThrow(() => recordPositionEvent(db, { symbol: 'EURUSD', kind: 'sl_moved' }))
  assert.equal(prunePositionEvents(db), 0) // prune swallows too
})

test('prunePositionEvents removes only rows past retention', () => {
  const db = fresh()
  recordPositionEvent(db, { positionId: 'P1', symbol: 'EURUSD', kind: 'sl_moved' })
  db.prepare(`INSERT INTO position_events (symbol, kind, at) VALUES ('OLD', 'sl_moved', datetime('now', '-120 days'))`).run()
  assert.equal(prunePositionEvents(db, 90), 1)
  const left = db.prepare('SELECT * FROM position_events ORDER BY id DESC').all()
  assert.equal(left.length, 1)
  assert.equal(left[0].symbol, 'EURUSD')
})
