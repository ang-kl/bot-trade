import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

async function fixture(t) {
  const db = initDB(':memory:'), app = express()
  app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close() })
  return { db, get: async q => { const r = await fetch(`http://127.0.0.1:${server.address().port}/state/momentum-targets${q || ''}`); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') } } }
}

test('target status is read-only, explicit about absent plans, and requires an account or all', async t => {
  const { db, get } = await fixture(t)
  assert.equal((await get()).status, 400)
  const out = await get('?account=11')
  assert.equal(out.status, 200); assert.equal(out.cache, 'no-store')
  assert.equal(out.body.executionAuthorized, false)
  assert.equal(out.body.recordedPlans, 0); assert.deepEqual(out.body.rows, [])
  assert.equal(out.body.runtimeIntegration, 'INCOMPLETE')
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='momentum_target_intents'").get().n, 0)
})

test('target status keeps pending and damaged records visible without crediting another account', async t => {
  const { db, get } = await fixture(t)
  db.exec(`CREATE TABLE momentum_target_intents(account_id TEXT, trade_id INTEGER, risk_event_id INTEGER,
    proposal_json TEXT, created_at_ms INTEGER, state TEXT, position_id TEXT, plan_json TEXT, fill_json TEXT)`)
  const add = db.prepare('INSERT INTO momentum_target_intents VALUES(?,?,1,?,1790264000000,?,NULL,NULL,NULL)')
  add.run('11', 1, '{bad', 'PREPARED'); add.run('22', 2, '{}', 'ENROLLED')
  setState(db, 'ctrader_account_id', '11')
  const out = await get()
  assert.equal(out.status, 200); assert.equal(out.body.accountId, '11')
  assert.equal(out.body.recordedPlans, 1); assert.deepEqual(out.body.rows.map(r => r.tradeId), [1])
  assert.equal(out.body.rows[0].evidenceValid, false)
  assert.equal(out.body.rows[0].state, 'PREPARED')
  const all = await get('?account=all&limit=1')
  assert.equal(all.body.recordedPlans, 2); assert.equal(all.body.rows.length, 1)
  assert.equal(all.body.truncated, true)
})

test('target status fails explicitly when the stored schema cannot be read', async t => {
  const { db, get } = await fixture(t)
  db.exec('CREATE TABLE momentum_target_intents(wrong_column TEXT)')
  const out = await get('?account=11')
  assert.equal(out.status, 503); assert.equal(out.body.code, 'momentum_target_status_unavailable')
})
