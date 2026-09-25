// node --test agent/services/decision-log.test.js
//
// 3A decision provenance: recording never throws, rows stamp the account,
// filters work, retention prunes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { recordDecision, recentDecisions, pruneDecisionLog, ATTRIBUTION_MARKED_STAGES, ACCOUNT_ATTRIBUTION_MARK, ROSTER_ONLY_STAGES, ROSTER_STAGES } from './decision-log.js'
import { REGIME_BLOCK_STAGE } from './gate-skips.js'

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'ACC1')
  return db
}

// V3 WEB-1 (8,989-A row 2): this test used to read "stamps the selected
// account by default" and pinned the defect — every roster-level stop was
// charged to whichever account the dashboard had selected (9,970 of 9,970
// upstream stops on one account in 24 h). An unnamed account is NULL now,
// which is what the module header always said.
test('recordDecision never stamps the selected account: no named account is NULL, an explicit id wins', () => {
  const db = fresh()
  recordDecision(db, { symbol: 'EURUSD', timeframe: '1h', strategy: 'rsi2_reversion', stage: 'armed_scope_prefilter', decision: 'skip', reason: 'no armed timeframe' })
  recordDecision(db, { accountId: 'ACC2', symbol: 'XAUUSD', stage: 'style_filter', decision: 'skip', reason: 'all_styles_disabled', detail: { styles: {} } })
  const rows = recentDecisions(db)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].symbol, 'XAUUSD') // newest first
  assert.equal(rows[0].account_id, 'ACC2')
  assert.deepEqual(JSON.parse(rows[0].detail_json), { styles: {} }, 'an unmarked stage keeps the caller\'s detail exactly')
  assert.equal(rows[1].account_id, null, 'RED if the selected-account fallback (ACC1) comes back')
  assert.equal(rows[1].stage, 'armed_scope_prefilter')
  assert.equal(rows[1].decision, 'skip')
})

test('V3 WEB-1: a stage_matrix or lesson_decay row written WITH an account carries the attribution mark; without one it carries none', () => {
  const db = fresh()
  recordDecision(db, { accountId: 'ACC2', symbol: 'EURUSD', stage: 'stage_matrix', decision: 'skip', reason: 'off' })
  recordDecision(db, { accountId: 'ACC2', symbol: 'EURUSD', stage: 'lesson_decay', decision: 'skip', reason: 'alpha_decay_cooloff', detail: { edge: 'x' } })
  recordDecision(db, { symbol: 'EURUSD', stage: 'stage_matrix', decision: 'skip', reason: 'off everywhere' })
  const rows = recentDecisions(db, { limit: 10 }).reverse()
  assert.deepEqual(JSON.parse(rows[0].detail_json), { attribution: ACCOUNT_ATTRIBUTION_MARK })
  assert.deepEqual(JSON.parse(rows[1].detail_json), { edge: 'x', attribution: ACCOUNT_ATTRIBUTION_MARK }, 'the caller\'s detail is kept, the mark added')
  assert.equal(rows[2].account_id, null); assert.equal(rows[2].detail_json, null, 'the roster union\'s row is not marked as an account\'s')
  assert.deepEqual([...ATTRIBUTION_MARKED_STAGES].sort(), ['lesson_decay', 'stage_matrix'])
  assert.equal(ROSTER_ONLY_STAGES.includes(REGIME_BLOCK_STAGE), true, 'the literal matches gate-skips.js')
  assert.equal(ROSTER_STAGES.includes('stage_matrix') && !ROSTER_ONLY_STAGES.includes('stage_matrix'), true, 'stage_matrix has a per-account writer too')
})

test('V3 WEB-1 wiring (comments stripped): the lesson_decay skip in autoTrade names the order\'s account; the roster stage gate names none', () => {
  // autoTrade has no injection point short of a live broker order, so the
  // call site is pinned on source — the last resort, with comments removed.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /recordDecision\(db, \{ accountId: String\(accountId\), symbol, timeframe: synth\.timeframe, strategy: synth\.strategy, stage: 'lesson_decay'/,
    'RED if the lesson_decay row goes back to naming no account (the selected-account fallback wrote it)')
  const roster = src.indexOf('const gate = anyAccountTradeGate(db, getState, {')
  assert.ok(roster > 0)
  const call = src.slice(src.indexOf('recordDecision(db, {', roster), src.indexOf('})', src.indexOf('recordDecision(db, {', roster)))
  assert.match(call, /stage: 'stage_matrix'/)
  assert.doesNotMatch(call, /accountId/, 'the roster union is roster-wide: no single account')
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

test('forensics columns exist on trades and accept a collect-forward row', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, opened_at,
      slippage_price, spread_at_entry, entry_latency_ms, rvol_open, vwap_side_open, commission, swap)
    VALUES ('EURUSD', 'BUY', 1.1, 'open', datetime('now'), 0.00012, 0.00008, 342, 1.4, 'above', -0.7, -0.12)
  `).run()
  const row = db.prepare(`SELECT * FROM trades`).get()
  assert.equal(row.vwap_side_open, 'above')
  assert.equal(row.entry_latency_ms, 342)
  assert.equal(row.rvol_open, 1.4)
  // Historical rows keep NULLs — the UI shows "—", never fabricated numbers.
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at) VALUES ('US30','SELL',40000,'open',datetime('now'))`).run()
  const old = db.prepare(`SELECT slippage_price, vwap_side_open FROM trades WHERE symbol='US30'`).get()
  assert.equal(old.slippage_price, null)
  assert.equal(old.vwap_side_open, null)
})
