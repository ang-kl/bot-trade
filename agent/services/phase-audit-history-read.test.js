// V3 retained-history regression: phase-audit reads must seek the relevant
// audit families while retaining the exact legacy SQL response contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from '../routes/state.js'
import { recentPhaseAudit, phaseAuditSplit } from './phase-audit.js'

const columns = 'id, at, method, path, body, account_id'
const patterns = {
  recent: ['/phase/%', '/controller/%', '/arm/%'],
  switches: ['/phase/%', '/arm/%'],
  controllerEvents: ['/controller/%'],
}
const shape = r => {
  let body
  try { body = JSON.parse(r.body) } catch { body = r.body }
  return { id: r.id, at: r.at, path: r.path, accountId: r.account_id ?? null,
    ...((body && typeof body === 'object') ? body : { raw: body }) }
}
function legacy(db, family, { limit = 100, accountId = null } = {}) {
  const scoped = accountId != null && accountId !== ''
  const scope = scoped ? 'AND (account_id = ? OR account_id IS NULL)' : ''
  try {
    return db.prepare(`SELECT ${columns} FROM action_log
      WHERE method = 'AUDIT' AND (${patterns[family].map(() => 'path LIKE ?').join(' OR ')})
      ${scope} ORDER BY id DESC LIMIT ?`)
      .all(...patterns[family], ...(scoped ? [String(accountId)] : []), Math.min(500, Math.max(1, limit)))
      .map(shape)
  } catch { return [] }
}
const rowDigest = db => createHash('sha256').update(JSON.stringify(
  db.prepare(`SELECT ${columns} FROM action_log ORDER BY id`).all(),
)).digest('hex')

function fixture(t, { legacySchema = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phase-audit-history-'))
  const filename = join(dir, 'agent.db')
  let db
  t.after(() => { if (db?.open) db.close(); rmSync(dir, { recursive: true, force: true }) })
  if (legacySchema) {
    db = new Database(filename)
    db.exec(`CREATE TABLE action_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')), method TEXT, path TEXT NOT NULL, body TEXT);
      INSERT INTO action_log (at,method,path,body) VALUES ('2026-09-01', 'AUDIT', '/phase/old', '{"reason":"retained"}')`)
    db.close()
  }
  db = initDB(filename)
  return { get db() { return db }, reopen() { db.close(); db = initDB(filename); return db } }
}

function seed(db) {
  const insert = db.prepare('INSERT INTO action_log (at,method,path,body,account_id) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    // Relevant history precedes a much larger unrelated tail. Within it,
    // controller traffic dominates switch flips and account B dominates A.
    for (let i = 0; i < 18000; i++) {
      const relevant = i < 1800
      const path = relevant ? (i % 7 ? `/controller/worker${i % 3}/ok` : `/phase/flag${i % 2}`) : '/unrelated/history'
      insert.run('2026-09-27T23:45:00.000Z', relevant ? 'AUDIT' : 'POST', path,
        JSON.stringify({ reason: `row ${i}`, detail: 'retained '.repeat(12) }), i % 13 === 0 ? null : i % 11 === 0 ? 'A' : 'B')
    }
    for (const [method, path, body, account] of [
      ['AUDIT', '/arm/A', '{"reason":"arm"}', 'A'],
      ['AUDIT', '/PhAsE/mixed', '{"reason":"case insensitive"}', null],
      ['AUDIT', '/CONTROLLER/UPPER/OK', 'not json', 'A'],
      ['AUDIT', '/ARM/A', 'null', 'A'],
      ['AUDIT', '/phase/', '["array"]', null],
      ['AUDIT', '/phase/override', '{"id":-99,"at":"body timestamp","path":"body path"}', 'A'],
      ['AUDIT', '/controller/', '7', 'B'],
      ['AUDIT', '/phase', '{}', null],
      ['AUDIT', '/phaseX/near', '{}', null],
      ['audit', '/phase/wrong-method-case', '{}', null],
      ['POST', '/phase/wrong-method', '{}', null],
      ['AUDIT', '/phäse/not-ascii', '{}', null],
    ]) insert.run('2026-09-27T23:45:00.000Z', method, path, body, account)
  })()
}

function captureReads(db, read) {
  const prepare = db.prepare.bind(db)
  const calls = []
  db.prepare = sql => {
    const statement = prepare(sql)
    if (!/^\s*SELECT/.test(sql) || !sql.includes('FROM action_log')) return statement
    return { all(...params) { calls.push({ sql, params }); return statement.all(...params) } }
  }
  try { read() } finally { db.prepare = prepare }
  return calls.map(({ sql, params }) => ({
    plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params),
    bytecode: prepare(`EXPLAIN ${sql}`).all(...params),
  }))
}

