import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import stateRouter from './state.js'

async function fixture(t, missing = false) {
  const dir = mkdtempSync(join(tmpdir(), 'postmortem-report-')), db = initDB(join(dir, 'agent.db'))
  const add = db.prepare("INSERT INTO trades(id,symbol,side,status,account_id) VALUES(?,'ETHUSD','BUY',?,?)")
  add.run(1, 'closed', '11'); add.run(2, 'closed', '22'); add.run(3, 'closed', null); add.run(4, 'rejected', '11')
  const pm = db.prepare("INSERT INTO trade_postmortems(trade_id,symbol,strategy,classification,bars_json) VALUES(?,'ETHUSD','tsmom_long','stop_hunt',?)")
  for (let id = 1; id <= 4; id++) pm.run(id, id === 3 ? '{broken' : '[{"c":100}]')
  pm.run(null, 'null')
  const conn = new Proxy(db, { get(target, key) {
    if (key === 'name' && missing) return join(dir, 'missing.db')
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v
  } })
  const app = express(); app.use('/state', stateRouter(conn))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, url: `http://127.0.0.1:${server.address().port}/state/postmortems` }
}

test('postmortems keep scoped/null rows and stats without querying history on management', async t => {
  const { db, url } = await fixture(t), prepare = db.prepare
  let historyReads = 0
  db.prepare = sql => { if (/trade_postmortems|FROM trades/i.test(sql)) { historyReads++; throw Error('management history read') }; return prepare.call(db, sql) }
  let res
  try { res = await fetch(url + '?account=11') } finally { db.prepare = prepare }
  assert.equal(res.status, 200)
  assert.equal(historyReads, 0)
  const body = await res.json()
  assert.deepEqual(body.rows.map(r => r.trade_id), [null, 3, 1])
  assert.equal(body.rows[0].bars, null)
  assert.deepEqual(body.rows[2].bars, [{ c: 100 }])
  assert.ok(body.rows.every(r => !('bars_json' in r)))
  assert.deepEqual(body.stats, [{ strategy: 'tsmom_long', classification: 'stop_hunt', n: 4 }])
  assert.deepEqual(body.pending, { rows: [], waiting: 0, ineligible: 0 })
  assert.equal(body.accountId, '11'); assert.equal(body.scoped, true)
  const all = await (await fetch(url + '?account=all&limit=2')).json()
  assert.deepEqual(all.rows.map(r => r.trade_id), [null, 3]); assert.equal(all.stats[0].n, 5)
})

test('postmortem worker failure is unavailable evidence, not empty successful lessons', async t => {
  const { url } = await fixture(t, true)
  const res = await fetch(url + '?account=11')
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await res.json(), { error: 'Trade lessons are temporarily unavailable. Please retry.', code: 'postmortem_report_unavailable' })
})

test('a locked history database leaves main-thread timers running while the report waits', async t => {
  const { db, url } = await fixture(t)
  db.pragma('journal_mode=DELETE')
  const lock = new Database(db.name); lock.exec('BEGIN EXCLUSIVE')
  t.after(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  let ticks = 0, settled = false
  const timer = setInterval(() => { ticks++ }, 10); t.after(() => clearInterval(timer))
  const request = fetch(url + '?account=11').then(r => { settled = true; return r })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(settled, false); assert.ok(ticks > 0)
  assert.equal((await request).status, 503)
  lock.exec('ROLLBACK')
})
