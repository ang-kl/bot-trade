// node --test agent/routes/scan-off-authority.test.js
//
// Scan OFF is a human decision (#1173 for the master and per-account
// switches; 01-10-2026 for a strategy's Scan cell and for every HTTP path).
// Over HTTP the owner is the device session the server stamps — never the
// master secret, never anything in the body or headers. Turning a scan ON,
// Autotrade off and kill-all are not restricted: a stop is never refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'
import { setStage, loadStageMatrix, HUMAN_SCAN_ACTORS } from '../services/stage-matrix.js'

async function server(credential) {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('46130058', 0, 1, 'active', '5203012')
  for (const k of ['scan_enabled', 'analyze_enabled', 'autotrade_enabled']) setState(db, k, 'true')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.authCredential = credential; next() })
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      post: (p, body, headers = {}) => fetch(`http://127.0.0.1:${s.address().port}/actions${p}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      }),
    }))
  })
}

const scanCell = (db, key) => loadStageMatrix(db, getState).strategies.find(s => s.key === key).stages.scan

test('agent secret: every Scan OFF path is refused with 403 and nothing is written', async () => {
  const s = await server('agent_secret')
  try {
    const a = await s.post('/scan-toggle', { on: false })
    assert.equal(a.status, 403); assert.equal((await a.json()).error, 'scan_off_needs_owner_device')
    assert.equal(getState(s.db, 'scan_enabled'), 'true')

    const b = await s.post('/account-phases', { accountId: '46130058', scan: false })
    assert.equal(b.status, 403)
    assert.equal(getState(s.db, 'acct:46130058:scan_enabled') ?? null, null)

    const c = await s.post('/stage-matrix', { kind: 'strategy', key: 'vwap_trend', stage: 'scan', on: false })
    assert.equal(c.status, 403)
    assert.equal(scanCell(s.db, 'vwap_trend'), true)
  } finally { s.close() }
})

test('nothing the client sends can claim the owner: body actor and X-Actor are ignored for authority', async () => {
  const s = await server('agent_secret')
  try {
    const r = await s.post('/scan-toggle', { on: false, actor: 'owner (device session)' }, { 'x-actor': 'owner-ui', authorization: 'Bearer sess_forged' })
    assert.equal(r.status, 403)
    assert.equal(getState(s.db, 'scan_enabled'), 'true')
  } finally { s.close() }
})

test('agent secret: Scan ON, Autotrade off and per-account Autotrade off still work', async () => {
  const s = await server('agent_secret')
  try {
    assert.equal((await s.post('/scan-toggle', { on: true })).status, 200)
    assert.equal((await s.post('/autotrade-toggle', { on: false })).status, 200)
    assert.equal(getState(s.db, 'autotrade_enabled'), 'false')
    assert.equal((await s.post('/account-phases', { accountId: '46130058', autotrade: false })).status, 200)
    assert.equal((await s.post('/stage-matrix', { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false })).status, 200)
  } finally { s.close() }
})

test("the owner's device session can switch every scan off", async () => {
  const s = await server('device_session')
  try {
    assert.equal((await s.post('/scan-toggle', { on: false })).status, 200)
    assert.equal(getState(s.db, 'scan_enabled'), 'false')
    assert.equal((await s.post('/account-phases', { accountId: '46130058', scan: false })).status, 200)
    assert.equal(getState(s.db, 'acct:46130058:scan_enabled'), 'false')
    assert.equal((await s.post('/stage-matrix', { kind: 'strategy', key: 'vwap_trend', stage: 'scan', on: false })).status, 200)
    assert.equal(scanCell(s.db, 'vwap_trend'), false)
  } finally { s.close() }
})

test('setStage: an automatic actor cannot switch a strategy scan off; it can still disarm trade and switch scan on', () => {
  const db = initDB(':memory:')
  const io = { getState, setState }
  assert.deepEqual([...HUMAN_SCAN_ACTORS], ['owner_route', 'telegram'])
  for (const actor of ['adaptive_breaker', 'edge_watchdog', 'boot_seed', 'unattributed', undefined]) {
    assert.throws(() => setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'scan', on: false, actor }, io),
      e => e.code === 'scan_off_needs_human', String(actor))
  }
  assert.equal(scanCell(db, 'vwap_trend'), true)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, actor: 'edge_watchdog' }, io)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'scan', on: false, actor: 'telegram' }, io)
  assert.equal(scanCell(db, 'vwap_trend'), false)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'scan', on: true, actor: 'boot_seed' }, io)
  assert.equal(scanCell(db, 'vwap_trend'), true)
})
