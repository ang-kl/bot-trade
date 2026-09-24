import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { engineeringView } from '../services/account-engineering.js'
import stateRouter from './state.js'

async function fixture(t, { missingWorkerFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engineering-http-isolation-'))
  const db = initDB(join(dir, 'fixture.db'))
  db.prepare('INSERT INTO accounts(account_id,is_live,mode) VALUES (?,?,?)').run('11', 0, 'active')
  db.prepare('INSERT INTO accounts(account_id,is_live,mode) VALUES (?,?,?)').run('22', 1, 'manage_only')
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'acct:11:account_balance_usd', '123.45')
  setState(db, 'acct:22:account_balance_usd', '0')
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ accounts: ['11'], connected: true, ok: true }))
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,created_at) VALUES ('11','scan','skip','2026-09-24 01:00:00')").run()
  // The live connection remains usable; its separate report file is missing.
  // This distinguishes a failed worker from a fallback onto management SQL.
  const connection = missingWorkerFile ? new Proxy(db, { get(target, key) {
    if (key === 'name') return join(dir, 'missing.db')
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) : db
  const app = express(); app.use('/state', stateRouter(connection))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    db.close(); rmSync(dir, { recursive: true, force: true })
  })
  return { db, url: `http://127.0.0.1:${server.address().port}/state/account-engineering` }
}

test('account engineering HTTP preserves exact evidence without reading on the management connection', async t => {
  const { db, url } = await fixture(t)
  const expected = engineeringView(db)
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  const prepare = db.prepare
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('report blocked management connection') }
  let response
  try { response = await fetch(url) } finally { db.prepare = prepare }
  assert.equal(response.status, 200)
  assert.equal(managementReads, 0)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), expected)
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before)
})

test('unavailable account report is a 503 and never falls back to management SQL or an empty roster', async t => {
  const { url } = await fixture(t, { missingWorkerFile: true })
  const response = await fetch(url)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { error: 'Account status is temporarily unavailable. Please retry.', code: 'account_engineering_unavailable' })
})
