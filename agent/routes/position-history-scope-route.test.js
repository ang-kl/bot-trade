// node --test agent/routes/position-history-scope-route.test.js
//
// V3 I2 (LIFECYCLE-SPEC §7, reporting only): GET /state/position-history
// passed ?account= through raw, so ?account=all filtered on account_id =
// 'all' and answered 0 / 0 — measured on production 25-09-2026 as
// complete 0, incomplete 0 beside 53 / 1,255 for the same read without it.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

function serve(db) {
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

function seed(db) {
  const ins = db.prepare(`INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
                          VALUES (?, ?, ?, ?, ?, ?)`)
  ins.run('111', 'p1', 'EURUSD', Date.parse('2026-09-20T00:00:00Z'), '["direction_reason"]', '{}')
  ins.run('111', 'p2', 'GBPUSD', Date.parse('2026-09-21T00:00:00Z'), '["direction_reason"]', '{}')
  ins.run('222', 'p3', 'USDJPY', Date.parse('2026-09-22T00:00:00Z'), '["planned_entry"]', '{}')
}

test('?account=all reads every account instead of filtering on the literal "all"', async () => {
  const db = initDB(':memory:')
  seed(db)
  setState(db, 'ctrader_account_id', '111')
  const { server, base } = serve(db)
  try {
    const get = (q) => fetch(`${base}/state/position-history${q}`).then(r => r.json())
    const all = await get('?account=all')
    assert.equal(all.incomplete, 3, 'all three rows, not the false zero')
    assert.deepEqual(all.scope, { accountId: null, all: true })
    assert.equal((await get('?account=ALL')).incomplete, 3, 'any case')
    const one = await get('?account=222')
    assert.equal(one.incomplete, 1)
    assert.deepEqual(one.scope, { accountId: '222', all: false })
    // No ?account keeps the route's long-standing default — every account —
    // rather than narrowing to the selected one without saying so.
    const none = await get('')
    assert.equal(none.incomplete, 3)
    assert.deepEqual(none.scope, { accountId: null, all: true })
    assert.deepEqual(none.missingFields, [{ field: 'direction_reason', n: 2 }, { field: 'planned_entry', n: 1 }])
  } finally { server.close() }
})
