// Codex · №12,944 · 2026-10-10; codex-footprint: bounded-startup-sql.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createStartupSqlDiagnostic } from './startup-sql-diagnostic.js'
import { queryId } from './diagnostic-sql.js'

const envFor = id => ({ STARTUP_SQL_DIAGNOSTIC_RUN_ID: id,
  STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() })
function fixture(t, id, options = {}) {
  const calls = [], rows = [], db = new Database(':memory:', { verbose: sql => calls.push(sql) })
  t.after(() => db.close())
  const prepare = Object.getPrototypeOf(db).prepare
  const h = createStartupSqlDiagnostic({ env: envFor(id), log: line => rows.push(JSON.parse(line)), ...options })
  assert.ok(h); t.after(() => h.stop())
  h.attach(db)
  assert.deepEqual(calls, [], 'attaching never executes a probe or durable claim')
  return { db, h, rows, calls, prepare }
}

test('startup capture is disabled for missing, malformed, expired or oversized activation', () => {
  const logs = []
  for (const env of [{}, { ...envFor('valid-expired-id'), STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT: '2000-01-01Z' },
    { ...envFor('invalid id') }, { ...envFor('too-future-startup'), STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 3601_000).toISOString() }])
    assert.equal(createStartupSqlDiagnostic({ env, log: row => logs.push(row) }), null)
  assert.equal(createStartupSqlDiagnostic({ env: envFor('invalid-cap-startup'), events: NaN }), null)
  assert.deepEqual(logs, [])
})

