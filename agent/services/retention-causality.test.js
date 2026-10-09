// Codex · №12,808 · 2026-10-10; codex-footprint: bounded-retention-range.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { setState, getState } from '../db.js'
import { comparisonRecord, retainComparisons } from './scanner-comparison.js'

const NOW = 1_800_000_000_000, CUTOFF = NOW - 7 * 86_400_000
const rows = db => db.prepare('SELECT rowid,id,source,state,detail,observed_ms FROM scanner_comparisons ORDER BY rowid').all()
const capDelete = sql => /^DELETE FROM scanner_comparisons WHERE rowid IN/.test(sql) && sql.includes('source=?')
function observed(db, before = () => {}, after = () => {}) {
  const statements = []
  const view = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql)
      return new Proxy(statement, { get(stmt, method) {
        const member = Reflect.get(stmt, method, stmt)
        if (!['get', 'all', 'run'].includes(method)) return typeof member === 'function' ? member.bind(stmt) : member
        return (...args) => {
          before({ sql, method, args })
          try {
            const result = member.apply(stmt, args)
            statements.push({ sql, method, args, changes: result?.changes, inTransaction: db.inTransaction })
            return result
          } finally { after({ sql, method, args }) }
        }
      } })
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { view, statements }
}
function expectedRetained(input, cap) {
  return [...new Set(input.map(row => row.source))].flatMap(source => input
    .filter(row => row.source === source && row.observed_ms >= CUTOFF)
    .sort((a, b) => b.observed_ms - a.observed_ms || b.rowid - a.rowid).slice(0, cap))
    .sort((a, b) => a.rowid - b.rowid)
}

test('actual retention preserves exact mixed-source rows, seven-day boundary and timestamp-rowid ties in bounded chunks', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  const times = [CUTOFF - 1, NOW - 2, CUTOFF, NOW, NOW - 1, NOW, CUTOFF - 50, NOW, NOW, NOW - 2, NOW, NOW, NOW]
  db.transaction(() => {
    for (let i = 0; i < times.length; i++) {
      for (const source of ['cpp-scan-tick', 'cpp-scan-timeframe'])
        comparisonRecord(db, `${source}:${i}`, source, i % 2 ? 'matched' : 'mismatch', { sequence: i }, times[i])
    }
    comparisonRecord(db, 'cutoff-kept', 'fixture-third', 'matched', {}, CUTOFF)
    comparisonRecord(db, 'cutoff-deleted', 'fixture-third', 'matched', {}, CUTOFF - 1)
    comparisonRecord(db, 'cpp-scan-tick:0', 'cpp-scan-tick', 'matched', {}, NOW + 1) // identity replay cannot replace an aged row
  })()
  const input = rows(db), expected = expectedRetained(input, 5), keptIds = new Set(expected.map(row => row.id))
  let beforeChunk, expectedChunk
  const { view, statements } = observed(db, ({ sql, args }) => {
    if (!capDelete(sql)) return
    beforeChunk = rows(db)
    expectedChunk = beforeChunk.filter(row => row.source === args[0] && !keptIds.has(row.id))
      .sort((a, b) => a.observed_ms - b.observed_ms || a.rowid - b.rowid).slice(0, 2).map(row => row.id).sort()
  }, ({ sql }) => {
    if (!capDelete(sql)) return
    const remaining = new Set(rows(db).map(row => row.id))
    const deleted = beforeChunk.filter(row => !remaining.has(row.id)).map(row => row.id).sort()
    assert.deepEqual(deleted, expectedChunk, 'each committed chunk selects the exact oldest remaining eligible IDs')
  })
  retainComparisons(view, NOW, { cap: 5, chunk: 2 })
  assert.deepEqual(rows(db), expected, 'compare every retained ID and field with an independent policy calculation')
  const deletes = statements.filter(entry => capDelete(entry.sql))
  assert.ok(deletes.some(entry => entry.changes === 2), 'exercise more than one committed chunk')
  assert.ok(deletes.some(entry => entry.changes === 0), 'exercise the empty tail after an exact multiple of chunks')
  assert.ok(deletes.every(entry => entry.changes <= 2 && !entry.inTransaction))
  for (const source of ['cpp-scan-tick', 'cpp-scan-timeframe'])
    assert.deepEqual(deletes.filter(entry => entry.args[0] === source).map(entry => entry.changes), [2, 2, 2, 0])
  assert.ok(expected.some(row => row.id === 'cutoff-kept'))
  retainComparisons(view, NOW, { cap: 5, chunk: 2 })
  assert.deepEqual(rows(db), expected, 'an already-retained population is unchanged')
})

