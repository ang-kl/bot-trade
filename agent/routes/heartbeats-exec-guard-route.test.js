// node --test agent/routes/heartbeats-exec-guard-route.test.js
//
// /state/heartbeats must surface the exec-guard sync's last error, or the
// stamp written by heartbeat.js is a record nobody can read.

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

test('/state/heartbeats exposes execGuardSync from the stamped key', async () => {
  const db = initDB(':memory:')
  const rec = { at: '2026-09-01T00:00:00.000Z', error: 'sidecar 502' }
  setState(db, 'exec_guard_sync_last_error_json', JSON.stringify(rec))
  const { server, base } = serve(db)
  try {
    const body = await fetch(`${base}/state/heartbeats`).then(r => r.json())
    assert.deepEqual(body.execGuardSync, rec)
  } finally { server.close() }
})

test('/state/heartbeats reports execGuardSync: null when nothing is stamped', async () => {
  const db = initDB(':memory:')
  const { server, base } = serve(db)
  try {
    const body = await fetch(`${base}/state/heartbeats`).then(r => r.json())
    assert.ok('execGuardSync' in body, 'the key must be present so the panel can distinguish "clean" from "not wired"')
    assert.equal(body.execGuardSync, null)
  } finally { server.close() }
})
