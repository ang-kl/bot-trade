// node --test agent/services/decision-log.test.js
//
// 3A decision provenance: recording never throws, rows stamp the account,
// filters work, retention prunes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordDecision, recentDecisions, pruneDecisionLog } from './decision-log.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'ACC1')
  return db
}

test('recordDecision stamps the selected account by default, explicit id wins', () => {
  const db = fresh()
  recordDecision(db, { symbol: 'EURUSD', timeframe: '1h', strategy: 'rsi2_reversion', stage: 'lesson_decay', decision: 'skip', reason: 'alpha_decay_cooloff' })
  recordDecision(db, { accountId: 'ACC2', symbol: 'XAUUSD', stage: 'style_filter', decision: 'skip', reason: 'all_styles_disabled', detail: { styles: {} } })
  const rows = recentDecisions(db)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].symbol, 'XAUUSD') // newest first
  assert.equal(rows[0].account_id, 'ACC2')
  assert.equal(JSON.parse(rows[0].detail_json).styles !== undefined, true)
  assert.equal(rows[1].account_id, 'ACC1')
  assert.equal(rows[1].stage, 'lesson_decay')
  assert.equal(rows[1].decision, 'skip')
})

test('recentDecisions filters by symbol and stage, caps limit', () => {
  const db = fresh()
  for (let i = 0; i < 5; i++) recordDecision(db, { symbol: 'EURUSD', stage: 'style_filter', decision: 'skip' })
  recordDecision(db, { symbol: 'US30', stage: 'watchlist_override', decision: 'skip', reason: 'override_bias=skip' })
  assert.equal(recentDecisions(db, { symbol: 'EURUSD' }).length, 5)
  assert.equal(recentDecisions(db, { stage: 'watchlist_override' }).length, 1)
  assert.equal(recentDecisions(db, { symbol: 'EURUSD', limit: 2 }).length, 2)
})

test('recordDecision never throws — even on a closed db handle', () => {
  const db = fresh()
  db.close()
  assert.doesNotThrow(() => recordDecision(db, { stage: 'x', decision: 'skip' }))
  assert.equal(pruneDecisionLog(db), 0) // prune swallows too
})

test('pruneDecisionLog removes only rows past retention', () => {
  const db = fresh()
  recordDecision(db, { symbol: 'EURUSD', stage: 'style_filter', decision: 'skip' })
  db.prepare(`INSERT INTO decision_log (symbol, stage, decision, created_at) VALUES ('OLD', 's', 'skip', datetime('now', '-120 days'))`).run()
  assert.equal(pruneDecisionLog(db, 90), 1)
  const left = recentDecisions(db)
  assert.equal(left.length, 1)
  assert.equal(left[0].symbol, 'EURUSD')
})
