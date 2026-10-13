// node --test agent/services/excursion-exit-side.test.js
//
// Claude · № 13,923 13-Oct (owner: audit fix "4 MAE/MFE exit side", and
// "Yes, touch loop.js"; claude-builder).
//
// MAE and MFE were measured at the MID price. A position can only be closed
// at its exit side: a long sells at the bid, a short buys at the ask. On
// 13-10 JPYX quoted 690.6 / 691.6 against a 2.3-point stop, so the mid
// overstated a short's best excursion and understated its worst by about
// 0.22R. Codex round 2 on #1356 (owner: "Separate columns"): mfe_r feeds the
// managed trail (managedPeakR), so mfe_r/mae_r stay on the mid — no live
// management change — and the exit side is recorded in mfe_exit_r /
// mae_exit_r beside them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordExitExcursion } from './exit-excursion.js'
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

test('evaluatePosition is unchanged: mfe_r/mae_r and every decision stay on the caller\'s price (the managed trail reads mfe_r)', () => {
  const pos = { id: 1, symbol: 'JPYX', side: 'short', entry_price: 689.8, current_sl: 692.1, current_tp: 685.1, initial_risk: 2.3, mfe_r: 0, mae_r: 0, created_at: new Date().toISOString() }
  const mid = 689.3, ask = 689.8
  const a = evaluatePosition(pos, { currentPrice: mid, excursionPrice: ask })
  const b = evaluatePosition(pos, { currentPrice: mid })
  near(a.updates.mfe_r, (689.8 - 689.3) / 2.3, 'mfe_r on the mid')
  assert.deepEqual(a.updates, b.updates, 'an excursionPrice changes nothing in the evaluator')
  assert.equal(a.action, b.action); assert.equal(a.newSL ?? null, b.newSL ?? null)
})

test('recordExitExcursion: widens only, marks when tracking began, ignores an unknown price', () => {
  const db = initDB(':memory:')
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, initial_risk, status, source)
    VALUES ('SYM', 'long', 100, 99, 1, 'active', 'external')`).run().lastInsertRowid
  const row = () => db.prepare('SELECT mfe_exit_r, mae_exit_r, exit_excursion_from FROM monitored_positions WHERE id = ?').get(id)
  const pos = { id, side: 'long', entry_price: 100, initial_risk: 1 }
  assert.equal(recordExitExcursion(db, pos, null), false)
  assert.equal(row().exit_excursion_from, null)
  assert.ok(recordExitExcursion(db, pos, 100.4, { now: 1000 }))
  assert.ok(recordExitExcursion(db, pos, 99.7, { now: 2000 }))
  assert.ok(recordExitExcursion(db, pos, 100.2, { now: 3000 }))
  const r = row()
  near(r.mfe_exit_r, 0.4, 'the best exit-side reading stays'); near(r.mae_exit_r, -0.3, 'the worst stays')
  assert.equal(r.exit_excursion_from, new Date(1000).toISOString(), 'the first recording time is kept')
})

test('fast monitor: mfe_r stays on the mid; the exit side (bid for a long, ask for a short) goes to mfe_exit_r', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, created_at)
    VALUES ('EURUSD', ?, ?, ?, ?, 0.0050, 'active', 'autopilot', 'fib_618_fade', datetime('now'))`)
  const longId = ins.run('BUY', 1.1000, 1.0950, 1.1200).lastInsertRowid
  const deps = { ws: { wsGetTrendbarsBatch: async () => ({ '1m': [] }), wsGetSpotOnce: async () => ({ bid: 1.1005, ask: 1.1007 }) }, now: () => Date.now() }
  const creds = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }
  await runFastMonitor(db, creds, deps)
  let r = db.prepare('SELECT mfe_r, mfe_exit_r FROM monitored_positions WHERE id = ?').get(longId)
  near(r.mfe_r, (1.1006 - 1.1000) / 0.005, 'mfe_r on the mid, as before (0.12R)')
  near(r.mfe_exit_r, (1.1005 - 1.1000) / 0.005, 'the bid a long sells at (0.10R)')
  db.prepare('DELETE FROM monitored_positions').run()
  const shortId = ins.run('SELL', 1.1010, 1.1060, 1.0900).lastInsertRowid
  await runFastMonitor(db, creds, deps)
  r = db.prepare('SELECT mfe_r, mfe_exit_r FROM monitored_positions WHERE id = ?').get(shortId)
  near(r.mfe_r, (1.1010 - 1.1006) / 0.005, 'mfe_r on the mid')
  near(r.mfe_exit_r, (1.1010 - 1.1007) / 0.005, 'the ask the short buys back at')
})

test('slow monitor phase: mfe_r on the mid; the exit-side price it is given goes to mfe_exit_r', async () => {
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
  const r = db.prepare('SELECT mfe_r, mfe_exit_r FROM monitored_positions WHERE id = ?').get(id)
  near(r.mfe_r, 0.5, 'mfe_r on the mid, unchanged')
  near(r.mfe_exit_r, 0.3, 'the exit side in its own column')
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
