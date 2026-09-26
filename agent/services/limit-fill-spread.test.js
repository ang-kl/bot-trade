// node --test agent/services/limit-fill-spread.test.js
//
// V3 PO-M3: the spread at a resting limit's (PRE) fill is RECORDED, and only
// recorded. The unit cases drive recordLimitFillSpread; the last cases drive
// the fast monitor end to end (sidecar quote in, trade row out), because the
// record is worth nothing if the pass that holds the quote never writes it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordLimitFillSpread, FIRST_SIGHT_MAX_MS, NEW_FILL_MAX_AGE_MS, isPreFill } from './limit-fill-spread.js'
import { runFastMonitor, _resetFastDecisionStateForTests } from './fast-monitor.js'

const NOW = Date.UTC(2026, 8, 26, 13, 31, 0)
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) // SQLite datetime('now') shape

function seedFill(db, { source = 'preopen', openedMs = NOW - 60_000, positionId = '500', accountId = '111', symbol = 'EURUSD' } = {}) {
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id, label_raw)
      VALUES (?, 'BUY', 1.1, 0.01, ?, ?, 'open', ?, ?, 'PRE|v1|OTHER|MID|OFF|1d|')`).run(symbol, positionId, source, iso(openedMs), accountId).lastInsertRowid
  const mpId = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, trade_id, created_at)
      VALUES (?, 'BUY', 1.1, 1.095, 1.12, 0.005, 'active', ?, 'tsmom', ?, ?, datetime('now'))`).run(symbol, source, accountId, tradeId).lastInsertRowid
  return { tradeId, pos: db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(mpId) }
}
const rowOf = (db, id) => db.prepare('SELECT fill_spread, fill_spread_json FROM trades WHERE id = ?').get(id)
const recOf = (db, id) => JSON.parse(rowOf(db, id).fill_spread_json)

test('PO-M3: a new PRE fill records bid, ask, spread (price and bp), source, and the fill it is measured against', () => {
  const db = initDB(':memory:')
  const { tradeId, pos } = seedFill(db)
  const out = recordLimitFillSpread(db, pos, { quote: { bid: 1.1000, ask: 1.1002 }, source: 'sidecar', nowMs: NOW })
  assert.deepEqual(out, { recorded: 'measured', tradeId })
  const row = rowOf(db, tradeId)
  assert.ok(Math.abs(row.fill_spread - 0.0002) < 1e-12, String(row.fill_spread))
  const rec = recOf(db, tradeId)
  assert.equal(rec.state, 'measured')
  assert.equal(rec.bid, 1.1); assert.equal(rec.ask, 1.1002)
  assert.equal(rec.spreadBp, 1.82) // 0.0002 / 1.1001 × 1e4
  assert.equal(rec.source, 'sidecar')
  assert.equal(rec.fillBasis, 'row_opened_at', 'no execution event on record → the row\'s own time, and it says so')
  assert.equal(rec.lagMs, 60_000)
  assert.match(rec.note, /not observable from Node/)
})

test('PO-M3: the fill time is the execution event\'s when the sidecar journalled one', () => {
  const db = initDB(':memory:')
  const { tradeId, pos } = seedFill(db, { openedMs: NOW - 120_000 })
  db.prepare(`INSERT INTO cpp_events (side, boot_id, seq, ts_ms, execution_type, order_id, position_id, account_id, symbol_id, solicited)
      VALUES ('cpp_exec', 'b', 1, ?, 'ORDER_ACCEPTED', '9', '500', '111', 1, 0), ('cpp_exec', 'b', 2, ?, 'ORDER_FILLED', '9', '500', '111', 1, 0)`)
    .run(NOW - 900_000, NOW - 150_000)
  recordLimitFillSpread(db, pos, { quote: { bid: 1.1, ask: 1.1001 }, source: 'broker', nowMs: NOW })
  const rec = recOf(db, tradeId)
  assert.equal(rec.fillBasis, 'execution_event')
  assert.equal(rec.fillMs, NOW - 150_000, 'the FILLED event, not the acceptance')
  assert.equal(rec.lagMs, 150_000)
})

test('PO-M3: write-once — a measured record is final; a later quote does not overwrite it', () => {
  const db = initDB(':memory:')
  const { tradeId, pos } = seedFill(db)
  recordLimitFillSpread(db, pos, { quote: { bid: 1.1, ask: 1.1002 }, source: 'sidecar', nowMs: NOW })
  const again = recordLimitFillSpread(db, pos, { quote: { bid: 1.1, ask: 1.1050 }, source: 'sidecar', nowMs: NOW + 3_000 })
  assert.deepEqual(again, { skipped: 'recorded' })
  assert.ok(Math.abs(rowOf(db, tradeId).fill_spread - 0.0002) < 1e-12)
})

