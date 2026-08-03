// node --test agent/routes/ratchet-account-route.test.js
//
// POST /actions/ratchet-account — clearing ONE account's ratchet hold.
//
// The gap this closes: the halt is per-account (v2's whole point), but the
// only ways to lift one were a Telegram button and POST /actions/profit-ratchet
// with { resetState: true }, which loops the registry and clears EVERY
// account's staircase. So the tests that matter are about BLAST RADIUS — the
// other account's banked floor and hold must be exactly where they were — and
// about the rule the ratchet has never been allowed to break: it does not
// touch the S.A.T. switches.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import actionsRouter from './actions.js'
import { haltKey, softKey, loadRatchetState } from '../services/profit-ratchet.js'

const A = '46130058'   // the halted one
const B = '47790949'   // the bystander

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(A, 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(B, 0, 1, 'active', '5306502')
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
  setState(db, 'autotrade_enabled', 'true')

  // A is halted, exactly as production was on 2026-08-02T22:24Z.
  setState(db, `acct:${A}:profit_ratchet_state_json`, JSON.stringify({
    baseline: 51627.82, hwm: 51627.82, floor: null, breachStreak: 0,
    halt: true, haltAt: '2026-08-02T22:24:09.684Z', haltFloor: 52153.84,
    keepOff: false, rearmSince: null, lastEquity: 48265.60,
  }))
  setState(db, haltKey(A), 'true')
  // B has banked a step and is trading.
  setState(db, `acct:${B}:profit_ratchet_state_json`, JSON.stringify({
    baseline: 50548.76, hwm: 51100.00, floor: 50548.76, breachStreak: 0,
    halt: false, keepOff: false, rearmSince: null, lastEquity: 49728.51,
  }))

  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const post = (s, body) => fetch(s.url('/actions/ratchet-account'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('rearm clears the hold on the named account and reports both sides of it', async () => {
  const s = await server()
  try {
    const r = await post(s, { accountId: A, action: 'rearm' })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(j.before, { blocked: true, stage: 'halt' })
    assert.deepEqual(j.after, { blocked: false, stage: null })
    assert.equal(getState(s.db, haltKey(A)), 'false')
    assert.equal(loadRatchetState(s.db, A).halt, false)
    // The staircase SURVIVES a re-arm — that is what distinguishes it from a
    // rebaseline, and the difference is the whole reason both exist.
    assert.equal(loadRatchetState(s.db, A).baseline, 51627.82)
  } finally { s.close() }
})

test('the other account is untouched — this is not /profit-ratchet resetState', async () => {
  const s = await server()
  try {
    await post(s, { accountId: A, action: 'rearm' })
    const b = loadRatchetState(s.db, B)
    assert.equal(b.floor, 50548.76)   // its banked floor is still protecting it
    assert.equal(b.hwm, 51100.00)
    assert.equal(b.baseline, 50548.76)
  } finally { s.close() }
})

test('rebaseline throws the stale ladder away so the next pass starts from current equity', async () => {
  const s = await server()
  try {
    const j = await (await post(s, { accountId: A, action: 'rebaseline' })).json()
    assert.equal(j.ok, true)
    assert.equal(j.state, null)                    // rebuilt on the next ratchet pass
    assert.equal(getState(s.db, haltKey(A)), 'false')
    assert.equal(getState(s.db, softKey(A)), 'false')
    assert.equal(loadRatchetState(s.db, B).floor, 50548.76)
  } finally { s.close() }
})

test('keepoff leaves the account halted and stops the auto re-arm watching', async () => {
  const s = await server()
  try {
    const j = await (await post(s, { accountId: A, action: 'keepoff' })).json()
    assert.deepEqual(j.after, { blocked: true, stage: 'halt' })
    assert.equal(getState(s.db, haltKey(A)), 'true')
    assert.equal(loadRatchetState(s.db, A).keepOff, true)
  } finally { s.close() }
})

test('NEVER touches the S.A.T. switches — the rule the ratchet broke once and may not break again', async () => {
  const s = await server()
  try {
    for (const action of ['rearm', 'keepoff', 'rebaseline']) {
      await post(s, { accountId: A, action })
      for (const k of ['scan_enabled', 'analyze_enabled', 'autotrade_enabled']) {
        assert.equal(getState(s.db, k), 'true', `${action} moved ${k}`)
      }
    }
  } finally { s.close() }
})

test('an unknown account is refused, not stored as a key nothing reads', async () => {
  const s = await server()
  try {
    const r = await post(s, { accountId: '99999999', action: 'rearm' })
    assert.equal(r.status, 404)
    assert.equal(getState(s.db, haltKey('99999999')), null)
  } finally { s.close() }
})

test('a junk action is refused rather than silently defaulted to rearm', async () => {
  const s = await server()
  try {
    const r = await post(s, { accountId: A, action: 'clear' })
    assert.equal(r.status, 400)
    assert.equal(getState(s.db, haltKey(A)), 'true')   // still halted
  } finally { s.close() }
})
