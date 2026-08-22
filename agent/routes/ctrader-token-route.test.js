// node --test agent/routes/ctrader-token-route.test.js
//
// THE TRAP THIS CLOSES. `ctrader_refresh_token` had exactly two writers: boot,
// which only seeds an EMPTY database, and a SUCCESSFUL refresh. So the moment
// a stored refresh token went stale there was no way back — updating it
// required a successful refresh, and a successful refresh required a valid
// one. A closed loop with no door.
//
// Re-linking through the browser looked like the door and was not. The OAuth
// exchange returns BOTH tokens; Connect.jsx forwarded only the access token,
// and this route accepted only the access token. The refresh token was
// discarded in the browser and never reached the database.
//
// Measured 2026-08-22: the owner re-linked AND changed the host variable
// twice, and every pass still failed with "Access denied. Make sure the
// credentials are valid." Nothing they could do from the app or the host
// could have worked.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'

const TOKEN = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function serve(db) {
  const app = express()
  app.use(express.json())
  // The real lister opens a WebSocket session to Spotware, so it is injected.
  // Everything under test here is what happens to the tokens AFTER it returns.
  app.use('/actions', actionsRouter(db, {
    listCtraderAccounts: async () => [{ accountId: '46130058', isLive: false, traderLogin: 5203012 }],
  }))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

function freshDb() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  return db
}

const post = (base, body) => fetch(`${base}/actions/ctrader-token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
})

test('a refresh token in the body is STORED — the door that did not exist', async () => {
  const db = freshDb()
  setState(db, 'ctrader_refresh_token', 'the-stale-one-that-cannot-refresh')
  const { server, base } = serve(db)
  try {
    const res = await post(base, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.refreshStored, true)
    assert.equal(getState(db, 'ctrader_refresh_token'), 'fresh-refresh',
      'the stale token must be replaced — this is the whole point')
    assert.equal(getState(db, 'ctrader_access_token'), 'fresh-access')
  } finally { server.close() }
})

test('OMITTING the refresh token leaves a good one alone', async () => {
  // The account-picker re-post and any older client send no refresh token.
  // Blanking a working credential because this call did not carry one would
  // be the same defect pointed the other way.
  const db = freshDb()
  setState(db, 'ctrader_refresh_token', 'the-good-one')
  const { server, base } = serve(db)
  try {
    const res = await post(base, { accessToken: 'fresh-access' })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.refreshStored, false)
    assert.equal(getState(db, 'ctrader_refresh_token'), 'the-good-one')
  } finally { server.close() }
})

test('an empty-string refresh token does not blank the stored one', async () => {
  // A client that sends `refreshToken: ''` when the exchange returned nothing
  // must not be treated as "clear it".
  const db = freshDb()
  setState(db, 'ctrader_refresh_token', 'the-good-one')
  const { server, base } = serve(db)
  try {
    await post(base, { accessToken: 'fresh-access', refreshToken: '' })
    assert.equal(getState(db, 'ctrader_refresh_token'), 'the-good-one')
  } finally { server.close() }
})

test('the access token is still required', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    const res = await post(base, { refreshToken: 'only-this' })
    assert.equal(res.status, 400)
    assert.equal(getState(db, 'ctrader_refresh_token'), null,
      'a rejected call must not have written anything')
  } finally { server.close() }
})