test('PO-M3: no quote → a not_read record with the reason; a later quote inside the window replaces it', () => {
  const db = initDB(':memory:')
  const { tradeId, pos } = seedFill(db)
  recordLimitFillSpread(db, pos, { quote: null, nowMs: NOW, reason: 'quote unavailable (market closed or feed gap)' })
  assert.equal(rowOf(db, tradeId).fill_spread, null, 'no number is invented')
  assert.deepEqual([recOf(db, tradeId).state, recOf(db, tradeId).reason], ['not_read', 'quote unavailable (market closed or feed gap)'])
  recordLimitFillSpread(db, pos, { quote: { bid: 1.1, ask: 1.1003 }, source: 'broker', nowMs: NOW + 5_000 })
  assert.equal(recOf(db, tradeId).state, 'measured')
})

test('PO-M3: a first read past the window is not a fill-time spread — recorded as not_read with the lag, never as a number', () => {
  const db = initDB(':memory:')
  const { tradeId, pos } = seedFill(db, { openedMs: NOW - FIRST_SIGHT_MAX_MS - 60_000 })
  recordLimitFillSpread(db, pos, { quote: { bid: 1.1, ask: 1.1002 }, source: 'sidecar', nowMs: NOW })
  const row = rowOf(db, tradeId), rec = recOf(db, tradeId)
  assert.equal(row.fill_spread, null)
  assert.equal(rec.state, 'not_read')
  assert.match(rec.reason, /16 min after the fill — past the 15 min window/)
})

test('PO-M3: only NEW PRE fills — an old PRE row and a non-PRE row are left untouched', () => {
  const db = initDB(':memory:')
  const old = seedFill(db, { openedMs: NOW - NEW_FILL_MAX_AGE_MS - 1, positionId: '501' })
  assert.deepEqual(recordLimitFillSpread(db, old.pos, { quote: { bid: 1.1, ask: 1.1002 }, nowMs: NOW }), { skipped: 'not_new' })
  assert.equal(rowOf(db, old.tradeId).fill_spread_json, null)
  const market = seedFill(db, { source: 'autopilot', positionId: '502' })
  assert.equal(isPreFill(market.pos), false)
  assert.deepEqual(recordLimitFillSpread(db, market.pos, { quote: { bid: 1.1, ask: 1.1002 }, nowMs: NOW }), { skipped: 'not_pre_fill' })
  assert.equal(rowOf(db, market.tradeId).fill_spread_json, null)
})

// ---- end to end through the fast monitor --------------------------------
// ONE db for every runFastMonitor case: loop.js's prepareStatements binds to
// the first db it sees (see fast-monitor-sidecar-quotes.test.js).
let SHARED = null
function monitorDb() {
  if (!SHARED) {
    SHARED = initDB(':memory:')
    setState(SHARED, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2 }))
    setState(SHARED, 'ctrader_account_id', '111')
    SHARED.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  }
  SHARED.prepare('DELETE FROM monitored_positions').run()
  _resetFastDecisionStateForTests()
  return SHARED
}
const CREDS = { ready: true, host: 'demo.ctraderapi.com', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '111', isLive: false }
let clock = NOW
function monitorDeps({ quotes }) {
  const t = (clock += 60 * 60_000)
  return {
    t,
    now: () => t,
    ws: { wsGetTrendbarsBatch: async () => ({ '1m': [] }), wsGetSpotOnce: async () => ({ bid: 1.1005, ask: 1.1007 }) },
    exec: { sidecarQuotes: async () => ({ feed: 'up', generation: 1, accountId: '111', nowMs: t, count: quotes.length, quotes: quotes.map(q => ({ ...q, tsMs: t - 500, recvMs: t - 500 })) }) },
  }
}

test('PO-M3 end to end: the fast monitor records the PRE fill\'s spread from the quote it priced with; a market fill beside it gets nothing; the evaluation is unchanged', async () => {
  const db = monitorDb()
  const d = monitorDeps({ quotes: [{ symbolId: 1, bid: 1.1000, ask: 1.1003 }, { symbolId: 2, bid: 1.1000, ask: 1.1002 }] })
  const pre = seedFill(db, { openedMs: d.t - 30_000, positionId: '700' })
  const mkt = seedFill(db, { source: 'autopilot', openedMs: d.t - 30_000, positionId: '701', symbol: 'GBPUSD' })
  const out = await runFastMonitor(db, CREDS, d)
  assert.equal(out.checked, 2, JSON.stringify(out))
  const rec = recOf(db, pre.tradeId)
  assert.deepEqual([rec.state, rec.bid, rec.ask, rec.source, rec.lagMs], ['measured', 1.1, 1.1003, 'sidecar', 30_000])
  assert.equal(rowOf(db, mkt.tradeId).fill_spread_json, null, 'a market fill is not a PRE fill')
  const actions = db.prepare('SELECT last_check_action FROM monitored_positions ORDER BY id').all().map(r => r.last_check_action)
  assert.deepEqual(actions, ['FAST:HOLD', 'FAST:HOLD'], 'record only: both positions evaluated as they would be without it')
})
