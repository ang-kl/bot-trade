// node --test agent/routes/ctrader-env-route.test.js
//
// WHY A ROUTE TEST AND NOT ONLY A UNIT TEST. The unit tests in
// lib/ctrader-env.test.js pass a fake `stored` reader. That proves the logic
// and says nothing about whether the route is MOUNTED, whether it reads the
// real agent_state table, or whether it serialises without a credential in
// it. #743 shipped exactly this shape of gap in the other direction: correct
// facts written to a boot log nobody could read.
//
// So this spawns the real router over a real database and asserts on the
// bytes that come back over HTTP.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

function serve(db) {
  const app = express()
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

const get = async (base) => (await fetch(`${base}/state/ctrader-env`)).json()

test('the route reports every slot, and is reachable at all', async () => {
  const db = initDB(':memory:')
  const { server, base } = serve(db)
  try {
    const body = await get(base)
    assert.ok(Array.isArray(body.slots), `no slots in ${JSON.stringify(body)}`)
    assert.deepEqual(
      body.slots.map(s => s.kind).sort(),
      ['accessToken', 'accountId', 'clientId', 'clientSecret', 'isLive', 'refreshToken'],
    )
    assert.deepEqual(body.conflicts, [])
    assert.deepEqual(body.ignored, [])
  } finally { server.close() }
})

test('a stored refresh token that differs from env shows up in `ignored`', async () => {
  // The live diagnosis this endpoint was built to settle.
  const db = initDB(':memory:')
  setState(db, 'ctrader_refresh_token', 'the-database-copy')
  process.env.CTRADER_REFRESH_TOKEN = 'the-host-copy'
  const { server, base } = serve(db)
  try {
    const body = await get(base)
    assert.deepEqual(body.ignored, ['refreshToken'])
    const slot = body.slots.find(s => s.kind === 'refreshToken')
    assert.equal(slot.stored, true)
    assert.equal(slot.chosen, 'CTRADER_REFRESH_TOKEN')
  } finally {
    server.close()
    delete process.env.CTRADER_REFRESH_TOKEN
  }
})

test('THE RESPONSE BODY CONTAINS NO CREDENTIAL — asserted on the wire', async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_refresh_token', 'STORED-CREDENTIAL-VALUE')
  process.env.CTRADER_REFRESH_TOKEN = 'ENV-CREDENTIAL-VALUE'
  process.env.CTRADER_CLIENT_SECRET = 'SECRET-CREDENTIAL-VALUE'
  const { server, base } = serve(db)
  try {
    const raw = await (await fetch(`${base}/state/ctrader-env`)).text()
    for (const v of ['STORED-CREDENTIAL-VALUE', 'ENV-CREDENTIAL-VALUE', 'SECRET-CREDENTIAL-VALUE']) {
      assert.ok(!raw.includes(v), `the endpoint leaked ${v}`)
    }
    // ...and it did return something, so the assertion above is not passing
    // on an empty body.
    assert.ok(raw.includes('refreshToken'), raw)
  } finally {
    server.close()
    delete process.env.CTRADER_REFRESH_TOKEN
    delete process.env.CTRADER_CLIENT_SECRET
  }
})
