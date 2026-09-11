// node --test agent/routes/tick-readiness-routes.test.js — P5's three routes
// over a real express app: the readiness read (all accounts and one), the
// signals read, and the validation importer's refusal path (the checked-in
// thresholds are unset, so the route answers 400 thresholds_unset and writes
// nothing — the same answer production gives today).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { getAccountState } from '../services/account-registry.js'
import { ENGINE_STATUS_KEY } from '../services/entry-mode.js'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('42993489', 1, 1, 'active', '5268549')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('GET /state/tick-readiness lists every account with classed blockers; ?account narrows to one; GET /state/tick-signals answers', async () => {
  const s = await server()
  try {
    const all = await fetch(s.url('/state/tick-readiness')).then(r => r.json())
    assert.equal(all.accounts.length, 2); assert.equal(all.readyCount, 0)
    assert.ok(all.accounts.every(a => a.ready === false && a.blockedReasons.length > 0 && Array.isArray(a.readiness)))
    const one = await fetch(s.url('/state/tick-readiness?account=42993489')).then(r => r.json())
    assert.equal(one.accountId, '…3489'); assert.equal(one.environment, 'live'); assert.ok(one.blockedReasons.includes('validation_stage'))
    const sig = await fetch(s.url('/state/tick-signals')).then(r => r.json())
    assert.equal(sig.count, 0); assert.deepEqual(sig.signals, [])
  } finally { s.close() }
})

test('POST /actions/tick-validation refuses on the checked-in unset thresholds with 400 and writes nothing; a missing stage is 400', async () => {
  const s = await server()
  try {
    const bad = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058' }) })
    assert.equal(bad.status, 400)
    const r = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058', stage: 'replay_passed', evidence: { trialId: 'x' } }) })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.ok, false); assert.equal(body.reason, 'thresholds_unset')
    assert.equal(getAccountState(s.db, '46130058', ENGINE_STATUS_KEY), null)
  } finally { s.close() }
})
