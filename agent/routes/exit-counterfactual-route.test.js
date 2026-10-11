// node --test agent/routes/exit-counterfactual-route.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder)
//
// GET /state/exit-counterfactual: a LEGACY query (none of the new options, or
// trailR alone) is answered exactly as before, on the event loop, with the
// same JSON; a query naming an extended option is validated first and then
// answered from the report worker with no main-thread trades read.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { exitCounterfactual, parseTrailSweep } from '../services/exit-counterfactual.js'
import { DEFAULT_RULES } from '../lib/exit-replay.js'

const MIN = 60_000, t0 = Date.now() - 3 * 3_600_000
const BARS = [[t0, 100, 100.6, 99.8, 100.5, 0], [t0 + MIN, 100.5, 101.3, 100.4, 101.2, 0], [t0 + 2 * MIN, 101.2, 102.4, 99.3, 99.4, 0]]

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exit-cf-route-')), db = initDB(join(dir, 'agent.db'))
  for (let i = 0; i < 3; i++) {
    const info = db.prepare(`INSERT INTO trades (symbol, side, status, strategy, entry_price, sl_price, tp_price, broker_sl_initial, realised_rr, exit_price_suspect, opened_at, closed_at, net_pnl, origin, account_id)
      VALUES ('JPN225','long','closed','rsi_meanrev',100,99.5,103,99,-0.5,0,?,?,-50,'bot_market_dispatch','43097342')`).run(new Date(t0).toISOString(), new Date(t0 + 2 * MIN).toISOString())
    db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json) VALUES (?, 'JPN225','long',100,99.5,-1,'stop_hunt',?)`).run(info.lastInsertRowid, JSON.stringify(BARS))
  }
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, url: p => `http://127.0.0.1:${server.address().port}/state/exit-counterfactual${p}` }
}

test('legacy queries (no option, trailR alone) return the legacy JSON unchanged — no `extended` key, no worker', async t => {
  const { db, url } = await fixture(t)
  for (const [q, opts] of [['?days=30', {}], ['?days=30&trailR=0.75,2', { rules: [...DEFAULT_RULES, ...parseTrailSweep('0.75,2')] }], ['?days=30&strategy=rsi_meanrev&minSample=2', { strategy: 'rsi_meanrev', minSample: 2 }]]) {
    const res = await fetch(url(q)); assert.equal(res.status, 200, q)
    const body = await res.json()
    assert.equal(body.extended, undefined, `${q} must not take the extended path`)
    const direct = exitCounterfactual(db, { days: 30, minSample: 30, cleanOnly: true, accountId: null, strategy: null, excludeStrategy: null, ...opts })
    assert.deepEqual(body, JSON.parse(JSON.stringify(direct)), `${q} legacy JSON identical`)
  }
  const sweep = await (await fetch(url('?trailR=0.75'))).json()
  assert.ok(sweep.rules.some(r => r.rule === 'trail_0.75R'), 'the legacy trail sweep still works')
})

test('an extended option goes to the worker (no main-thread trades read), no-store, with the option echoed', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  db.prepare = sql => { if (/FROM trades/i.test(sql)) throw Error('main-thread trades read'); return prepare.call(db, sql) }
  let res
  try { res = await fetch(url('?stop=initial&minSample=1&followThrough=1&groupBy=strategy&tpR=2,junk')) } finally { db.prepare = prepare }
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  const j = await res.json()
  assert.equal(j.extended, true); assert.match(j.stop.basis, /broker_sl_initial/)
  assert.deepEqual(j.sweeps.tpR, [2]); assert.deepEqual(j.sweeps.overridden, ['tpR'])
  assert.equal(j.followThrough.n, 3); assert.equal(j.groups.values.rsi_meanrev.n, 3)
  assert.equal(j.eligible, 3)
})

test('validation before any work: bad stop, preset, groupBy and family are 400 with a code', async t => {
  const { url } = await fixture(t)
  for (const [q, code] of [['?stop=trailed', 'exit_counterfactual_invalid_stop'], ['?preset=everything', 'exit_counterfactual_invalid_preset'], ['?groupBy=symbol', 'exit_counterfactual_invalid_group'], ['?family=Mean%20Reversion', 'exit_counterfactual_invalid_family']]) {
    const res = await fetch(url(q)); assert.equal(res.status, 400, q); assert.equal((await res.json()).code, code)
  }
})
