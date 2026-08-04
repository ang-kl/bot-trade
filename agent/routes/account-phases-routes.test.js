// node --test agent/routes/account-phases-routes.test.js
//
// The HTTP half of the per-account switches. The resolver and the loop gate are
// tested in agent/services/account-phases.test.js; these tests cover what the
// browser actually touches — GET /state/account-phases and
// POST /actions/account-phases — over a real express app and a real DB.
//
// Why this file exists at all: the owner's complaint was "we are still not
// having independent switches, have you wired them?" The honest answer was no,
// and the reason a half-built feature looked finished is that each layer was
// plausible on its own. So each layer gets pinned: a switch the UI flips must
// be readable back, must not touch any other account, and must be REFUSED for
// an account that does not exist rather than stored as a key nothing reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run('46979908', 0, 1, 'active', '5268549')
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
  setState(db, 'autotrade_enabled', 'true')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const view = (s) => fetch(s.url('/state/account-phases')).then(r => r.json())
const setPhases = (s, body) => fetch(s.url('/actions/account-phases'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('GET reports the master and every account, all inheriting by default', async () => {
  const s = await server()
  try {
    const v = await view(s)
    assert.deepEqual(v.master, { scan: true, analyze: true, autotrade: true })
    assert.equal(v.accounts.length, 2)
    for (const a of v.accounts) {
      assert.deepEqual(a.overrides, { scan: null, analyze: null, autotrade: null })
      assert.equal(a.effective.autotrade, true)
    }
  } finally { s.close() }
})

test('a switch survives the round trip and leaves the other account alone', async () => {
  const s = await server()
  try {
    const r = await setPhases(s, { accountId: '46130058', autotrade: false })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.effective.autotrade, false)

    // Read back through the CACHED route — the write must have invalidated it,
    // or the owner flips a switch and watches it flip back.
    const v = await view(s)
    const off = v.accounts.find(a => a.accountId === '46130058')
    const other = v.accounts.find(a => a.accountId === '46979908')
    assert.equal(off.overrides.autotrade, false)
    assert.equal(off.effective.autotrade, false)
    // 'capability': a per-account autotrade OFF now sets accounts.mode, so
    // the switch and the reason are one fact (owner 04-08-2026).
    assert.equal(off.effective.source.autotrade, 'capability')
    assert.equal(other.effective.autotrade, true, 'the other account must be untouched')
    assert.equal(other.overrides.autotrade, null)
  } finally { s.close() }
})

test('null clears the override and the account follows the master again', async () => {
  const s = await server()
  try {
    await setPhases(s, { accountId: '46130058', scan: false })
    assert.equal((await view(s)).accounts.find(a => a.accountId === '46130058').effective.scan, false)
    await setPhases(s, { accountId: '46130058', scan: null })
    const a = (await view(s)).accounts.find(x => x.accountId === '46130058')
    assert.equal(a.overrides.scan, null)
    assert.equal(a.effective.scan, true)
  } finally { s.close() }
})

test('an unknown account is REFUSED, not silently stored', async () => {
  const s = await server()
  try {
    // A typo'd id would otherwise create an override key nothing ever reads:
    // a switch that reports itself off while the real account keeps trading.
    const r = await setPhases(s, { accountId: '99999999', autotrade: false })
    assert.equal(r.status, 404)
    assert.match((await r.json()).error, /unknown account/)
    assert.equal((await view(s)).accounts.length, 2)
  } finally { s.close() }
})

test('a missing accountId, an empty patch and junk values are all 400', async () => {
  const s = await server()
  try {
    assert.equal((await setPhases(s, { autotrade: false })).status, 400)
    assert.equal((await setPhases(s, { accountId: '46130058' })).status, 400)
    // 'on' / 1 / 'true' must fail loudly — a client that guessed the shape
    // should learn it changed nothing instead of being told ok.
    for (const junk of ['on', 1, 'true', {}]) {
      const r = await setPhases(s, { accountId: '46130058', autotrade: junk })
      assert.equal(r.status, 400, `autotrade=${JSON.stringify(junk)} should be rejected`)
    }
    const a = (await view(s)).accounts.find(x => x.accountId === '46130058')
    assert.equal(a.overrides.autotrade, null, 'nothing was written by any rejected call')
  } finally { s.close() }
})

test('the master still vetoes: a per-account ON cannot arm anything', async () => {
  const s = await server()
  try {
    await setPhases(s, { accountId: '46130058', autotrade: true })
    // The kill switch has to stay a kill switch.
    await fetch(s.url('/actions/autotrade-toggle'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }),
    })
    const v = await view(s)
    assert.equal(v.master.autotrade, false)
    const a = v.accounts.find(x => x.accountId === '46130058')
    // The arm is remembered as the account's MODE, not as a second boolean
    // beside it (owner 04-08-2026). `overrides.autotrade` is null — inherit —
    // for any account that MAY enter, and false only when its mode forbids it.
    assert.equal(a.overrides.autotrade, null, 'armed accounts inherit; the mode is the memory')
    assert.equal(a.capability.mode, 'active', '…and the arm itself is remembered there')
    assert.equal(a.effective.autotrade, false, '…but it does not arm while the master is off')
    assert.equal(a.effective.source.autotrade, 'master', 'the UI must blame the master, not the account')
  } finally { s.close() }
})

test('all three phases can be set in one call', async () => {
  const s = await server()
  try {
    const body = await (await setPhases(s,
      { accountId: '46979908', scan: false, analyze: false, autotrade: false })).json()
    assert.deepEqual(body.set, { scan: false, analyze: false, autotrade: false })
    const a = (await view(s)).accounts.find(x => x.accountId === '46979908')
    assert.equal(a.effective.scan, false)
    assert.equal(a.effective.analyze, false)
    assert.equal(a.effective.autotrade, false)
  } finally { s.close() }
})
