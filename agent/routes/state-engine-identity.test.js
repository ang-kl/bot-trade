import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { upsertAccount } from '../services/account-registry.js'
import { entryEnginesView, requestEntryMode } from '../services/entry-mode.js'
import { tickReadinessView } from '../services/tick-readiness.js'

test('control HTTP reads bind same-suffix accounts, revisions and readiness without changing default report redaction', async () => {
  const db = initDB(':memory:')
  const ids = ['11119908', '22229908']
  for (const accountId of ids) upsertAccount(db, { accountId, isLive: false })
  requestEntryMode(db, ids[1], 'STOPPED')
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  assert.equal(entryEnginesView(db).accounts.some(a => 'routingAccountId' in a), false)
  assert.equal(tickReadinessView(db).accounts.some(a => 'routingAccountId' in a), false)
  const app = express(); app.use('/state', stateRouter(db))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const read = async path => { const r = await fetch(base + path); assert.equal(r.status, 200); return r.json() }
    const engines = await read('/state/entry-engines')
    const readiness = await read('/state/tick-readiness')
    assert.deepEqual(engines.accounts.map(a => a.accountId), ['…9908', '…9908'])
    assert.deepEqual(engines.accounts.map(a => a.routingAccountId), ids)
    assert.deepEqual(readiness.accounts.map(a => a.routingAccountId), ids)
    for (const engine of engines.accounts) {
      const ready = readiness.accounts.find(r => r.routingAccountId === engine.routingAccountId)
      assert.equal(ready.configRevision, engine.configRevision)
      assert.equal(ready.requestedEntryMode, engine.requestedEntryMode)
    }
    const one = await read('/state/tick-readiness?account=' + ids[1])
    assert.equal(one.routingAccountId, ids[1]); assert.equal(one.requestedEntryMode, 'STOPPED')
    assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before)
  } finally { await new Promise(resolve => server.close(resolve)); db.close() }
})
