// node --test agent/llm-exit-gate.test.js
//
// D13 (audit F-L7-03): "Should the LLM monitor be able to close a position
// without a deterministic second gate?" Owner: No — require a deterministic
// condition to agree before an LLM-initiated exit executes. monitorOnePosition
// (agent/loop.js) now checks the same currentR the deterministic rules
// already computed this tick: a clear R-multiple profit has no price-based
// corroboration for "exit now," so that EXIT is logged as deferred, not
// executed. A losing or breakeven-or-worse position still executes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
import { monitorOnePosition } from './loop.js'

function mkDb() {
  return initDB(':memory:')
}

function insertPosition(db, { symbol, entryPrice, initialRisk }) {
  const id = db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status)
    VALUES (?, 'long', ?, ?, ?, 'x', ?, 'autopilot', 'active')
  `).run(
    symbol, entryPrice,
    initialRisk ? entryPrice - initialRisk : null,
    initialRisk ? entryPrice + initialRisk * 2 : null,
    initialRisk ?? null,
  ).lastInsertRowid
  return db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
}

function mkStmts(db) {
  return {
    updatePositionMetrics: db.prepare(
      'UPDATE monitored_positions SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ? WHERE id = ?'
    ),
    updatePositionCheck: db.prepare(
      'UPDATE monitored_positions SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ? WHERE id = ?'
    ),
    selectBrokerContext: { get: () => ({}) }, // no ctrader creds in test env → executeBrokerAction skips fast
    closePosition: db.prepare("UPDATE monitored_positions SET status = ? WHERE id = ?"),
  }
}

function fakeExitClient(reasoning = 'thesis looks shaky, take it off') {
  return {
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'EXIT',
            new_sl: null,
            scale_pct: null,
            reasoning,
            thesis_status: 'broken',
            urgency: 'high',
          }),
        }],
        usage: { output_tokens: 5 },
      }),
    },
  }
}

test('LLM EXIT is deferred, not executed, when currentR is positive', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const pos = insertPosition(db, { symbol: 'EURUSD', entryPrice: 100, initialRisk: 10 })
  const currentPrice = 103 // r = +0.3, in profit, below every deterministic trigger → HOLD

  await monitorOnePosition(db, s, pos, currentPrice, fakeExitClient())

  const row = db.prepare('SELECT status, last_check_action FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'active', 'position must stay active — the LLM alone may not close a profitable position')
  assert.equal(row.last_check_action, 'EXIT', 'the LLM verdict is still recorded for the audit trail')

  const deferred = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_DEFERRED'").get()
  assert.ok(deferred, 'a deferred-exit record must exist')
  const body = JSON.parse(deferred.body)
  assert.equal(body.symbol, 'EURUSD')
  assert.ok(body.currentR > 0)
})

test('LLM EXIT executes normally when currentR is at a loss', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const pos = insertPosition(db, { symbol: 'GBPUSD', entryPrice: 100, initialRisk: 10 })
  const currentPrice = 97 // r = -0.3, a loss, still HOLD under the deterministic rules

  await monitorOnePosition(db, s, pos, currentPrice, fakeExitClient())

  // No ctrader creds configured in this test env, so executeBrokerAction
  // returns { skipped: true, reason: 'ctrader_not_configured' } — the one
  // skip reason mayCloseDbOnlyAfterSkip treats as "no broker to close
  // against," so the row closes DB-only. That DB-only close is exactly the
  // proof the gate let execution proceed (as opposed to the deferred case
  // above, where the row is left untouched).
  const row = db.prepare('SELECT status FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'closed', 'a losing position\'s LLM-initiated exit must still be allowed through')

  const deferred = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_DEFERRED'").get()
  assert.equal(deferred, undefined, 'the gate must not have fired for a losing position')
})

test('LLM EXIT executes normally when currentR is unknown (no initial_risk on the row)', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  // A real currentPrice is supplied (so monitor-svc.js's own separate
  // no-price guard never fires) but the row has no initial_risk, so
  // currentR() returns null regardless of price — the case this gate
  // treats as "can't confirm a profit, so don't block."
  const pos = insertPosition(db, { symbol: 'USDJPY', entryPrice: 100, initialRisk: null })

  await monitorOnePosition(db, s, pos, 103, fakeExitClient())

  const row = db.prepare('SELECT status FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'closed', 'an unknown currentR must not itself block the exit — only a confirmed profit does')

  const deferred = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_DEFERRED'").get()
  assert.equal(deferred, undefined, 'the gate must not fire when currentR could not be computed')
})
