// node --test agent/services/capped-hybrid-status.test.js
// W3 — Claude · № 13,362 12-Oct (ordered after № 13,350, owner "W1 W2 W3 W4
// W11"; claude-builder). GET /state/capped-hybrid joins the hybrid pass's
// stored verdicts (the redacted readHybridVerdicts projection) to the open
// trades in scope. Real SQLite, the real route over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { cappedHybridStatus } from './capped-hybrid-status.js'

const A = '43097342', B = '46130058'
const SECRET = 'wsReconcile failed: token sk-live-abc123 at 10.0.0.7'
const AT = '2026-10-12T05:00:00.000Z', NOW = Date.parse(AT) + 45_000

function pass(over = {}) {
  return {
    at: AT, ok: true, activePlans: 1,
    cappedHybrid: {
      examined: 2,
      enrolled: [{ accountId: A, tradeId: 1, positionId: '501', trigger: 104.5, closeVolume: 50, runnerVolume: 50, brokerTarget: 110 }],
      excluded: [
        { accountId: A, tradeId: 2, positionId: '502', monitorId: 12, stage: 'ownership', observedAtMs: NOW - 5000, reason: 'strategy_not_momentum' },
        { accountId: A, tradeId: 3, positionId: '503', monitorId: 13, stage: 'ownership', observedAtMs: NOW - 5000, reason: 'monitor_paused' },
        { accountId: B, tradeId: 4, positionId: '504', monitorId: 14, stage: 'ownership', observedAtMs: NOW - 5000, reason: 'manual_account_not_authorised' },
      ],
      delegated: [{ accountId: A, tradeId: 8, positionId: '508', stage: 'existing_plan', observedAtMs: NOW - 5000, reason: 'existing_partial_plan', planState: 'ARMED' }],
      // Enrolment records budget deferrals and errors by trade only.
      deferred: [{ tradeId: 5, reason: 'enrolment_budget' }],
      errors: [{ tradeId: 6, reason: SECRET }],
      excludedTruncated: false, delegatedTruncated: false, excludedOmitted: 0, delegatedOmitted: 0,
      coverage: { limit: 128, openTradesSampled: 7, openTradesTruncated: false },
    },
    ...over,
  }
}

