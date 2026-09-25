// node --test agent/services/trade-guard.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { decideGuardActions, roundToDigits } from './trade-guard.js'

const PIP = 0.0001

test('break-even: fires once trigger pips reached, SL to entry + offset (long)', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0950, price: 1.1015, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.ok(Math.abs(out.moveSlTo - 1.1003) < 1e-9, `got ${out.moveSlTo}`)
  assert.equal(out.beMoved, true)
})

test('break-even: does not fire below trigger', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0950, price: 1.1014, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.equal(out.moveSlTo, null)
})

test('break-even: never re-fires after be_moved', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.1003, price: 1.1050, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: true,
  })
  assert.equal(out.moveSlTo, null)
})

test('break-even short: SL to entry MINUS offset', () => {
  const out = decideGuardActions({
    side: 'short', entryPrice: 1.1000, currentSl: 1.1050, price: 1.0985, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.ok(Math.abs(out.moveSlTo - 1.0997) < 1e-9, `got ${out.moveSlTo}`)
})

test('break-even: skipped when current SL is already tighter', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.1010, price: 1.1020, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.equal(out.moveSlTo, null)
})

test('trailing: SL follows price at distance, tighten only (long)', () => {
  const guard = { trailing: { on: true, distancePips: 10 } }
  const up = decideGuardActions({ side: 'long', entryPrice: 1.1000, currentSl: 1.0990, price: 1.1050, pipSize: PIP, guard, beMoved: false })
  assert.ok(Math.abs(up.moveSlTo - 1.1040) < 1e-9, `got ${up.moveSlTo}`)
  // Price falls back — target SL would be LOOSER than current: no move.
  const down = decideGuardActions({ side: 'long', entryPrice: 1.1000, currentSl: 1.1040, price: 1.1030, pipSize: PIP, guard, beMoved: false })
  assert.equal(down.moveSlTo, null)
})

test('trailing short: tighten means SL moves DOWN', () => {
  const guard = { trailing: { on: true, distancePips: 10 } }
  const out = decideGuardActions({ side: 'SELL', entryPrice: 1.1000, currentSl: 1.1020, price: 1.0950, pipSize: PIP, guard, beMoved: false })
  assert.ok(Math.abs(out.moveSlTo - 1.0960) < 1e-9, `got ${out.moveSlTo}`)
})

test('trailing beats break-even when it is tighter', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0990, price: 1.1060, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 }, trailing: { on: true, distancePips: 10 } },
    beMoved: false,
  })
  // BE target 1.1003, trailing target 1.1050 — trailing wins, still counts as BE done
  assert.ok(Math.abs(out.moveSlTo - 1.1050) < 1e-9, `got ${out.moveSlTo}`)
  assert.equal(out.beMoved, true)
})

test('partial take-profits: crossed levels close their lots, done levels skipped', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: null, price: 1.1080, pipSize: PIP,
    guard: { takeProfits: [
      { price: 1.1050, lots: 0.3, done: false },
      { price: 1.1070, lots: 0.3, done: true },   // already executed
      { price: 1.1100, lots: 0.4, done: false },  // not reached
    ] },
    beMoved: false,
  })
  assert.deepEqual(out.closes, [{ index: 0, lots: 0.3, price: 1.1050 }])
})

test('partial take-profits short: crossed means price AT OR BELOW level', () => {
  const out = decideGuardActions({
    side: 'short', entryPrice: 2.90, currentSl: null, price: 2.79, pipSize: 0.001,
    guard: { takeProfits: [{ price: 2.793, lots: 0.5, done: false }] }, beMoved: false,
  })
  assert.equal(out.closes.length, 1)
})

test('no guard / missing inputs → no actions', () => {
  assert.deepEqual(decideGuardActions({ side: 'long', entryPrice: 1.1, currentSl: null, price: 1.2, pipSize: PIP, guard: null, beMoved: false }),
    { moveSlTo: null, beMoved: false, closes: [] })
  assert.deepEqual(decideGuardActions({ side: 'long', entryPrice: 1.1, currentSl: null, price: null, pipSize: PIP, guard: { trailing: { on: true, distancePips: 5 } }, beMoved: false }).moveSlTo, null)
})

test('roundToDigits clamps to symbol precision', () => {
  assert.equal(roundToDigits(1.234567, 5), 1.23457)
  assert.equal(roundToDigits(2.8795001, 3), 2.88)
})

