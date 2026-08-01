// node --test agent/services/storage-report.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from '../db.js'
import { storageReport } from './storage-report.js'

const tmpDb = () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-')), 'agent.db')
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