function seed(db) {
  const ins = db.prepare(`INSERT INTO trades (id, symbol, side, status, account_id, strategy, ctrader_position_id) VALUES (?, ?, ?, 'open', ?, ?, ?)`)
  ins.run(1, 'US500', 'BUY', A, 'donchian_breakout', '501')
  ins.run(2, 'NVDA.US', 'BUY', A, 'rsi_meanrev', '502')
  ins.run(3, 'XOM.US', 'BUY', A, 'tsmom_long', '503')
  ins.run(4, 'BTCUSD', 'SELL', B, 'manual', '504')
  ins.run(5, 'GER40', 'SELL', A, 'vwap_trend', '505')
  ins.run(6, 'JP225', 'BUY', A, 'ema_pullback', '506')
  ins.run(7, 'UK100', 'BUY', A, 'va_breakout', '507')
  ins.run(8, 'ETHUSD', 'BUY', A, 'tsmom_long', '508')
  db.prepare(`INSERT INTO trades (id, symbol, side, status, account_id, strategy, ctrader_position_id) VALUES (9, 'AAPL.US', 'BUY', 'closed', ?, 'vwap_trend', '509')`).run(A)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, side, entry_price, stop, entered_at, status) VALUES (3, ?, 'XOM.US', 'long', 100, 94, datetime('now'), 'open')`).run(A)
}

const byId = s => Object.fromEntries(s.positions.map(p => [p.tradeId, p]))

test('W3: one verdict per open trade in scope, joined from the stored pass', () => {
  const db = initDB(':memory:'); seed(db)
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass()))
  const s = cappedHybridStatus(db, { accountId: A, now: NOW })
  assert.equal(s.accountId, A); assert.equal(s.available, true); assert.equal(s.unavailableReason, null)
  assert.deepEqual(s.positions.map(p => p.tradeId), [1, 2, 3, 5, 6, 7, 8], 'open trades of this account only; the closed trade and the other account are out')
  const p = byId(s)
  assert.deepEqual([p[1].verdict, p[1].trigger, p[1].closeVolume, p[1].runnerVolume, p[1].brokerTarget], ['enrolled', 104.5, 50, 50, 110])
  assert.deepEqual([p[2].verdict, p[2].reason, p[2].symbol, p[2].strategy], ['excluded', 'strategy_not_momentum', 'NVDA.US', 'rsi_meanrev'])
  assert.deepEqual([p[3].verdict, p[3].reason, p[3].book], ['excluded', 'monitor_paused', true])
  assert.equal(p[2].book, false)
  assert.deepEqual([p[5].verdict, p[5].reason], ['deferred', 'enrolment_budget'], 'an accountless deferral is matched by trade id')
  assert.deepEqual([p[6].verdict, p[6].reason], ['error', 'unclassified_error_redacted'])
  assert.deepEqual([p[7].verdict, p[7].reason], ['not_in_last_pass', null])
  assert.deepEqual([p[8].verdict, p[8].planState], ['delegated', 'ARMED'])
  assert.deepEqual(s.counts, { enrolled: 1, excluded: 2, deferred: 1, error: 1, not_in_last_pass: 1, delegated: 1 })
  assert.deepEqual([s.pass.at, s.pass.ageMs, s.pass.ok, s.pass.activePlans, s.pass.examined], [AT, 45_000, true, 1, 2])
})

test('W3: no raw error text anywhere in the reply (redaction)', () => {
  const db = initDB(':memory:'); seed(db)
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass()))
  for (const accountId of [A, null]) {
    const text = JSON.stringify(cappedHybridStatus(db, { accountId, now: NOW }))
    for (const leak of ['sk-live', 'abc123', '10.0.0.7', 'wsReconcile']) assert.ok(!text.includes(leak), `${leak} leaked`)
  }
})

test('W3: every account when none is named, the other account\'s manual position included', () => {
  const db = initDB(':memory:'); seed(db)
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass()))
  const s = cappedHybridStatus(db, { now: NOW })
  assert.equal(s.accountId, 'all')
  assert.deepEqual(s.positions.map(p => p.tradeId), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual([byId(s)[4].verdict, byId(s)[4].reason], ['excluded', 'manual_account_not_authorised'])
})

test('W3: a missing or unreadable pass record is "not available" on every position, never an empty healthy list', () => {
  const db = initDB(':memory:'); seed(db)
  let s = cappedHybridStatus(db, { accountId: A, now: NOW })
  assert.equal(s.available, false); assert.equal(s.unavailableReason, 'missing'); assert.equal(s.pass, null)
  assert.equal(s.positions.length, 7, 'every open position is still listed')
  assert.ok(s.positions.every(p => p.verdict === 'not_available' && p.reason === 'missing'))
  assert.deepEqual(s.counts, { not_available: 7 })
  setState(db, 'momentum_partial_pass_json', '{not json')
  s = cappedHybridStatus(db, { accountId: A, now: NOW })
  assert.equal(s.unavailableReason, 'invalid_json'); assert.ok(s.positions.every(p => p.verdict === 'not_available'))
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: null })))
  s = cappedHybridStatus(db, { accountId: A, now: NOW })
  assert.equal(s.unavailableReason, 'hybrid_section_missing'); assert.ok(s.positions.every(p => p.verdict === 'not_available'))
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: { ...pass().cappedHybrid, unavailableReason: 'schema_unavailable' } })))
  s = cappedHybridStatus(db, { accountId: A, now: NOW })
  assert.equal(s.unavailableReason, 'schema_unavailable'); assert.ok(s.positions.every(p => p.verdict === 'not_available'))
})

test('W3: a position missing from a truncated record says so, not "not yet"', () => {
  const db = initDB(':memory:'); seed(db)
  const ch = pass().cappedHybrid
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: { ...ch, coverage: { ...ch.coverage, openTradesTruncated: true } } })))
  assert.deepEqual([byId(cappedHybridStatus(db, { accountId: A, now: NOW }))[7].verdict, byId(cappedHybridStatus(db, { accountId: A, now: NOW }))[7].reason], ['not_in_last_pass', 'record_truncated'])
})

test('W3: the enrolment\'s own outcome beats the observation sweep\'s "excluded" for the same trade', () => {
  // A manual trade the manual enrolment acted on is ALSO swept by the pass's
  // observation loop, which records it as excluded (capped-hybrid-enrolment.js).
  const db = initDB(':memory:'); seed(db)
  const ch = pass().cappedHybrid
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: { ...ch,
    enrolled: [...ch.enrolled, { accountId: A, tradeId: 7, positionId: '507', trigger: 120, closeVolume: 10, runnerVolume: 10, brokerTarget: 130 },
      // Trade 6 also has an accountless error row: the stronger own-account row wins.
      { accountId: A, tradeId: 6, positionId: '506', trigger: 33, closeVolume: 2, runnerVolume: 2, brokerTarget: 40 }],
    deferred: [...ch.deferred, { accountId: A, tradeId: 2, reason: 'manual_original_stop_missing' }],
    excluded: [...ch.excluded,
      { accountId: A, tradeId: 7, positionId: '507', stage: 'ownership', reason: 'candidate_not_selected' },
      { accountId: A, tradeId: 5, positionId: '505', stage: 'ownership', reason: 'candidate_not_selected' }],
  } })))
  const p = byId(cappedHybridStatus(db, { accountId: A, now: NOW }))
  assert.deepEqual([p[7].verdict, p[7].trigger], ['enrolled', 120])
  assert.deepEqual([p[2].verdict, p[2].reason], ['deferred', 'manual_original_stop_missing'])
  assert.deepEqual([p[5].verdict, p[5].reason], ['deferred', 'enrolment_budget'], 'an accountless deferral still beats an own-account observation')
  assert.deepEqual([p[6].verdict, p[6].trigger], ['enrolled', 33], 'an own-account enrolment beats an accountless error')
})

test('W3: a record row under another account never answers for the trade', () => {
  // Trade 7 is account A's now; a stale record lists it under B.
  const db = initDB(':memory:'); seed(db)
  const ch = pass().cappedHybrid
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: { ...ch,
    excluded: [...ch.excluded, { accountId: B, tradeId: 7, positionId: '507', stage: 'ownership', reason: 'momentum_book_owned' }] } })))
  for (const accountId of [A, null]) {
    const p = byId(cappedHybridStatus(db, { accountId, now: NOW }))
    assert.deepEqual([p[7].verdict, p[7].reason], ['not_in_last_pass', null], `scope ${accountId}`)
  }
})

test('W3 (Codex P2 on #1326): a legacy open trade with no account shows in every scoped view, as the positions table shows it', () => {
  const db = initDB(':memory:'); seed(db)
  db.prepare(`INSERT INTO trades (id, symbol, side, status, account_id, strategy, ctrader_position_id) VALUES (10, 'GER40', 'BUY', 'open', NULL, 'manual', '510')`).run()
  const ch = pass().cappedHybrid
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass({ cappedHybrid: { ...ch,
    excluded: [...ch.excluded, { accountId: null, tradeId: 10, positionId: '510', stage: 'ownership', reason: 'trade_identity_unverified' }] } })))
  for (const accountId of [A, B, null]) {
    const p = byId(cappedHybridStatus(db, { accountId, now: NOW }))
    assert.deepEqual([p[10]?.verdict, p[10]?.reason, p[10]?.accountId], ['excluded', 'trade_identity_unverified', null], `scope ${accountId}`)
  }
})

test('W3: read-only — no write statement is prepared', () => {
  const db = initDB(':memory:'); seed(db)
  setState(db, 'momentum_partial_pass_json', JSON.stringify(pass()))
  const prepare = db.prepare
  db.prepare = sql => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)) throw Error(`write: ${sql}`); return prepare.call(db, sql) }
  try { cappedHybridStatus(db, { accountId: A, now: NOW }); cappedHybridStatus(db, { now: NOW }) } finally { db.prepare = prepare }
})

test('W3: an invalid account is refused before any read', () => {
  const db = initDB(':memory:')
  for (const bad of ['abc', '0123', '1; DROP TABLE trades', '']) assert.throws(() => cappedHybridStatus(db, { accountId: bad }), RangeError, bad)
})

async function server(t, db) {
  const app = express(); app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const x = app.listen(0, '127.0.0.1', () => resolve(x)) })
  t.after(async () => { s.closeAllConnections(); await new Promise(r => s.close(r)) })
  return p => `http://127.0.0.1:${s.address().port}/state/capped-hybrid${p}`
}

test('W3 route: GET /state/capped-hybrid scopes by ?account=, no-store; a bad account is a 400', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'capped-hybrid-route-')), db = initDB(join(dir, 'agent.db'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  seed(db); setState(db, 'momentum_partial_pass_json', JSON.stringify(pass()))
  const url = await server(t, db)
  let res = await fetch(url(`?account=${A}`))
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  let j = await res.json()
  assert.equal(j.accountId, A); assert.equal(j.positions.length, 7)
  assert.equal(j.verdicts.momentum_partial_pass_json.available, true, 'the redacted projection rides along')
  j = await (await fetch(url('?account=all'))).json()
  assert.equal(j.accountId, 'all'); assert.equal(j.positions.length, 8)
  res = await fetch(url('?account=abc'))
  assert.equal(res.status, 400); assert.equal((await res.json()).code, 'capped_hybrid_invalid_account')
})