test('real cached statements, compound exec, native transactions and iterator closure retain values and restore', t => {
  const { db, h, rows, calls, prepare } = fixture(t, 'native-startup-path')
  const other = new Database(':memory:'); t.after(() => other.close())
  assert.equal(db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT); CREATE INDEX idx_t_v ON t(v)'), db)
  const insert = db.prepare('INSERT INTO t VALUES (?,?)'), select = db.prepare('SELECT * FROM t ORDER BY id')
  const nativeRun = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(insert), 'run').value
  const info = insert.run(1, 'startup-private-value')
  assert.equal(info.changes, 1); assert.equal(info.lastInsertRowid, 1)
  const expected = Error('startup-private-error'), nested = db.transaction(() => { insert.run(3, 'rolled-back'); throw expected })
  const tx = db.transaction(() => { insert.run(2, 'committed'); assert.throws(nested, e => e === expected); return 123 })
  assert.equal(tx.immediate(), 123)
  assert.deepEqual([...select.iterate()], [{ id: 1, v: 'startup-private-value' }, { id: 2, v: 'committed' }])
  const iterator = select.iterate(); assert.equal(iterator.next().value.id, 1); iterator.return()
  assert.throws(() => insert.run(1, 'duplicate'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
  assert.equal(other.prepare('SELECT 42 n').get().n, 42)
  h.stop()
  assert.equal(Object.getPrototypeOf(db).prepare, prepare)
  assert.notEqual(Object.getPrototypeOf(insert).run, nativeRun, 'the installed hook was removed')
  assert.equal(insert.run(3, 'after-stop').changes, 1)
  const spans = rows.filter(r => r.kind === 'span')
  const begin = spans.find(r => r.control === 'begin_immediate'), commit = spans.find(r => r.control === 'commit')
  assert.ok(begin.acquiredAfterReturn)
  assert.ok(commit.reservationHeldThroughStart && commit.reservationReleased)
  assert.equal(begin.transactionId, commit.transactionId)
  assert.ok(spans.some(r => r.control === 'rollback_savepoint' && !r.releaseConfirmed))
  assert.ok(spans.some(r => r.control === 'release_savepoint' && r.inTransactionAfter))
  assert.ok(spans.some(r => r.method === 'exec' && r.compoundExecSpanOnly))
  assert.ok(spans.some(r => r.method === 'next'))
  assert.ok(spans.some(r => r.queryId === queryId(insert.source) && r.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'))
  assert.ok(!spans.some(r => r.queryId === queryId('SELECT 42 n')))
  assert.equal(rows.at(-1).hooksRestored, true)
  for (const secret of ['startup-private-value', 'startup-private-error', 'INSERT INTO', 'CREATE TABLE', 'SELECT *'])
    assert.ok(!JSON.stringify(rows).includes(secret))
  assert.ok(calls.includes('BEGIN IMMEDIATE'), 'actual native transaction controls ran')
})

test('deferred/no-op writes never claim known writer reservation; one run is process-local once', t => {
  const { db, h, rows } = fixture(t, 'deferred-startup-once')
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)')
  const insert = db.prepare('INSERT INTO t VALUES (?)')
  assert.equal(db.transaction(() => { db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY)'); return insert.run(1).changes })(), 1)
  assert.equal(createStartupSqlDiagnostic({ env: envFor('distinct-active-startup') }), null)
  h.stop()
  assert.equal(createStartupSqlDiagnostic({ env: envFor('deferred-startup-once') }), null)
  assert.ok(rows.some(r => r.control === 'begin_deferred' && !r.acquiredAfterReturn))
  assert.ok(!rows.some(r => r.acquiredAfterReturn || r.reservationHeldThroughStart))
  assert.equal(rows.at(-1).durableReplayProtection, false)
})

test('preparing an immediate control inside a real deferred transaction cannot invent reservation', t => {
  const { db, h, rows } = fixture(t, 'prepared-control-startup')
  db.exec('BEGIN DEFERRED')
  const immediate = db.prepare('BEGIN IMMEDIATE')
  assert.equal(db.prepare('SELECT 1 n').get().n, 1)
  const prepared = rows.find(r => r.method === 'prepare' && r.control === 'begin_immediate')
  assert.equal(prepared.acquiredAfterReturn, false)
  assert.equal(prepared.reservationKnownAfter, false)
  assert.ok(rows.filter(r => r.kind === 'span').every(r => !r.acquiredAfterReturn && !r.reservationHeldThroughStart))
  db.exec('ROLLBACK')
  immediate.run()
  assert.equal(db.prepare('SELECT 2 n').get().n, 2)
  db.prepare('COMMIT').run()
  h.stop()
  const acquired = rows.filter(r => r.acquiredAfterReturn)
  assert.equal(acquired.length, 1); assert.equal(acquired[0].method, 'run')
  assert.ok(rows.some(r => r.method === 'get' && r.reservationHeldThroughStart))
  const released = rows.find(r => r.method === 'run' && r.control === 'commit')
  assert.equal(released.transactionId, acquired[0].transactionId)
  assert.equal(released.reservationReleased, true)
})

test('event and byte caps restore hooks while all later business SQL still executes', t => {
  const { db, h, rows, prepare } = fixture(t, 'startup-event-cap', { events: 4 })
  for (let i = 0; i < 12; i++) assert.equal(db.prepare('SELECT ? n').get(i).n, i)
  h.stop()
  assert.ok(rows.length <= 4)
  assert.equal(rows.at(-1).kind, 'exit'); assert.equal(rows.at(-1).reason, 'cap')
  assert.equal(Object.getPrototypeOf(db).prepare, prepare)
  const bytes = [], next = createStartupSqlDiagnostic({ env: envFor('startup-byte-cap'), bytes: 16384, log: line => bytes.push(line) })
  assert.ok(next); next.attach(db)
  for (let i = 0; i < 100; i++) assert.equal(db.prepare('SELECT ? n').get(i).n, i)
  next.stop()
  assert.ok(bytes.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0) <= 16384)
  assert.equal(JSON.parse(bytes.at(-1)).reason, 'cap')
  assert.equal(Object.getPrototypeOf(db).prepare, prepare)
})

test('expired and overrun calls restore without interrupting native work or masking exceptions', t => {
  let clock = 0, wall = Date.now()
  const { db, h, rows, prepare } = fixture(t, 'startup-deadline-span', { monotonic: () => clock, now: () => wall, durationMs: 10 })
  db.function('advance', () => { clock = 15; return 42 })
  assert.equal(db.prepare('SELECT advance() n').get().n, 42)
  assert.equal(rows.at(-1).reason, 'deadline')
  assert.ok(rows.some(r => r.method === 'get' && r.crossedDeadline && r.ms === 15))
  assert.equal(Object.getPrototypeOf(db).prepare, prepare)
  h.stop()
  const expiryRows = [], expiry = createStartupSqlDiagnostic({ env: envFor('startup-wall-expiry'), now: () => wall,
    monotonic: () => 0, log: line => expiryRows.push(JSON.parse(line)) })
  assert.ok(expiry); expiry.attach(db); wall += 61_000
  assert.equal(db.prepare('SELECT 7 n').get().n, 7)
  assert.equal(expiryRows.at(-1).reason, 'deadline'); assert.equal(Object.getPrototypeOf(db).prepare, prepare)
})

test('sink and clock observation failures preserve native thrown objects and restored methods', t => {
  const { db, h, prepare } = fixture(t, 'startup-sink-failure', { log() { throw Error('sink') } })
  const expected = Error('native-function-error')
  db.function('fail', () => { throw expected })
  assert.throws(() => db.prepare('SELECT fail()').get(), e => e === expected)
  h.stop(); assert.equal(Object.getPrototypeOf(db).prepare, prepare)
  let calls = 0
  const broken = createStartupSqlDiagnostic({ env: envFor('startup-clock-failure'), monotonic: () => { if (++calls > 2) throw Error('clock'); return 0 }, log() {} })
  assert.ok(broken); broken.attach(db)
  assert.equal(db.prepare('SELECT 9 n').get().n, 9)
  broken.stop(); assert.equal(Object.getPrototypeOf(db).prepare, prepare)
})
