// node --test agent/services/loss-guardian.test.js
//
// Loss Guardian: conservative loss-side safety net. Protects NAKED positions
// and enforces an optional time cap; never touches a valid mean-reversion stop.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideLossGuardian, loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN } from './loss-guardian.js'

const CFG = { ...DEFAULT_LOSS_GUARDIAN }

test('defaults: on, scope all; saved values merge; explicit off wins', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadLossGuardianConfig(db), DEFAULT_LOSS_GUARDIAN)
  assert.equal(DEFAULT_LOSS_GUARDIAN.on, true)
  setState(db, 'loss_guardian_json', JSON.stringify({ on: false }))
  assert.equal(loadLossGuardianConfig(db).on, false)
  setState(db, 'loss_guardian_json', JSON.stringify({ maxHoldHours: 12 }))
  assert.equal(loadLossGuardianConfig(db).maxHoldHours, 12)
  assert.equal(loadLossGuardianConfig(db).on, true) // default preserved
})

test('a position that already HAS a stop is never touched (respect the plan)', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 96, currentSl: 94, atr: 1, digits: 2, ageHours: 20 })
  assert.equal(d.action, null)
})

test('naked long, still inside the cap → protective stop at maxAtrMult×ATR from entry', () => {
  // dist = 3 × 1 = 3 → SL at 97; price 98.5 is above it → set the stop
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 98.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 97)
  assert.match(d.reason, /protective stop/)
})

test('naked short, still inside → protective stop above entry', () => {
  const d = decideLossGuardian(CFG, { side: 'SELL', entry: 100, price: 101.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 103) // 100 + 3×1
})

test('naked position already beyond max loss → close, do not set an unreachable stop', () => {
  // dist 3 → level 97; price 95 is BELOW it (long already blown through) → close
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 95, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /beyond max loss/)
})

test('ATR unavailable → falls back to fallbackAdversePct of entry', () => {
  // 2% of 100 = 2 → SL at 98; price 99 above → set
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 99, currentSl: null, atr: null, digits: 2, ageHours: 1 })
  assert.equal(d.action.sl, 98)
})

test('time cap breached → close even if a stop exists', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 99, currentSl: 95, atr: 1, digits: 2, ageHours: 12 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /time_cap/)
})

test('time cap off by default → a stopped position inside the cap holds', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 90, currentSl: 88, atr: 1, digits: 2, ageHours: 200 })
  assert.equal(d.action, null) // maxHoldHours null → never time-cap; has a stop → untouched
})

test('position with its OWN time_cap_at → guardian time cap defers (hardening 6d)', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  // Same breach as the close case above, but the position-manager owns this
  // position's clock — the guardian must not close it early.
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 99, currentSl: 95, atr: 1, digits: 2, ageHours: 12, hasOwnTimeCap: true })
  assert.equal(d.action, null)
})

test('own time cap defers ONLY the time cap — naked-position protection still applies', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 98.5, currentSl: null, atr: 1, digits: 2, ageHours: 12, hasOwnTimeCap: true })
  assert.equal(d.action.sl, 97) // protective stop still placed
})

test('Wave 2 (§K·6): the loss guardian skips a momentum-book row (no time_cap_at → its maxHoldHours backstop would otherwise reach a weeks-horizon runner) and counts it', async () => {
  const { runLossGuardian } = await import('./loss-guardian.js')
  const db = initDB(':memory:')
  setState(db, 'loss_guardian_json', JSON.stringify({ on: true, scope: 'all', maxHoldHours: 1 }))
  db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, account_id, opened_at) VALUES ('NATGAS', 'BUY', '9101', 'open', '1', datetime('now', '-3 days'))`).run()
  const tradeId = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id = '9101'`).get().id
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status, source, trade_id, account_id, created_at) VALUES ('NATGAS', 'long', 2.9, 2.7, 'active', 'autopilot', ?, '1', datetime('now', '-3 days'))`).run(tradeId)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, status, note, entered_at) VALUES (?, '1', 'NATGAS', '9101', 'open', 'test', datetime('now', '-3 days'))`).run(tradeId)
  const closes = []
  const out = await runLossGuardian(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, {
    exec: { reconcile: async () => ({ position: [{ positionId: 9101, price: 2.9, stopLoss: 2.7, tradeData: { symbolId: 1, volume: 10000, tradeSide: 1 } }] }), closePosition: async (...a) => { closes.push(a); return { ok: true } } },
    ws: { wsGetLastCloses: async () => ({ 1: 2.85 }), wsGetTrendbarsBatch: async () => ({}) },
    sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
    notify: () => {},
  })
  assert.equal(out.bookSkipped, 1, 'the book row is named as skipped')
  assert.equal(out.checked, 0)
  assert.deepEqual(closes, [], 'nothing was closed')
})