// fix-the-exits BA (18-09-2026): a partial take-profit is journalled as a
// scale_out — NOT a close — so the reconciler can neither miss it nor blame
// the guard for the SL fill that ends the position later.
test('BA: runTradeGuards journals a partial take-profit as scale_out with the position, trade and account', async () => {
  const { initDB, setState } = await import('../db.js')
  const { runTradeGuards } = await import('./trade-guard.js')
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id)
     VALUES ('EURUSD', 'BUY', 1.1000, 0.02, '7', 'autopilot', 'open', datetime('now'), '42')`).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id, guard_json)
     VALUES ('EURUSD', ?, 'long', 1.1000, 1.0950, null, 't', 1, 'autopilot', 'active', '42', ?)`)
    .run(tradeId, JSON.stringify({ takeProfits: [{ price: 1.1020, lots: 0.01 }] }))
  const closed = []
  const summary = await runTradeGuards(db, { accountId: '42', host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't' }, {
    exec: {
      reconcile: async () => ({ position: [{ positionId: 7, price: 1.1000, stopLoss: 1.0950 }] }),
      closePosition: async (_c, args) => { closed.push(args) },
      amendPosition: async () => {},
    },
    ws: { wsGetLastCloses: async () => ({ 1: 1.1025 }) },
    sizing: { getVolumeMeta: async () => ({ pipPosition: 4, digits: 5, lotSize: 100000 }) },
    notify: () => {},
  })
  assert.equal(summary.partialCloses, 1, JSON.stringify(summary))
  assert.equal(closed.length, 1); assert.equal(closed[0].volume, 1000)
  const ev = db.prepare(`SELECT account_id, position_id, trade_id, kind, source, reason, to_value, price_at FROM position_events`).all()
  assert.equal(ev.length, 1, JSON.stringify(ev))
  assert.equal(ev[0].kind, 'scale_out', 'a partial is not a close')
  assert.equal(ev[0].source, 'trade_guard'); assert.equal(ev[0].position_id, '7'); assert.equal(ev[0].trade_id, tradeId); assert.equal(ev[0].account_id, '42')
  assert.equal(ev[0].to_value, 0.01); assert.equal(ev[0].price_at, 1.1025)
  assert.match(ev[0].reason, /^partial take-profit TP1: closed 0\.01 lot\(s\)$/)
})

test('V3 M5: the guard\'s trailing stop move is timed in the amend-latency ring, payload unchanged', async () => {
  const { initDB, setState } = await import('../db.js')
  const { runTradeGuards } = await import('./trade-guard.js')
  const { _resetAmendLatencyForTests, _amendLatencyStateForTests } = await import('./protection-latency.js')
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id)
     VALUES ('EURUSD', 'BUY', 1.1000, 0.02, '8', 'autopilot', 'open', datetime('now'), '42')`).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id, guard_json)
     VALUES ('EURUSD', ?, 'long', 1.1000, 1.0950, 1.1200, 't', 1, 'autopilot', 'active', '42', ?)`)
    .run(tradeId, JSON.stringify({ trailing: { on: true, distancePips: 5 } }))
  const sent = []
  const summary = await runTradeGuards(db, { accountId: '42', host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't' }, {
    exec: {
      reconcile: async () => ({ position: [{ positionId: 8, price: 1.1000, stopLoss: 1.0950, takeProfit: 1.1200 }] }),
      closePosition: async () => ({}),
      amendPosition: async (_c, args) => { sent.push(args); return { executionType: 'ORDER_REPLACED' } },
    },
    ws: { wsGetLastCloses: async () => ({ 1: 1.1025 }) },
    sizing: { getVolumeMeta: async () => ({ pipPosition: 4, digits: 5, lotSize: 100000 }) },
    notify: () => {},
  })
  assert.equal(summary.slMoves, 1, JSON.stringify(summary))
  assert.equal(sent[0].takeProfit, 1.12, 'the broker target is re-sent, as before')
  const { amends } = _amendLatencyStateForTests()
  assert.equal(amends.length, 1, 'one amend sent, one amend timed')
  assert.deepEqual([amends[0].path, amends[0].source, amends[0].positionId, amends[0].account, amends[0].outcome],
    ['trade_guard', 'trade_guard', '8', '…42', 'ok'])
})
