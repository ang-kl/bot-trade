// node --test agent/services/ws05-reflection.test.js
//
// §70.1 (WS-05 as an independent workstream) and §70.10 (management history
// connected to reflection).
//
// Both exist for the same reason: the parts were all running and nothing could
// be ASKED about them as a whole. WS-05's own audit line was "partially
// source-traceable; needs runtime precedence", and P10's position_events had
// been recording every stop move for weeks with no reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { LAYERS, members, ws05Health, memberControllers, WS05 } from './workstream-ws05.js'
import { CONTROLLERS, beat } from './heartbeat.js'
import { recordPositionEvent } from './position-events.js'
import { managementNarrative, managementObservations, MIN_SAMPLE } from './management-reflection.js'
import { AUTHORITIES } from './management-state.js'

// ---------------------------------------------------------------------------
// WS-05 as a workstream
// ---------------------------------------------------------------------------

test('every layer names a REGISTERED controller, or explains why it has none', () => {
  // A layer pointing at a controller the heartbeat registry does not know would
  // report 'unknown' for ever and never be noticed — which is precisely how
  // loss_guardian stayed invisible while amending stops.
  for (const l of LAYERS) {
    if (l.controller == null) {
      assert.match(l.note, /broker|design/i, `${l.id} must say why it has no heartbeat`)
      continue
    }
    assert.ok(l.controller in CONTROLLERS, `${l.id} points at unregistered controller ${l.controller}`)
  }
})

test('broker-native protection is NOT judged by our own heartbeat', () => {
  // It runs at the broker. Reporting it healthy because this process is alive
  // would be describing the wrong machine — the one case §36.1 is about is the
  // one where this process is down.
  const l = LAYERS.find(x => x.id === 'broker_native')
  assert.equal(l.controller, null)
  assert.equal(ws05Health(initDB(':memory:')).layers.find(x => x.id === 'broker_native').status, 'broker')
})

test('a member that has NEVER run is unknown, not healthy', () => {
  const db = initDB(':memory:')
  const h = ws05Health(db)
  assert.equal(h.healthy, false, 'a fresh database has no evidence anything is managing positions')
  assert.ok(h.unknown.length > 0)
})

test('a beating desk reports healthy', () => {
  const db = initDB(':memory:')
  for (const k of memberControllers()) beat(db, k)
  const h = ws05Health(db)
  assert.deepEqual(h.unknown, [])
  assert.deepEqual(h.degraded, [])
  assert.equal(h.healthy, true)
})

test('members carry their authority AND its precedence, from the one table', () => {
  const m = members()
  assert.ok(m.length > 0)
  for (const row of m) {
    assert.ok(AUTHORITIES.includes(row.authority), `${row.writer} has an unknown authority`)
    assert.equal(row.precedence, AUTHORITIES.indexOf(row.authority))
  }
  // Strongest authority first — this ordering IS the runtime precedence the
  // agent-graph audit said was missing.
  const p = m.map(r => r.precedence)
  assert.deepEqual(p, [...p].sort((a, b) => a - b))
})

test('the workstream states its own goal and boundary', () => {
  // So the code and the Operating Goal Plan cannot drift apart quietly.
  assert.equal(WS05.id, 'WS-05')
  assert.match(WS05.goal, /every open position/i)
  assert.match(WS05.boundary, /broker-confirmed closure/i)
})

// ---------------------------------------------------------------------------
// management history → reflection
// ---------------------------------------------------------------------------

const closeTrade = (db, { pnl = 10, symbol = 'EURUSD', daysAgo = 1 } = {}) =>
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, closed_at, account_id)
     VALUES (?, 'buy', 'closed', ?, datetime('now', ?), '111')`
  ).run(symbol, pnl, `-${daysAgo} days`).lastInsertRowid

test('a trade\'s management narrative names WHO touched it and how often', () => {
  const db = initDB(':memory:')
  const id = closeTrade(db)
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard', toValue: 1.1 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', toValue: 1.2 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'scale_out', source: 'profit_keeper' })

  const n = managementNarrative(db, { tradeId: id })
  assert.equal(n.stopMoves, 2)
  assert.equal(n.scaleOuts, 1)
  assert.deepEqual(n.sources.sort(), ['profit_keeper', 'trade_guard'])
  assert.equal(n.managementTouches, 3)
})

test('an UNMANAGED trade returns null rather than an empty story', () => {
  // The caller reports it as unmanaged. A zero-filled narrative would read as
  // "management ran and did nothing", which is a different fact.
  const db = initDB(':memory:')
  assert.equal(managementNarrative(db, { tradeId: closeTrade(db) }), null)
})

test('coverage is reported as managed vs unmanaged, with the sample size', () => {
  const db = initDB(':memory:')
  const touched = closeTrade(db, { pnl: 40 })
  closeTrade(db, { pnl: -10 })
  closeTrade(db, { pnl: -20 })
  recordPositionEvent(db, { tradeId: touched, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard' })

  const r = managementObservations(db, { days: 30 })
  assert.equal(r.trades, 3)
  assert.equal(r.managed, 1)
  assert.equal(r.unmanaged, 2)
  const cov = r.observations.find(o => o.id === 'management_coverage')
  assert.equal(cov.n, 3)
  assert.equal(cov.provisional, true, `n=3 is below the ${MIN_SAMPLE} floor`)
})

test('the managed/unmanaged comparison refuses to claim a cause', () => {
  const db = initDB(':memory:')
  const t = closeTrade(db, { pnl: 100 })
  closeTrade(db, { pnl: -5 })
  recordPositionEvent(db, { tradeId: t, symbol: 'EURUSD', kind: 'trail_armed', source: 'profit_keeper' })
  const o = managementObservations(db, { days: 30 }).observations.find(x => x.id === 'managed_vs_unmanaged')
  assert.match(o.text, /ASSOCIATION, not a cause/)
  assert.equal(o.managedN, 1)
  assert.equal(o.unmanagedN, 1)
})

test('UNKNOWN P&L is excluded from the averages and said out loud', () => {
  // Reading a NULL as zero is the defect that turned off the daily-loss brake.
  // Here it would drag both means towards nothing and look like a finding.
  const db = initDB(':memory:')
  closeTrade(db, { pnl: null })
  closeTrade(db, { pnl: 50 })
  const r = managementObservations(db, { days: 30 })
  const u = r.observations.find(o => o.id === 'unknown_pnl_excluded')
  assert.equal(u.unknownPnl, 1)
  assert.match(u.text, /unknown, not zero/)
})

test('a silent window says so instead of reporting nothing', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 5 })
  const o = managementObservations(db, { days: 30 }).observations.find(x => x.id === 'active_writers')
  assert.match(o.text, /every management layer was silent/)
})

test('a broken query reports ok:false, never an empty set of findings', () => {
  const db = initDB(':memory:')
  db.exec('DROP TABLE trades')
  const r = managementObservations(db, { days: 30 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.observations, [])
})
