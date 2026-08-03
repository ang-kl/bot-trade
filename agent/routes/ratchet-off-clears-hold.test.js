// node --test agent/routes/ratchet-off-clears-hold.test.js
//
// Turning the profit ratchet OFF must lift the hold it left behind.
//
// Owner, 04-08-2026: "I remove the ratchet but still see ratchet on the
// account I disarmed." They were reading the sidebar's own badge, which comes
// from acct:<id>:ratchet_halt — a flag the ratchet sets when a floor is
// confirmed and clears when it re-arms. Switching the layer off stopped the
// re-arm from ever running, so the flag stayed set: the account was left
// blocked by a mechanism that was no longer there to explain, re-evaluate or
// lift it. The only way out was the Telegram button or resetState, which
// clears EVERY account.
//
// Two properties, and the second matters as much as the first: turning it off
// for ONE account must not lift anybody else's hold.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import actionsRouter from './actions.js'
import { haltKey, softKey, PROFIT_RATCHET_KEY } from '../services/profit-ratchet.js'
import { loadProfitRatchetConfig } from '../services/profit-ratchet.js'

const A = '46130058'   // the one the owner switches off
const B = '47790949'   // the bystander, halted too

async function server() {
  const db = initDB(':memory:')
  for (const [id, login] of [[A, '5203012'], [B, '5306502']]) {
    db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
      .run(id, 0, 1, 'active', login)
  }
  setState(db, PROFIT_RATCHET_KEY, JSON.stringify({ on: true, stepUsd: 500 }))
  for (const id of [A, B]) {
    setState(db, haltKey(id), 'true')
    setState(db, softKey(id), 'true')
  }
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

const post = (s, body) => fetch(s.url('/actions/profit-ratchet'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('switching the ratchet OFF for one account lifts THAT account\'s hold', async () => {
  const s = await server()
  try {
    const r = await post(s, { on: false, accountId: A })
    assert.equal(r.status, 200)
    assert.equal(getState(s.db, haltKey(A)), 'false')
    assert.equal(getState(s.db, softKey(A)), 'false')
    assert.equal(loadProfitRatchetConfig(s.db, A).on, false)
  } finally { s.close() }
})

test('…and leaves every other account\'s hold exactly where it was', async () => {
  const s = await server()
  try {
    await post(s, { on: false, accountId: A })
    assert.equal(getState(s.db, haltKey(B)), 'true', 'the bystander is still protected')
    assert.equal(getState(s.db, softKey(B)), 'true')
    assert.equal(loadProfitRatchetConfig(s.db, B).on, true, 'and its ratchet is still on')
  } finally { s.close() }
})

test('switching it off GLOBALLY lifts the hold on every account, because the layer is gone everywhere', async () => {
  const s = await server()
  try {
    await post(s, { on: false })
    for (const id of [A, B]) {
      assert.equal(getState(s.db, haltKey(id)), 'false', `hold lifted on ${id}`)
      assert.equal(getState(s.db, softKey(id)), 'false')
    }
  } finally { s.close() }
})

test('turning the ratchet ON never lifts a hold — only switching it off does', async () => {
  const s = await server()
  try {
    await post(s, { on: true, accountId: A })
    assert.equal(getState(s.db, haltKey(A)), 'true', 'a confirmed floor still protects the account')
    assert.equal(getState(s.db, softKey(A)), 'true')
  } finally { s.close() }
})

test('a save that does not mention `on` leaves the hold alone', async () => {
  const s = await server()
  try {
    await post(s, { stepUsd: 250, accountId: A })
    assert.equal(getState(s.db, haltKey(A)), 'true')
  } finally { s.close() }
})
