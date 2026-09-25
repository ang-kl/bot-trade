// node --test agent/routes/storage-purge.test.js
//
// V3 M2b (M2 check nit 6): POST /actions/storage-purge measured before and
// after with the synchronous storageReport(db) — the dbstat page walk and a
// COUNT(*) per table ON the event loop that runs protection, 20.99 s each in
// production, twice per purge. The measurements now run on the read-only
// storage worker (readStorageReport), and both are fresh walks: `before` is
// never a cached measurement, `after` is a walk that started after the purge.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import { readStorageReport } from '../services/performance-populations.js'
import actionsRouter from './actions.js'

// The storage walk's own statements: the dbstat walk and its table list.
const WALK_SQL = /\bdbstat\b|FROM sqlite_master WHERE type = 'table' AND name NOT LIKE/

test('POST /actions/storage-purge measures before and after on the storage worker, never on the management connection', async t => {
  const dbPath = join(tempDir('storage-purge-'), 'agent.db')
  // reportsDir() and runCompact() follow DB_PATH: keep both inside the fixture.
  const previous = process.env.DB_PATH
  process.env.DB_PATH = dbPath
  t.after(() => { if (previous === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previous })
  const db = initDB(dbPath)
  t.after(() => db.close())
  db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', 'y')").run()
  // A measurement already cached: the purge must not report it as "before".
  const cached = await readStorageReport(db)
  assert.equal(cached.served.source, 'walk')

  const app = express(); app.use(express.json()); app.use('/actions', actionsRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })

  const prepare = db.prepare
  const walkOnManagement = []
  db.prepare = function (sql) {
    if (WALK_SQL.test(String(sql))) walkOnManagement.push(String(sql))
    return prepare.call(this, sql)
  }
  let res
  try {
    res = await fetch(`http://127.0.0.1:${server.address().port}/actions/storage-purge`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  } finally { db.prepare = prepare }
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(walkOnManagement, [], 'RED when the purge walks storage on the event loop')
  assert.equal(body.ok, true)
  for (const [name, m] of [['before', body.before], ['after', body.after]]) {
    assert.equal(m.served.source, 'walk', `${name} is a walk, not the cooldown cache`)
    assert.equal(m.status, 'complete', name)
    assert.ok(m.tables.find(r => r.name === 'action_log').rows >= 1, `${name} counted the rows`)
  }
  assert.notEqual(body.before.at, cached.at, 'before is measured for this purge')
  assert.ok(Date.parse(body.after.walk.startedAt) > Date.parse(body.before.walk.startedAt), 'after is a new walk, started after the purge')
  assert.equal(typeof body.steps.walCheckpoint, 'boolean', 'the purge itself still ran')
})
