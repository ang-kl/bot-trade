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
import { tradeManagementOutcome, managementScoreboard } from './management-reflection.js'
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
// management history → reflection, as a SCOREBOARD
//
// The first version of this computed averages over managed and unmanaged
// trades, attached a sample size, and disclaimed the comparison. Owner,
// 04-08-2026: "why samples! make it real". Every sentence it produced was true
// and none told anyone what to do — a mean over two populations nobody assigned
// is evidence that winners run long enough to get trailed, not evidence about a
// rule.
//
// What IS knowable: when a writer moves a stop and price later takes the
// position out AT THAT STOP, the exit is CAUSED by the move. The position would
// still be open otherwise. Priced in R, that is a per-rule scoreboard.
// ---------------------------------------------------------------------------

const mkTrade = (db, { entry = 1.1, exit = 1.12, sl = 1.09, side = 'buy', pnl = 20, daysAgo = 1, symbol = 'EURUSD' } = {}) =>
  db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, exit_price, sl_price, net_pnl, closed_at, account_id)
     VALUES (?, ?, 'closed', ?, ?, ?, ?, datetime('now', ?), '111')`
  ).run(symbol, side, entry, exit, sl, pnl, `-${daysAgo} days`).lastInsertRowid

test('an exit AT A MOVED STOP is attributed to the writer that moved it', () => {
  // Entry 1.10, original stop 1.09 → R = 0.01. The trail moved the stop to
  // 1.115 and price came back to it: +1.5R, banked by profit_keeper. Without
  // that move the position would still have been open.
  const db = initDB(':memory:')
  const id = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.115 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', fromValue: 1.09, toValue: 1.115 })

  const o = tradeManagementOutcome(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
  assert.equal(o.exitCause, 'managed_stop')
  assert.equal(o.causedBy, 'profit_keeper')
  assert.equal(o.realisedR, 1.5)
  assert.equal(o.vsOriginalStop, 2.5, 'against the -1R the resting bracket would have produced')
})

test('R is measured from the stop the trade STARTED with, not the last one', () => {
  // Reading sl_price after the fact returns whatever the last writer left, and
  // R would collapse towards zero — every trade would score as a huge multiple.
  const db = initDB(':memory:')
  const id = mkTrade(db, { entry: 1.1, sl: 1.118, exit: 1.12 })   // sl_price already trailed
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard', fromValue: 1.09, toValue: 1.118 })
  const o = tradeManagementOutcome(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
  assert.equal(o.originalStop, 1.09)
  assert.ok(Math.abs(o.riskPerR - 0.01) < 1e-9)
})

test('a SHORT is scored the right way round', () => {
  const db = initDB(':memory:')
  const id = mkTrade(db, { side: 'sell', entry: 1.1, sl: 1.11, exit: 1.085 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard', fromValue: 1.11, toValue: 1.085 })
  const o = tradeManagementOutcome(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
  assert.equal(o.side, 'short')
  assert.equal(o.realisedR, 1.5)
  assert.equal(o.causedBy, 'trade_guard')
})

test('an exit at the ORIGINAL stop is nobody\'s — the market took it', () => {
  // The whole point of attribution: a stop nobody moved cannot have caused
  // anything, and crediting a writer for it would flatter every scoreboard.
  const db = initDB(':memory:')
  const id = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.09 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'tp_moved', source: 'profit_keeper', toValue: 1.2 })
  const o = tradeManagementOutcome(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
  assert.equal(o.exitCause, 'other')
  assert.equal(o.causedBy, null)
})

test('an explicit close is attributed directly', () => {
  const db = initDB(':memory:')
  const id = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.095 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'close', source: 'loss_guardian', priceAt: 1.095 })
  const o = tradeManagementOutcome(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
  assert.equal(o.exitCause, 'explicit_close')
  assert.equal(o.causedBy, 'loss_guardian')
  assert.equal(o.realisedR, -0.5)
})

test('the scoreboard totals R per writer and counts winners against losers', () => {
  const db = initDB(':memory:')
  const a = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.115, pnl: 15 })
  const b = mkTrade(db, { entry: 1.2, sl: 1.19, exit: 1.195, pnl: -5 })
  recordPositionEvent(db, { tradeId: a, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', fromValue: 1.09, toValue: 1.115 })
  recordPositionEvent(db, { tradeId: b, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', fromValue: 1.19, toValue: 1.195 })

  const s = managementScoreboard(db, { days: 30 })
  const pk = s.writers.find(w => w.writer === 'profit_keeper')
  assert.equal(pk.exits, 2)
  assert.equal(pk.positive, 1)
  assert.equal(pk.negative, 1)
  assert.equal(pk.totalR, 1)         // +1.5R and -0.5R
  assert.equal(pk.netPnl, 10)
  assert.equal(pk.pnlCoverage, '2/2')
})

test('money is reported only over the exits whose P&L is KNOWN', () => {
  // Rolling an unknown in as zero is the defect that turned off the daily
  // brake. Here it would understate a writer's damage.
  const db = initDB(':memory:')
  const a = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.115, pnl: 15 })
  const b = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.115, pnl: null })
  for (const id of [a, b]) {
    recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard', fromValue: 1.09, toValue: 1.115 })
  }
  const w = managementScoreboard(db, { days: 30 }).writers.find(x => x.writer === 'trade_guard')
  assert.equal(w.exits, 2)
  assert.equal(w.netPnl, 15)
  assert.equal(w.pnlCoverage, '1/2', 'and it says so rather than implying full coverage')
})

test('a trade with no management history contributes to no writer', () => {
  const db = initDB(':memory:')
  mkTrade(db, { pnl: 100 })
  const s = managementScoreboard(db, { days: 30 })
  assert.equal(s.closedTrades, 1)
  assert.equal(s.withManagementHistory, 0)
  assert.deepEqual(s.writers, [])
})

test('writers are ranked by total R, best first', () => {
  const db = initDB(':memory:')
  const good = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.13 })
  const bad = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.095 })
  recordPositionEvent(db, { tradeId: good, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', fromValue: 1.09, toValue: 1.13 })
  recordPositionEvent(db, { tradeId: bad, symbol: 'EURUSD', kind: 'sl_moved', source: 'trade_guard', fromValue: 1.09, toValue: 1.095 })
  const s = managementScoreboard(db, { days: 30 })
  assert.equal(s.writers[0].writer, 'profit_keeper')
  assert.equal(s.writers[1].writer, 'trade_guard')
  assert.ok(s.writers[0].totalR > s.writers[1].totalR)
})

test('the per-trade rows behind every figure are returned', () => {
  // A number that looks wrong should be takeable apart, not argued with.
  const db = initDB(':memory:')
  const id = mkTrade(db, { entry: 1.1, sl: 1.09, exit: 1.115 })
  recordPositionEvent(db, { tradeId: id, symbol: 'EURUSD', kind: 'sl_moved', source: 'profit_keeper', fromValue: 1.09, toValue: 1.115 })
  const s = managementScoreboard(db, { days: 30 })
  assert.equal(s.trades.length, 1)
  assert.equal(s.trades[0].tradeId, id)
  assert.equal(s.trades[0].originalStop, 1.09)
  assert.equal(s.trades[0].finalStop, 1.115)
})

test('a broken query reports ok:false, never an empty scoreboard', () => {
  const db = initDB(':memory:')
  db.exec('DROP TABLE trades')
  const s = managementScoreboard(db, { days: 30 })
  assert.equal(s.ok, false)
  assert.deepEqual(s.writers, [])
})
