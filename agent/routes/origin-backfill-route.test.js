// node --test agent/routes/origin-backfill-route.test.js
//
// A REPAIR NOBODY CAN REACH IS NOT A CAUTIOUS REPAIR, IT IS A DEAD ONE
// (early-trim-route.test.js, quoted in CLAUDE.md's failure mode #4).
//
// The origin backfill has existed as long as the column has, in a script that
// needs a shell on the Railway container. Nobody has ever had one, so `origin`
// is null on 93% of trades and `GET /state/exit-counterfactual` returns
// INSUFFICIENT with 5 eligible rows out of 81. This file pins the route that
// makes it reachable — and, more importantly, pins that reaching it cannot
// write anything by accident.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import actionsRouter from './actions.js'

const TOKEN = 'sess_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function serve() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  const ins = db.prepare(
    "INSERT INTO trades (id, symbol, side, status, source, risk_event_id, origin, origin_source) VALUES (?,?,?,?,?,?,?,?)")
  ins.run(1, 'EURUSD', 'long', 'closed', 'autotrade', 11, null, null)
  ins.run(2, 'GBPUSD', 'long', 'closed', 'manual', null, null, null)
  ins.run(3, 'USDJPY', 'long', 'closed', 'autotrade', 12, 'bot_market_dispatch', 'write')
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  return { db, server, base: `http://127.0.0.1:${server.address().port}` }
}

const post = (base, body) => fetch(`${base}/actions/backfill-trade-origin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body ?? {}),
})

const originOf = (db, id) => db.prepare('SELECT origin, origin_source FROM trades WHERE id = ?').get(id)

test('AN EMPTY BODY WRITES NOTHING — dry run is the default over HTTP too', () => {
  // The property that matters most on a route: this touches every historical
  // trade row, and a caller who forgets a flag must get the plan, not a write.
  const { db, server, base } = serve()
  return post(base).then(r => r.json()).then(body => {
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.dryRun, true)
    assert.equal(body.written, 0)
    assert.equal(body.rows, 2)
    assert.equal(originOf(db, 1).origin, null, 'a default POST wrote to the table')
  }).finally(() => server.close())
})

test('the plan comes back with counts, so the derivation can be read first', () => {
  const { server, base } = serve()
  return post(base).then(r => r.json()).then(body => {
    assert.deepEqual(body.counts, { bot_market_dispatch: 1, manual_broker: 1 })
  }).finally(() => server.close())
})

test('apply: true writes, and leaves write-time origins alone', () => {
  const { db, server, base } = serve()
  return post(base, { apply: true }).then(r => r.json()).then(body => {
    assert.equal(body.written, 2, JSON.stringify(body))
    assert.equal(originOf(db, 1).origin_source, 'backfill')
    assert.deepEqual(originOf(db, 3), { origin: 'bot_market_dispatch', origin_source: 'write' })
  }).finally(() => server.close())
})

test('rollback needs apply too, and clears only what the backfill wrote', async () => {
  const { db, server, base } = serve()
  try {
    await post(base, { apply: true })
    const dry = await (await post(base, { rollback: true })).json()
    assert.equal(dry.dryRun, true)
    assert.equal(dry.wouldClear, 2)
    assert.equal(originOf(db, 1).origin, 'bot_market_dispatch', 'a dry-run rollback cleared a row')

    const done = await (await post(base, { rollback: true, apply: true })).json()
    assert.equal(done.cleared, 2)
    assert.equal(originOf(db, 1).origin, null)
    assert.equal(originOf(db, 3).origin, 'bot_market_dispatch', 'rollback reached past the backfill')
  } finally { server.close() }
})

test('THE ROUTE IS BEHIND AUTH — asserted where auth actually lives', () => {
  // Not in this harness. `authMiddleware` is applied in index.js, so a test
  // that POSTs at a bare router and expects a 401 is testing its own scaffold
  // and will pass on a route mounted anywhere. The real property is ordering:
  // /actions must mount AFTER app.use(authMiddleware). This route rewrites the
  // column every edge measurement is scoped by, so an unauthenticated caller
  // reaching it would be able to relabel the dataset.
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const auth = src.indexOf('app.use(authMiddleware)')
  const mount = src.indexOf("app.use('/actions', actionsRouter(db))")
  assert.ok(auth > 0, 'authMiddleware is no longer applied in index.js')
  assert.ok(mount > 0, 'the actions router mount moved — re-point this test, do not delete it')
  assert.ok(mount > auth, 'the actions router now mounts BEFORE auth')
})
