// node --test agent/services/excursion-exit-side.test.js
//
// Claude · № 13,923 13-Oct (owner: audit fix "4 MAE/MFE exit side", and
// "Yes, touch loop.js"; claude-builder).
//
// MAE and MFE were measured at the MID price. A position can only be closed
// at its exit side: a long sells at the bid, a short buys at the ask. On
// 13-10 JPYX quoted 690.6 / 691.6 against a 2.3-point stop, so the mid
// overstated a short's best excursion and understated its worst by about
// 0.22R. The exit side now feeds MAE/MFE; every decision keeps the mid.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { evaluatePosition, exitSidePrice } from './position-manager.js'
import { runFastMonitor } from './fast-monitor.js'
import { heldPositionExitPrice, heldPositionPrice } from './held-prices.js'
import { runMonitorPhase } from '../loop.js'

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`)

test('exitSidePrice: the bid for a long, the ask for a short, in every side spelling; unknown is null', () => {
  for (const s of ['long', 'BUY', 'buy']) assert.equal(exitSidePrice(s, 1.1005, 1.1007), 1.1005, s)
  for (const s of ['short', 'SELL', 'sell']) assert.equal(exitSidePrice(s, 1.1005, 1.1007), 1.1007, s)
  assert.equal(exitSidePrice('flat', 1, 2), null)
  assert.equal(exitSidePrice('long', null, 2), null)
  assert.equal(exitSidePrice('short', 1, 0), null)
})

test('evaluatePosition: MAE/MFE follow the excursion price; the decision price is unchanged', () => {
  const pos = { id: 1, symbol: 'JPYX', side: 'short', entry_price: 689.8, current_sl: 692.1, current_tp: 685.1, initial_risk: 2.3, mfe_r: 0, mae_r: 0, created_at: new Date().toISOString() }
  const mid = 689.3, ask = 689.8 // the mid shows +0.22R; the ask the short buys back at shows 0
  const withExit = evaluatePosition(pos, { currentPrice: mid, excursionPrice: ask })
  near(withExit.updates.mfe_r, 0, 'MFE at the exit side')
  const midOnly = evaluatePosition(pos, { currentPrice: mid })
  near(midOnly.updates.mfe_r, (689.8 - 689.3) / 2.3, 'without an exit price, the mid as before')
  assert.equal(withExit.action, midOnly.action, 'the decision is the same')
})

test('fast monitor: a long\'s MFE is measured at the bid, a short\'s at the ask', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, created_at)
    VALUES ('EURUSD', ?, ?, ?, ?, 0.0050, 'active', 'autopilot', 'fib_618_fade', datetime('now'))`)
  const longId = ins.run('BUY', 1.1000, 1.0950, 1.1200).lastInsertRowid
  const deps = { ws: { wsGetTrendbarsBatch: async () => ({ '1m': [] }), wsGetSpotOnce: async () => ({ bid: 1.1005, ask: 1.1007 }) }, now: () => Date.now() }
  await runFastMonitor(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, deps)
  near(db.prepare('SELECT mfe_r FROM monitored_positions WHERE id = ?').get(longId).mfe_r, (1.1005 - 1.1000) / 0.005, 'RED before: the mid gave 0.12R; the bid gives 0.10R')
  db.prepare('DELETE FROM monitored_positions').run()
  const shortId = ins.run('SELL', 1.1010, 1.1060, 1.0900).lastInsertRowid
  await runFastMonitor(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, deps)
  near(db.prepare('SELECT mfe_r FROM monitored_positions WHERE id = ?').get(shortId).mfe_r, (1.1010 - 1.1007) / 0.005, 'the ask the short buys back at')
})

test('slow monitor phase: MAE/MFE follow the exit-side price it is given', async () => {
  const db = initDB(':memory:')
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status)
    VALUES ('SYM', 'long', 100, 99, 110, 'x', 1, 'external', 'active')`).run().lastInsertRowid
  const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
  const s = {
    updatePositionMetrics: db.prepare('UPDATE monitored_positions SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ? WHERE id = ?'),
    updatePositionCheck: db.prepare('UPDATE monitored_positions SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ? WHERE id = ?'),
    stampPositionExitMarks: db.prepare('UPDATE monitored_positions SET time_cap_trail_at = COALESCE(time_cap_trail_at, ?), bank_partial_at = COALESCE(bank_partial_at, ?) WHERE id = ?'),
  }
  // Mid 100.5 (+0.5R); the bid a long sells at is 100.3 (+0.3R).
  await runMonitorPhase(db, s, [pos], () => 100.5, null, () => true, { excursionPriceOf: () => 100.3 })
  near(db.prepare('SELECT mfe_r FROM monitored_positions WHERE id = ?').get(id).mfe_r, 0.3, 'RED before: the mid gave 0.5R')
})

test('heldPositionExitPrice: the same validated quote as heldPositionPrice, at the exit side', () => {
  const now = () => 1_800_000_000_000
  const pos = { account_id: '7', symbol: 'EURUSD', side: 'long', created_at: '2026-01-01 00:00:00' }
  const q = { ctidTraderAccountId: 7, symbolId: 1, timestamp: now() - 1000, bid: 110050, ask: 110070 }
  const receipts = new Map([['7|EURUSD', { accountId: '7', symbol: 'EURUSD', symbolId: '1', quote: q }]])
  near(heldPositionPrice(pos, receipts, { now }), 1.1006, 'mid unchanged')
  near(heldPositionExitPrice(pos, receipts, { now }), 1.1005, 'the bid for a long')
  near(heldPositionExitPrice({ ...pos, side: 'short' }, receipts, { now }), 1.1007, 'the ask for a short')
  assert.equal(heldPositionExitPrice({ ...pos, account_id: '8' }, receipts, { now }), null, 'an unvalidated quote is null, as for the mid')
})
