// node --test agent/routes/state-health-dbsize.test.js
//
// 27-09 follow-up (8), 03-10-2026: GET /state/health `dbSizeMB` was always
// null — the handler called `require('fs')` from an ES module, a
// ReferenceError on every request that its own catch turned into null. The
// route is driven here against a real on-disk database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import stateRouter from './state.js'

function health(db) {
  const router = stateRouter(db)
  const layer = router.stack.find(l => l.route?.path === '/health' && l.route.methods.get)
  assert.ok(layer, 'GET /health is mounted on the state router')
  let body = null
  layer.route.stack[0].handle({ headers: {}, query: {} }, { json: (o) => { body = o } })
  assert.ok(body, 'the handler answered through res.json')
  return body
}

test('GET /state/health reports dbSizeMB from the file SQLite actually opened', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-trade-health-'))
  const path = join(dir, 'agent.db')
  const db = initDB(path)
  t.after(() => { try { db.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })
  // WAL mode: until a checkpoint the schema sits in agent.db-wal and the main
  // file is one 4 KB page. The route reports the main file (as index.js's
  // /health does), so checkpoint first to measure something real.
  db.pragma('wal_checkpoint(TRUNCATE)')
  const bytes = statSync(path).size
  const expected = Math.round(bytes / 1048576 * 10) / 10
  const body = health(db)
  assert.equal(typeof body.dbSizeMB, 'number', `RED on the require('fs') handler: dbSizeMB is null, not a number (${JSON.stringify(body.dbSizeMB)})`)
  assert.equal(body.dbSizeMB, expected, `the stat of the opened file, ${bytes} bytes, to one decimal`)
  assert.ok(bytes > 4096, `a checkpointed schema is more than one page (${bytes} bytes)`)
  assert.equal(typeof body.memoryMB, 'number')
})

test('GET /state/health: an in-memory database has no file, so dbSizeMB is null — the one honest null', () => {
  const db = initDB(':memory:')
  const body = health(db)
  assert.equal(body.dbSizeMB, null)
})
