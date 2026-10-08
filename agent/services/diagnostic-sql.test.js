// Codex · №12,410 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { captureSql, queryId } from './diagnostic-sql.js'

test('real cached statements, transactions, bindings and iterators retain behaviour and restore methods', () => {
  const db = new Database(':memory:'), other = new Database(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const insert = db.prepare('INSERT INTO t VALUES (?,?)'), select = db.prepare('SELECT * FROM t ORDER BY id')
  const original = Object.getPrototypeOf(insert).run, prepare = Object.getPrototypeOf(db).prepare
  let clock = 0
  const stop = captureSql(db, { now: () => clock += 101 })
  assert.equal(insert.run(1, 'never-log-this-secret').changes, 1)
  const abort = Error('same exception')
  const tx = db.transaction(() => { insert.run(2, 'rollback'); throw abort })
  assert.throws(tx, e => e === abort)
  assert.deepEqual([...select.iterate()], [{ id: 1, v: 'never-log-this-secret' }])
  const i = select.iterate(); assert.equal(i.next().value.id, 1); i.return()
  assert.equal(other.prepare('SELECT 42 n').get().n, 42)
  assert.throws(() => insert.run(1, 'duplicate'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
  const result = stop()
  assert.equal(Object.getPrototypeOf(insert).run, original)
  assert.equal(Object.getPrototypeOf(db).prepare, prepare)
  assert.equal(result.details.filter(x => x.op === 'run' && x.queryId === queryId(insert.source)).length, 3)
  assert.equal(result.totals.run.count, 5, 'transaction BEGIN and ROLLBACK are also native statement runs')
  assert.ok(result.details.some(x => x.op === 'next'))
  assert.ok(result.details.some(x => x.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'))
  assert.ok(!JSON.stringify(result).includes('never-log-this-secret'))
  assert.ok(!JSON.stringify(result).includes('INSERT INTO'))
  assert.equal(queryId("SELECT 'private' WHERE 12=12"), queryId("SELECT 'other' WHERE 34=34"))
  db.close(); other.close()
})

test('detail cap and deadline do not cap SQL execution or lose aggregate accounting', () => {
  const db = new Database(':memory:'), s = db.prepare('SELECT ? v')
  let time = 0
  const stop = captureSql(db, { now: () => ++time, thresholdMs: 0, cap: 2, deadline: 10 })
  for (let i = 0; i < 10; i++) assert.equal(s.get(i).v, i)
  const result = stop()
  assert.equal(result.details.length, 2); assert.ok(result.dropped > 0)
  assert.ok(result.totals.get.count < 10)
  assert.equal(s.get(13).v, 13)
  db.close()
})
