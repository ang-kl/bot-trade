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

// ---------------------------------------------------------------------------
// Management-state stamping (owner plan, 02-09-2026): every row carries the
// state the position was in and the state the event moved it to, so the
// journal is the state sequence and a later chain is a query, not a project.
// ---------------------------------------------------------------------------
import { nextManagementState, currentManagementState, lastStateBeforeExit, MANAGEMENT_STATES } from './position-events.js'

function seedTrade(db, { side = 'long', entry = 100 } = {}) {
  const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price) VALUES ('EURUSD', ?, 'open', ?, 99)`).run(side, entry)
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price) VALUES ('EURUSD', ?, ?, ?)`).run(t.lastInsertRowid, side, entry)
  return Number(t.lastInsertRowid)
}

test('nextManagementState: sl_moved is be_moved only when the stop reaches entry in the trade favour; states only advance', () => {
  assert.equal(nextManagementState('opened', { kind: 'sl_moved', toValue: 99.5, entry: 100, side: 'long' }), 'opened', 'a stop still below entry on a long is not break-even')
  assert.equal(nextManagementState('opened', { kind: 'sl_moved', toValue: 100, entry: 100, side: 'long' }), 'be_moved')
  assert.equal(nextManagementState('opened', { kind: 'sl_moved', toValue: 100.5, entry: 100, side: 'short' }), 'opened', 'a stop above entry on a short is not break-even')
  assert.equal(nextManagementState('opened', { kind: 'sl_moved', toValue: 99.8, entry: 100, side: 'sell' }), 'be_moved')
  assert.equal(nextManagementState('trail_armed', { kind: 'sl_moved', toValue: 101, entry: 100, side: 'long' }), 'trail_armed', 'never regresses to be_moved')
  assert.equal(nextManagementState('be_moved', { kind: 'scale_out' }), 'scaled_out')
  assert.equal(nextManagementState('scaled_out', { kind: 'trail_armed' }), 'trail_armed')
  assert.equal(nextManagementState('trail_armed', { kind: 'trail_tightened' }), 'trail_tightened')
  assert.equal(nextManagementState('trail_tightened', { kind: 'lot_trimmed' }), 'trail_tightened', 'scaled_out ranks below and cannot pull the state back')
  assert.equal(nextManagementState('trail_armed', { kind: 'close' }), 'closed:close')
  assert.equal(nextManagementState('closed:close', { kind: 'sl_moved', toValue: 200, entry: 100, side: 'long' }), 'closed:close', 'terminal is terminal')
  assert.equal(nextManagementState('garbage', { kind: 'tp_moved' }), 'opened', 'unknown from-state reads as opened; unknown kinds keep it')
  assert.deepEqual([...MANAGEMENT_STATES], ['opened', 'be_moved', 'scaled_out', 'trail_armed', 'trail_tightened'])
})

test('recordPositionEvent stamps state_from/state_to from the journal, and lastStateBeforeExit reads the pre-exit state with its R', () => {
  const db = fresh()
  const id = seedTrade(db, { side: 'long', entry: 100 })
  assert.equal(currentManagementState(db, { tradeId: id }), 'opened')
  recordPositionEvent(db, { tradeId: id, positionId: 'P1', symbol: 'EURUSD', kind: 'sl_moved', fromValue: 99, toValue: 99.5, rAt: 0.4 })
  recordPositionEvent(db, { tradeId: id, positionId: 'P1', symbol: 'EURUSD', kind: 'sl_moved', fromValue: 99.5, toValue: 100, rAt: 1.0 })
  recordPositionEvent(db, { tradeId: id, positionId: 'P1', symbol: 'EURUSD', kind: 'trail_armed', rAt: 1.5 })
  recordPositionEvent(db, { tradeId: id, positionId: 'P1', symbol: 'EURUSD', kind: 'close', rAt: 1.2 })
  const rows = db.prepare('SELECT kind, state_from, state_to FROM position_events WHERE trade_id = ? ORDER BY id').all(id)
  assert.deepEqual(rows, [
    { kind: 'sl_moved', state_from: 'opened', state_to: 'opened' },
    { kind: 'sl_moved', state_from: 'opened', state_to: 'be_moved' },
    { kind: 'trail_armed', state_from: 'be_moved', state_to: 'trail_armed' },
    { kind: 'close', state_from: 'trail_armed', state_to: 'closed:close' },
  ])
  assert.equal(currentManagementState(db, { tradeId: id }), 'closed:close')
  assert.deepEqual(lastStateBeforeExit(db, id), { state: 'trail_armed', rAtTransition: 1.5 })
  // A trade with no journal at all reads as opened with no R — never throws.
  assert.deepEqual(lastStateBeforeExit(db, 999_999), { state: 'opened', rAtTransition: null })
  // Position-id keyed rows (no trade id) still carry a sequence.
  recordPositionEvent(db, { positionId: 'P9', symbol: 'XAUUSD', kind: 'scale_out' })
  assert.equal(currentManagementState(db, { positionId: 'P9' }), 'scaled_out')
})
