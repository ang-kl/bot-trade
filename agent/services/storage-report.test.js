// node --test agent/services/storage-report.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from '../test-support/temp-dir.js'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { initDB } from '../db.js'
import { storageReport } from './storage-report.js'

const tmpDb = () => {
  const p = path.join(mkdtempSync(path.join(os.tmpdir(), 'storage-')), 'agent.db')
  return { db: initDB(p), p }
}

test('reports file sizes, table rows, and pragma page figures', () => {
  const { db, p } = tmpDb()
  db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', 'y')").run()
  db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', 'y')").run()
  const r = storageReport(db, { dbPath: p })

  assert.ok(r.files.db.bytes > 0, 'the DB file exists and has a size')
  assert.ok(Number.isInteger(r.pageSize) && r.pageSize > 0)
  assert.ok(Number.isInteger(r.pageCount) && r.pageCount > 0)

  const al = r.tables.find(t => t.name === 'action_log')
  assert.ok(al, 'every schema table appears')
  assert.equal(al.rows, 2)
  // dbstat availability varies by build — when present, bytes must be real.
  if (r.dbstatAvailable) assert.ok(al.bytes > 0)
})

test('largest agent_state keys surface with their sizes, biggest first', () => {
  const { db, p } = tmpDb()
  db.prepare("INSERT INTO agent_state (key, value) VALUES ('big', ?)").run('x'.repeat(5000))
  db.prepare("INSERT INTO agent_state (key, value) VALUES ('small', 'y')").run()
  const r = storageReport(db, { dbPath: p, topStateKeys: 5 })
  assert.equal(r.largestStateKeys[0].key, 'big')
  assert.equal(r.largestStateKeys[0].bytes, 5000)
})

test('tables sort by size so the biggest offender reads first', () => {
  const { db, p } = tmpDb()
  const many = db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', ?)")
  for (let i = 0; i < 200; i++) many.run('z'.repeat(500))
  const r = storageReport(db, { dbPath: p })
  const idx = (n) => r.tables.findIndex(t => t.name === n)
  assert.ok(idx('action_log') >= 0)
  // action_log (200 fat rows) must rank above an empty table like scans.
  assert.ok(idx('action_log') < idx('scans'))
})

test('never throws on a db missing optional pieces', () => {
  const { db, p } = tmpDb()
  db.prepare('DROP TABLE agent_state').run()
  const r = storageReport(db, { dbPath: p })
  assert.deepEqual(r.largestStateKeys, [])
  assert.ok(Array.isArray(r.tables))
})

// ---------------------------------------------------------------------------
// V3 M2b (M2 check nit 9): the walk reports what it has measured as it goes,
// so its reader can answer a truthful partial inside its deadline; a step
// that failed is named, not passed off as "none".
// ---------------------------------------------------------------------------
test('progress snapshots: the first before any SQL, each naming what is not yet measured; the final one complete', () => {
  const { db, p } = tmpDb()
  db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', 'y')").run()
  const snapshots = []
  const r = storageReport(db, { dbPath: p, onProgress: s => snapshots.push(s), progressEveryMs: 0 })
  assert.ok(snapshots.length > 3, 'one per step and per table')
  const first = snapshots[0]
  assert.equal(first.status, 'partial')
  assert.ok(first.files.db.bytes > 0, 'file sizes are measured before any SQL')
  assert.equal(first.pageSize, null)
  assert.deepEqual(first.unmeasured.pragmas, ['page_size', 'page_count', 'freelist_count'])
  assert.equal(first.unmeasured.tableList, true)
  assert.equal(first.dbstatAvailable, null, 'not yet tried is not "unavailable"')
  // Midway: the table list is known, and every table not yet counted is
  // named with a null count — never a zero.
  const midway = snapshots.find(s => !s.unmeasured.tableList && s.unmeasured.rows.length > 0)
  assert.ok(midway, 'a snapshot between the table list and the last count')
  for (const name of midway.unmeasured.rows) assert.equal(midway.tables.find(t => t.name === name).rows, null, name)
  assert.equal(r.status, 'complete')
  assert.deepEqual(r.unmeasured, { pragmas: [], tableList: false, largestStateKeys: false, bytes: [], rows: [] })
  assert.deepEqual(r.errors, [])
  assert.equal(r.tables.find(t => t.name === 'action_log').rows, 1)
})

test('bytes per table equal the whole-file SUM(pgsize) GROUP BY name the walk used before M2b', () => {
  const { db, p } = tmpDb()
  const many = db.prepare("INSERT INTO action_log (method, path, body) VALUES ('T', '/x', ?)")
  for (let i = 0; i < 300; i++) many.run('z'.repeat(400))
  const r = storageReport(db, { dbPath: p })
  assert.equal(r.dbstatAvailable, true)
  const before = new Map(db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all().map(x => [x.name, x.bytes]))
  for (const t of r.tables) assert.equal(t.bytes, before.get(t.name) ?? null, t.name)
  assert.ok(r.tables.find(t => t.name === 'action_log').bytes > 4096 * 10)
})

test('progress is throttled: at most one snapshot per progressEveryMs of the clock', () => {
  const { db, p } = tmpDb()
  const snapshots = []
  storageReport(db, { dbPath: p, onProgress: s => snapshots.push(s), progressEveryMs: 1000, clock: () => 5000 })
  assert.equal(snapshots.length, 1, 'a clock that never advances allows only the first')
})

test('a stop request ends the walk before its next statement, keeping what it measured and naming the rest', () => {
  const { db, p } = tmpDb()
  let statements = 0
  const counting = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => { statements++; return target.prepare(sql) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  // Stop once the table list and the agent_state keys are read.
  const r = storageReport(counting, { dbPath: p, shouldStop: () => statements >= 2 })
  assert.equal(r.status, 'partial')
  assert.equal(r.unmeasured.tableList, false)
  assert.equal(r.unmeasured.largestStateKeys, false)
  assert.ok(r.unmeasured.rows.length > 0 && r.unmeasured.rows.length === r.tables.length, 'no table was counted')
  assert.ok(r.tables.every(t => t.rows === null))
  assert.equal(r.dbstatAvailable, null, 'dbstat was never tried')
  assert.equal(statements, 2, 'no statement after the stop')
  assert.deepEqual(r.errors, [])
})

test('a locked database is a partial report naming the failed steps — not "no tables" and not "dbstat unavailable"', () => {
  const { db, p } = tmpDb()
  db.pragma('journal_mode = DELETE')
  const lock = new Database(p)
  const reader = new Database(p, { readonly: true, timeout: 20 })
  try {
    lock.exec('BEGIN EXCLUSIVE')
    const r = storageReport(reader, { dbPath: p })
    assert.equal(r.status, 'partial')
    assert.equal(r.unmeasured.tableList, true)
    assert.deepEqual(r.tables, [])
    assert.notEqual(r.dbstatAvailable, false, 'a lock is not a missing dbstat')
    assert.ok(r.errors.some(e => e.step === 'schema' && /locked/.test(e.message)), JSON.stringify(r.errors))
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK')
    reader.close(); lock.close()
  }
})