test('retained phase-audit reads use family indexes and preserve legacy contents, scope, tied timestamps and caps', t => {
  const { db } = fixture(t)
  seed(db)
  const digest = rowDigest(db)
  for (const accountId of [null, 'A', 'B', 'unknown', "A' OR 1=1 --", 0, '']) {
    for (const limit of [1, 2, 100, 500, 900, 0, -1, NaN, Infinity, 1.5, '2', 'invalid']) {
      const options = { accountId, limit }
      assert.deepEqual(recentPhaseAudit(db, options), legacy(db, 'recent', options))
      assert.deepEqual(phaseAuditSplit(db, options), {
        switches: legacy(db, 'switches', options),
        controllerEvents: legacy(db, 'controllerEvents', options),
      })
    }
  }
  for (const accountId of [null, 'A', 'unknown']) {
    const plans = captureReads(db, () => {
      phaseAuditSplit(db, { accountId })
      recentPhaseAudit(db, { accountId })
    })
    assert.equal(plans.length, 3, 'recent remains one statement, preserving one SQLite read snapshot')
    const steps = plans.flatMap(p => p.plan).map(p => p.detail)
    assert.ok(steps.some(s => s.includes('USING INDEX idx_action_log_phase_switches')), steps.join('\n'))
    assert.ok(steps.some(s => s.includes('USING INDEX idx_action_log_phase_controllers')), steps.join('\n'))
    assert.ok(!steps.some(s => s === 'SCAN action_log'), 'no full action_log scan')
    // Foreign-account rejection must not dereference each large payload row.
    // Both output and filter can obtain account_id from the narrow index.
    const tableRoot = db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='action_log'").get().rootpage
    const accountColumn = db.prepare('PRAGMA table_info(action_log)').all().find(c => c.name === 'account_id').cid
    for (const { bytecode } of plans) {
      const tableCursors = new Set(bytecode.filter(op => op.opcode === 'OpenRead' && op.p2 === tableRoot).map(op => op.p1))
      assert.ok(!bytecode.some(op => op.opcode === 'Column' && tableCursors.has(op.p1) && op.p2 === accountColumn),
        'account filtering must read the index rather than the retained payload table')
    }
  }
  assert.equal(rowDigest(db), digest, 'read optimisation never changes the retained audit records')
})

test('phase-audit indexes migrate pre-account schemas, survive reopen and follow inserts, updates and retention', t => {
  const f = fixture(t, { legacySchema: true })
  let db = f.db
  assert.equal(recentPhaseAudit(db)[0].reason, 'retained')
  seed(db)
  const digest = rowDigest(db)
  const before = phaseAuditSplit(db)
  db = f.reopen()
  assert.equal(rowDigest(db), digest)
  assert.deepEqual(phaseAuditSplit(db), before)
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(db.pragma('synchronous', { simple: true }), 2, 'FULL durability retained')
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_action_log_phase_%' ORDER BY name").all().map(r => r.name),
    ['idx_action_log_phase_controllers', 'idx_action_log_phase_switches'])
  db.prepare("INSERT INTO action_log(method,path,body,account_id) VALUES ('AUDIT','/phase/new','{}','A')").run()
  const id = db.prepare('SELECT max(id) AS id FROM action_log').get().id
  db.prepare("UPDATE action_log SET path='/controller/new/ok', account_id='B' WHERE id=?").run(id)
  for (const accountId of [null, 'A', 'B']) {
    assert.deepEqual(phaseAuditSplit(db, { accountId }), {
      switches: legacy(db, 'switches', { accountId }),
      controllerEvents: legacy(db, 'controllerEvents', { accountId }),
    })
  }
  db.prepare("UPDATE action_log SET method='POST' WHERE id=?").run(id)
  db.prepare('DELETE FROM action_log WHERE id < 1400').run()
  assert.deepEqual(recentPhaseAudit(db), legacy(db, 'recent'))
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  db = f.reopen()
  assert.deepEqual(recentPhaseAudit(db), legacy(db, 'recent'))
})

test('phase-audit HTTP response retains account isolation and split payload under retained history', async t => {
  const { db } = fixture(t)
  seed(db)
  const app = express()
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  try {
    for (const account of ['all', 'A', 'B', 'unknown']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/state/phase-audit?account=${account}&limit=2`)
      assert.equal(response.status, 200)
      const body = await response.json()
      const options = { accountId: account === 'all' ? null : account, limit: 2 }
      assert.deepEqual(body, {
        scope: account === 'all' ? 'all accounts' : `account ${account} (not in the registry)`,
        switches: legacy(db, 'switches', options),
        controllerEvents: legacy(db, 'controllerEvents', options),
      })
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})
