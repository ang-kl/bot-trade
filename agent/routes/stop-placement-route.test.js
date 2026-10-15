// node --test agent/routes/stop-placement-route.test.js
// Claude · № 14,945 15-Oct (owner order § 14,741·A PR-3; claude-builder)
// GET /state/stop-placement: validated before any SQL, read in the report
// worker (never on the event loop), no-store, allowlisted row fields only.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { STOP_PLACEMENT_ROW_FIELDS } from '../services/stop-placement.js'

async function fixture(t) {
  const dir = tempDir('stop-placement-route-'), db = initDB(join(dir, 'agent.db'))
  db.prepare('INSERT INTO risk_events(id, symbol, checks_json, proposal_json) VALUES (7, ?, ?, ?)')
    .run('US30', JSON.stringify({ stop_floor: { ok: true, atr1h: 100, mult: 1, source: 'scan_1h' } }), JSON.stringify({ sl: 51966, timeframe: '15m' }))
  db.prepare(`INSERT INTO trades(id, symbol, side, status, account_id, strategy, origin, entry_price, exit_price, sl_price, broker_sl_initial, gross_pnl, net_pnl, closed_at_ms, risk_event_id, close_reason)
    VALUES (1826,'US30','BUY','closed','46130058','rsi2_reversion','bot_market_dispatch',52050,51957.8,51966,51966,-92.2,-95,?,7,'stop loss hit — broker-side SL fill')`).run(Date.now() - 3_600_000)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close() })
  return { db, url: p => `http://127.0.0.1:${server.address().port}/state/stop-placement${p}` }
}

test('answered from the worker with no main-thread trades read; no-store; only allowlisted row fields', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  db.prepare = sql => { if (/FROM trades/i.test(sql)) throw Error('main-thread trades read'); return prepare.call(db, sql) }
  let res
  try { res = await fetch(url('?account=46130058&days=30')) } finally { db.prepare = prepare }
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  const j = await res.json()
  assert.equal(j.report, 'stop-placement'); assert.equal(j.account, '46130058'); assert.equal(j.days, 30)
  assert.equal(j.population.included, 1)
  assert.deepEqual(Object.keys(j.rows[0]).sort(), [...STOP_PLACEMENT_ROW_FIELDS].sort())
  assert.equal(j.rows[0].outcomeR, -1.0976); assert.equal(j.rows[0].stopAtr, 0.84); assert.equal(j.rows[0].timeframe, '15m')
  assert.equal(j.buckets.find(b => b.bucket === '0.75-1').verdict, 'INSUFFICIENT')
  const other = await (await fetch(url('?account=222'))).json()
  assert.equal(other.population.included, 0, 'another account sees none of …0058\'s trades')
})

test('validation before any SQL: bad days, bad account', async t => {
  const { db, url } = await fixture(t)
  let prepares = 0
  const prepare = db.prepare
  db.prepare = sql => { prepares++; return prepare.call(db, sql) }
  try {
    for (const [q, code] of [['?days=0', 'stop_placement_invalid_days'], ['?days=91', 'stop_placement_invalid_days'], ['?days=1.5', 'stop_placement_invalid_days'], ['?days=x', 'stop_placement_invalid_days'], ['?account=0123', 'stop_placement_invalid_account'], ['?account=DROP', 'stop_placement_invalid_account']]) {
      const res = await fetch(url(q)); assert.equal(res.status, 400, q); assert.equal((await res.json()).code, code, q)
    }
  } finally { db.prepare = prepare }
  assert.equal(prepares, 0, 'nothing reaches the database before the inputs are valid')
})
