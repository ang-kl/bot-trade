import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-http-isolation-'))
  const db = initDB(join(dir, 'fixture.db'))
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('11', 0)
  db.prepare("INSERT INTO monitored_positions(symbol,account_id,source,created_at) VALUES ('EURUSD','11','autopilot',?)").run(new Date().toISOString())
  setState(db, 'telegram_notify_json', '{"enabled":false}')
  const app = express(); app.use('/state', stateRouter(db))
  // Keep expected failures quiet and explicit, instead of Express's HTML error.
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error)
    return res.status(500).json({ error: error.message })
  })
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    db.close(); rmSync(dir, { recursive: true, force: true })
  })
  return { db, url: `http://127.0.0.1:${server.address().port}/state/watchdog` }
}

test('disk-backed watchdog HTTP reads never execute SQL on the management connection', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('watchdog blocked the management connection') }
  const response = await fetch(url)
  db.prepare = prepare
  assert.equal(response.status, 200)
  assert.equal(managementReads, 0)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.service, 'node')
  assert.equal(body.work[0].accountId, '11')
  assert.equal(body.work[0].lastCompletedAtMs, null)
  assert.equal(body.notificationPolicy.enabled, false)
})

test('failed watchdog worker reports unavailable rather than a healthy empty contract', async t => {
  const { db, url } = await fixture(t)
  db.exec('DROP TABLE accounts')
  const response = await fetch(url)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.error, 'watchdog_contract_unavailable')
  assert.equal(body.workComplete, false)
  assert.equal(body.work, undefined)
  assert.equal(body.observedAtMs, undefined)
  // V3 M2b: the typed 503 fields beside the unchanged ones, and the builder's
  // own error — this failure is a missing table, not a temporary outage.
  assert.equal(body.reason, 'performance_report_worker_error')
  assert.equal(body.detail, 'no such table: accounts')
  assert.equal(body.retryAfter, 30)
  assert.equal(response.headers.get('retry-after'), '30')
})