test('a full retained source has bounded index searches for both timestamp and rowid tails, including 100k tied rows', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.transaction(() => {
    for (let i = 0; i < 100_000; i++) comparisonRecord(db, `tick:${i}`, 'cpp-scan-tick', 'matched', {}, NOW)
    for (let i = 0; i < 7; i++) comparisonRecord(db, `tf:${i}`, 'cpp-scan-timeframe', 'matched', {}, NOW - i)
  })()
  const expected = rows(db), { view, statements } = observed(db)
  retainComparisons(view, NOW)
  assert.deepEqual(rows(db), expected, 'the complete retained population, not only counts, stays intact')
  const deletes = statements.filter(entry => capDelete(entry.sql))
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].changes, 0)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${deletes[0].sql}`).all(...deletes[0].args).map(row => row.detail).join('\n')
  // An index scan constrained only by source still walks all 100k retained
  // entries under a write reservation. A timestamp-only bound also walks all
  // tied entries. Require both useful search ranges, without a temp sort.
  assert.match(plan, /COVERING INDEX scanner_comparison_source_age \(source=\? AND observed_ms<\?\)/)
  assert.match(plan, /COVERING INDEX scanner_comparison_source_age \(source=\? AND observed_ms=\? AND rowid<\?\)/)
  assert.doesNotMatch(plan, /TEMP B-TREE FOR ORDER BY/)
  assert.equal(db.inTransaction, false)
})

function twoConnections(t, count) {
  const path = join(tempDir('retention-causality-'), 'fixture.db'), main = new Database(path)
  main.pragma('journal_mode=WAL'); main.pragma('synchronous=FULL')
  // Zero is a fixture-only contention detector; no elapsed-time assertion or
  // application timeout change follows from these checks.
  main.pragma('busy_timeout=0')
  main.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  for (let i = 0; i < count; i++) comparisonRecord(main, `tick:${i}`, 'cpp-scan-tick', 'matched', {}, NOW)
  const worker = new Database(path, { fileMustExist: true, timeout: 0 })
  t.after(() => { worker.close(); main.close() })
  return { main, worker }
}

test('actual retention edge can read during a main writer reservation, while its empty DELETE must acquire a writer', t => {
  const { main, worker } = twoConnections(t, 3), expected = rows(worker)
  setState(main, 'retention_fixture', 'committed')
  let readWhileReserved = false, blockedDelete = false
  const { view } = observed(worker, ({ sql, method }) => {
    if (method === 'get' && /SELECT observed_ms at, rowid id/.test(sql)) {
      main.exec('BEGIN IMMEDIATE')
      setState(main, 'retention_fixture', 'edge-writer')
      readWhileReserved = true
    }
    if (method === 'run' && capDelete(sql)) {
      assert.equal(main.inTransaction, false)
      main.exec('BEGIN IMMEDIATE')
      setState(main, 'retention_fixture', 'uncommitted')
      blockedDelete = true
    }
  }, ({ sql, method }) => {
    if (method === 'get' && /SELECT observed_ms at, rowid id/.test(sql)) main.exec('COMMIT')
  })
  try {
    assert.throws(() => retainComparisons(view, NOW, { cap: 3, chunk: 2 }), { code: 'SQLITE_BUSY' })
    assert.ok(readWhileReserved && blockedDelete)
    assert.equal(main.inTransaction, true)
    assert.equal(worker.inTransaction, false)
    assert.equal(getState(worker, 'retention_fixture'), 'edge-writer', 'the writer being waited on is the main connection')
    assert.deepEqual(rows(worker), expected)
  } finally { if (main.inTransaction) main.exec('ROLLBACK') }
  retainComparisons(worker, NOW, { cap: 3, chunk: 2 })
  assert.deepEqual(rows(worker), expected)
  assert.equal(getState(main, 'retention_fixture'), 'edge-writer')
})

test('an actual retention row deletion owns the writer reservation and releases it before returning', t => {
  const { main, worker } = twoConnections(t, 4), expected = expectedRetained(rows(worker), 3)
  let probes = 0
  worker.function('retention_writer_probe', () => {
    probes++
    assert.throws(() => setState(main, 'retention_fixture', 'blocked'), { code: 'SQLITE_BUSY' })
    return 0
  })
  // This fixture-only trigger observes a point during the actual DELETE;
  // it does not claim statement entry is the reservation-acquisition time.
  worker.exec('CREATE TEMP TRIGGER retention_writer_probe BEFORE DELETE ON scanner_comparisons BEGIN SELECT retention_writer_probe(); END')
  retainComparisons(worker, NOW, { cap: 3, chunk: 2 })
  assert.equal(probes, 1)
  assert.deepEqual(rows(worker), expected)
  setState(main, 'retention_fixture', 'released')
  assert.equal(getState(worker, 'retention_fixture'), 'released')
  assert.equal(worker.inTransaction, false)
})
