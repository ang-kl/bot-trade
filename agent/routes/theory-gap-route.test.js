// node --test agent/routes/theory-gap-route.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder)
// GET /state/theory-gap: validated before any SQL, read in the report worker
// (never on the event loop), no-store.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import stateRouter from './state.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'theory-gap-route-')), db = initDB(join(dir, 'agent.db'))
  db.prepare(`INSERT INTO trades(id, symbol, side, status, account_id, strategy, origin, entry_price, exit_price, sl_price, broker_sl_initial, realised_rr, net_pnl, closed_at_ms, close_reason)
    VALUES (1,'AAA','BUY','closed','111','tsmom_long','bot_pending_fill',100,112,105,90,1.2,120,?, 'rank exit')`).run(Date.now() - 3_600_000)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, url: p => `http://127.0.0.1:${server.address().port}/state/theory-gap${p}` }
}

test('r-audit: answered from the worker with no main-thread trades read; no-store', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  db.prepare = sql => { if (/FROM trades/i.test(sql)) throw Error('main-thread trades read') ; return prepare.call(db, sql) }
  let res
  try { res = await fetch(url('?section=r-audit&strategy=tsmom_long&days=30')) } finally { db.prepare = prepare }
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  const j = await res.json()
  assert.equal(j.section, 'r-audit'); assert.equal(j.trades, 1)
  assert.equal(j.rows[0].rUnder.broker_sl_initial, 1.2); assert.equal(j.rows[0].rUnder.current_sl, 2.4)
})

test('validation before any SQL: unknown section, bad strategy, bad days', async t => {
  const { url } = await fixture(t)
  for (const [q, code] of [['?section=nope', 'theory_gap_invalid_section'], ['?section=r-audit&strategy=DROP%20TABLE', 'theory_gap_invalid_strategy'], ['?section=r-audit&days=0', 'theory_gap_invalid_days'], ['?section=r-audit&days=400', 'theory_gap_invalid_days']]) {
    const res = await fetch(url(q)); assert.equal(res.status, 400, q); assert.equal((await res.json()).code, code)
  }
})
