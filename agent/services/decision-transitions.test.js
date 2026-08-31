// node --test agent/services/decision-transitions.test.js
//
// Invariant 1 (owner, 31-08-2026): every decision is logged — including the
// ones that previously left no trace (fast-monitor skips, pending-order
// gate skips, and the dispatch 'proceed' that made decision_log a log of
// negatives only). The load-bearing property is the TRANSITION GATE: one
// row per state change, never one per tick — a row per 30s tick is the
// 32k-identical-rows noise shape, and noise is how an owner tunes out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { noteFastDecision, _resetFastDecisionStateForTests } from './fast-monitor.js'
import { managePendingOrders, _resetPendingDecisionStateForTests } from './pending-orders.js'

const rows = (db) => db.prepare(`SELECT stage, decision, reason FROM decision_log ORDER BY id`).all()

test('fast-monitor: one row per state CHANGE, recovery row on return, quiet first sight', () => {
  _resetFastDecisionStateForTests()
  const db = initDB(':memory:')
  const pos = { id: 7, account_id: '111', symbol: 'EURUSD', strategy: 'vwap_trend' }

  // First sight in the NORMAL state: no row — nothing changed worth saying.
  noteFastDecision(db, pos, 'active')
  assert.equal(rows(db).length, 0)

  // Entering a skip state writes ONE row; repeating it writes none.
  noteFastDecision(db, pos, 'no_quote', 'EURUSD: no quote — checks paused')
  noteFastDecision(db, pos, 'no_quote', 'EURUSD: no quote — checks paused')
  noteFastDecision(db, pos, 'no_quote', 'EURUSD: no quote — checks paused')
  let r = rows(db)
  assert.equal(r.length, 1)
  assert.equal(r[0].decision, 'skip')
  assert.equal(r[0].stage, 'fast_monitor')

  // Recovery writes exactly one 'proceed' naming what it recovered from.
  noteFastDecision(db, pos, 'active')
  noteFastDecision(db, pos, 'active')
  r = rows(db)
  assert.equal(r.length, 2)
  assert.equal(r[1].decision, 'proceed')
  assert.match(r[1].reason, /was: no_quote/)
})

test('pending-orders: the fib gate skip is durable, once per transition, with a clear row', async () => {
  _resetPendingDecisionStateForTests()
  const db = initDB(':memory:')
  setState(db, 'pending_matrix_json', JSON.stringify({ EURUSD: ['4h'] }))
  setState(db, 'pending_mode_enabled', 'true')
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend'])) // fib OFF
  const deps = {
    exec: { reconcile: async () => ({ order: [], position: [] }), placeOrder: async () => ({ order: { orderId: 1 } }), cancelOrder: async () => ({ ok: true }) },
    scan: async () => ({ setups: [], lastClose: {}, errors: [] }),
    risk: { loadRiskConfig: () => ({ minLotSize: 0.01 }), evaluateTrade: () => ({ approved: true }), persistRiskEvent: () => {} },
    sizing: { getVolumeMeta: async () => ({ lotSize: 100000, minVolume: 1000 }), lotsToVolume: (l, m) => ({ volume: l * m.lotSize, belowMin: false }) },
  }
  const creds = { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '123' }

  await managePendingOrders(db, creds, { EURUSD: 1 }, deps)
  await managePendingOrders(db, creds, { EURUSD: 1 }, deps)
  let skips = rows(db).filter(x => x.stage === 'pending_orders')
  assert.equal(skips.length, 1, 'two identical passes must write ONE skip row')
  assert.match(skips[0].reason, /fib_618_fade not trade-armed/)

  // Arming fib clears the gate: one 'proceed' row, then silence again.
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade']))
  await managePendingOrders(db, creds, { EURUSD: 1 }, deps)
  await managePendingOrders(db, creds, { EURUSD: 1 }, deps)
  skips = rows(db).filter(x => x.stage === 'pending_orders')
  assert.equal(skips.length, 2)
  assert.equal(skips[1].decision, 'proceed')
})

test('wiring pins: dispatch writes a proceed row; the monitors call their note helpers', () => {
  // decision_log recorded ONLY the negative — account-engineering.js said so
  // outright. The proceed write must sit ON the dispatch path (beside the
  // write-ahead intent row), and the monitors' skip branches must call the
  // transition helpers, or invariant 1 quietly regresses to negatives-only.
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.ok(loop.includes("stage: 'dispatch', decision: 'proceed'"), 'dispatch proceed row missing from loop.js')
  const fast = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8')
  for (const want of ["noteFastDecision(db, pos, 'manage_off'", "noteFastDecision(db, pos, 'symbol_unmapped'", "noteFastDecision(db, pos, 'no_quote'", "noteFastDecision(db, pos, 'active')"]) {
    assert.ok(fast.includes(want), `fast-monitor missing transition call: ${want}`)
  }
  const pend = readFileSync(new URL('./pending-orders.js', import.meta.url), 'utf8')
  assert.ok(pend.includes("notePendingDecision(db, creds?.accountId, `fib_gate:"), 'pending fib-gate transition call missing')
})
