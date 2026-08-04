// node --test agent/llm-exit-gate.test.js
//
// D13 (audit F-L7-03) asked: "Should the LLM monitor be able to close a
// position without a deterministic second gate?" The answer was a PARTIAL no —
// exits at positive R became advisory, everything else still executed, on the
// reasoning that "cutting a loser early on a broken thesis is exactly the case
// an LLM read should be allowed to act on."
//
// §5490 (owner, 2026-08-04) makes the answer a total no, because fourteen days
// of production disagreed with that reasoning. On account 47790949:
//
//   llm_monitor   12 exits   2 positive   -$2,229.85   stops moved: 0
//
// The two worst were NAS100 -$826 and USDZAR -$592 at a realised 0.000R —
// closes AT the entry price, where the whole loss is cost. Those are precisely
// the exits the old `r > 0` test waved through, because zero is not positive.
//
// So the model keeps its voice and loses its hands: `llm_monitor` is absent
// from CLOSE_AUTHORITY in null-exit-guard.js, and monitorOnePosition no longer
// calls the executor for it at all. These tests now pin THAT contract — the
// three cases below are the same three, each asserting the opposite of what it
// used to, which is the honest way to record a reversal.

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

test('an LLM EXIT at positive R is advisory', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const pos = insertPosition(db, { symbol: 'EURUSD', entryPrice: 100, initialRisk: 10 })
  const currentPrice = 103 // r = +0.3, in profit, below every deterministic trigger

  await monitorOnePosition(db, s, pos, currentPrice, fakeExitClient())

  const row = db.prepare('SELECT status, last_check_action FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'active')
  assert.equal(row.last_check_action, 'EXIT', 'the LLM verdict is still recorded for the audit trail')

  const advisory = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_ADVISORY'").get()
  assert.ok(advisory, 'an advisory record must exist')
  const body = JSON.parse(advisory.body)
  assert.equal(body.symbol, 'EURUSD')
  assert.ok(body.currentR > 0)
})

test('an LLM EXIT at a LOSS is advisory too — this is the reversal', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const pos = insertPosition(db, { symbol: 'GBPUSD', entryPrice: 100, initialRisk: 10 })
  const currentPrice = 97 // r = -0.3 — the case that USED to execute

  await monitorOnePosition(db, s, pos, currentPrice, fakeExitClient())

  const row = db.prepare('SELECT status FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'active',
    'the position stays open — broker SL/TP still protect it and the deterministic rules still manage it')

  const advisory = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_ADVISORY'").get()
  assert.ok(advisory, 'the request is recorded rather than silently dropped')
  assert.ok(JSON.parse(advisory.body).currentR < 0)
})

test('an LLM EXIT with an unknown R is advisory, and says so without inventing a number', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  // A real currentPrice is supplied (so monitor-svc.js's own separate no-price
  // guard never fires) but the row has no initial_risk, so currentR() returns
  // null regardless of price.
  const pos = insertPosition(db, { symbol: 'USDJPY', entryPrice: 100, initialRisk: null })

  await monitorOnePosition(db, s, pos, 103, fakeExitClient())

  const row = db.prepare('SELECT status FROM monitored_positions WHERE id = ?').get(pos.id)
  assert.equal(row.status, 'active')

  const advisory = db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_ADVISORY'").get()
  assert.ok(advisory, 'an unknown R still gets a record')
  assert.equal(JSON.parse(advisory.body).currentR, null,
    'an R that could not be computed is logged as null, not as 0')
})

test('nothing writes the old deferral marker any more', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const pos = insertPosition(db, { symbol: 'AUDUSD', entryPrice: 100, initialRisk: 10 })
  await monitorOnePosition(db, s, pos, 103, fakeExitClient())
  assert.equal(
    db.prepare("SELECT body FROM action_log WHERE method = 'LLM_EXIT_DEFERRED'").get(),
    undefined,
    'LLM_EXIT_DEFERRED described a gate that no longer exists — a stale marker in the audit log is a lie about which rule ran',
  )
})
