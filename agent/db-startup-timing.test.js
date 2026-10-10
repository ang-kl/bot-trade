import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
// Codex · №12,944 · 2026-10-10; codex-footprint: bounded-startup-sql.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('database startup reports finite ordered phase timings without SQL or values', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  const timing = db.startupTiming
  assert.ok(timing)
  assert.ok(timing.totalMs >= 0)
  assert.deepEqual(timing.phases.map(p => p.name), [
    'open_and_journal', 'base_schema', 'legacy_repairs', 'column_migrations',
    'indexes', 'history_schema', 'final_migrations_and_seed',
  ])
  for (const phase of timing.phases) {
    assert.deepEqual(Object.keys(phase).sort(), ['ms', 'name'])
    assert.ok(Number.isFinite(phase.ms) && phase.ms >= 0)
  }
  assert.ok(Math.abs(timing.phases.reduce((sum, p) => sum + p.ms, 0) - timing.totalMs) < 0.01)
  assert.equal(db.pragma('synchronous', { simple: true }), 2)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
})

const envFor = id => ({ STARTUP_SQL_DIAGNOSTIC_RUN_ID: id,
  STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() })
function temporaryPaths(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return [join(dir, 'off.db'), join(dir, 'on.db')]
}
const contents = db => ({
  schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
  state: db.prepare('SELECT key,value FROM agent_state ORDER BY key').all(),
  pragmas: ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout'].map(p => [p, db.pragma(p, { simple: true })]),
})

test('actual file initialization captures all startup phases with exact schema/default parity and no diagnostic write', t => {
  const [offPath, onPath] = temporaryPaths(t, 'startup-observe-parity-'), rows = []
  const nativePrepare = Database.prototype.prepare
  const off = initDB(offPath, { env: {} }), on = initDB(onPath, { env: envFor('actual-startup-file'), log: line => rows.push(JSON.parse(line)) })
  t.after(() => { off.close(); on.close() })
  assert.deepEqual(contents(on), contents(off))
  assert.equal(Database.prototype.prepare, nativePrepare)
  assert.equal(rows.at(-1).reason, 'completed'); assert.equal(rows.at(-1).hooksRestored, true)
  assert.equal(rows.at(-1).dropped, 0); assert.equal(rows.at(-1).diagnosticErrors, 0)
  assert.ok(rows.length <= 500)
  assert.ok(rows.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 1, 0) <= 256 * 1024)
  assert.deepEqual([...new Set(rows.filter(r => r.kind === 'span').map(r => r.phase))], on.startupTiming.phases.map(p => p.name))
  assert.ok(rows.some(r => r.method === 'exec' && r.phase === 'history_schema' && r.compoundExecSpanOnly))
  for (const forbidden of [onPath, 'INSERT OR IGNORE', 'CREATE TABLE', 'watchlist_json', 'EURUSD']) assert.ok(!JSON.stringify(rows).includes(forbidden))
  const count = rows.length
  on.prepare('SELECT 123 n').get()
  assert.equal(rows.length, count, 'startup hooks do not remain active after return')
})

test('actual disabled and expired initialization emits no diagnostic and leaves native methods unchanged', t => {
  const rows = [], nativePrepare = Database.prototype.prepare
  for (const env of [{}, { ...envFor('actual-expired-startup'), STARTUP_SQL_DIAGNOSTIC_EXPIRES_AT: '2000-01-01Z' }]) {
    const db = initDB(':memory:', { env, log: line => rows.push(line) })
    t.after(() => db.close())
    assert.equal(Database.prototype.prepare, nativePrepare)
    assert.equal(db.pragma('synchronous', { simple: true }), 2)
  }
  assert.deepEqual(rows, [])
})

test('actual constructor and schema errors retain native errors and partial schema while hooks restore', t => {
  const [offPath, onPath] = temporaryPaths(t, 'startup-observe-failure-'), nativePrepare = Database.prototype.prepare
  for (const path of [offPath, onPath]) {
    const db = new Database(path)
    db.exec('CREATE VIEW refusal_scores AS SELECT 1 AS opportunity_key')
    db.close()
  }
  let baseline, observed
  try { initDB(offPath, { env: {} }) } catch (e) { baseline = e }
  const rows = []
  try { initDB(onPath, { env: envFor('actual-startup-failure'), log: line => rows.push(JSON.parse(line)) }) } catch (e) { observed = e }
  assert.equal(observed.code, baseline.code); assert.equal(observed.message, baseline.message)
  assert.equal(rows.at(-1).reason, 'startup_error'); assert.equal(rows.at(-1).hooksRestored, true)
  assert.ok(rows.some(r => r.kind === 'span' && r.code === baseline.code))
  assert.equal(Database.prototype.prepare, nativePrepare)
  const off = new Database(offPath), on = new Database(onPath)
  t.after(() => { off.close(); on.close() })
  assert.deepEqual(contents(on).schema, contents(off).schema)
  const constructorRows = []
  assert.throws(() => initDB(join(onPath, 'absent', 'db.sqlite'), { env: envFor('actual-constructor-failure'), log: line => constructorRows.push(JSON.parse(line)) }), { name: 'TypeError' })
  assert.ok(constructorRows.some(r => r.method === 'open' && r.code === 'OTHER'))
  assert.equal(constructorRows.at(-1).reason, 'startup_error')
  assert.equal(Database.prototype.prepare, nativePrepare)
})
