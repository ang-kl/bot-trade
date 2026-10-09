// Codex · №12,809 · 2026-10-10; codex-footprint: retention-lifecycle-attribution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { comparisonRecord, retainComparisons } from './scanner-comparison.js'
import { startContentionDiagnostic, withRetentionDiagnostic } from './contention-diagnostic.js'

const envFor = id => ({ CONTENTION_DIAGNOSTIC_RUN_ID: id, CONTENTION_DIAGNOSTIC_TARGET: 'retention_lifecycle',
  CONTENTION_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() })

test('narrow capture preserves real retention/results, records bounded byte metadata, and avoids fast transaction flood', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  const now = Date.now(), secret = 'private-detail-that-must-not-be-logged'
  for (let i = 0; i < 5; i++) comparisonRecord(db, `row-${i}`, 'cpp-scan-tick', 'matched', { secret }, now)
  const original = Object.getPrototypeOf(db.prepare('SELECT 1')).run, rows = []
  const h = startContentionDiagnostic(db, { env: envFor('retention-narrow-test'), log: line => rows.push(JSON.parse(line)), thresholdMs: 1e6 })
  const insert = db.prepare('INSERT OR REPLACE INTO agent_state VALUES (?,?)'), tx = db.transaction(() => insert.run('fixture', secret))
  for (let i = 0; i < 1000; i++) tx.immediate()
  assert.equal(h.stopped, false)
  assert.equal(rows.length, 1, 'successful fast commit controls cannot exhaust the narrow capture')
  assert.equal(withRetentionDiagnostic(db, () => { retainComparisons(db, now, { cap: 3, chunk: 2 }); return 123 }), 123)
  assert.deepEqual(db.prepare('SELECT id FROM scanner_comparisons ORDER BY rowid').all(), [{ id: 'row-2' }, { id: 'row-3' }, { id: 'row-4' }])
  const failure = Error('same-native-result')
  assert.throws(() => withRetentionDiagnostic(db, () => { throw failure }), x => x === failure)
  h.phase({ phase: 'rule', edge: 'start', ruleId: secret, ruleVersion: 1 })
  h.dispose()
  assert.equal(Object.getPrototypeOf(insert).run, original)
  const metadata = rows.filter(x => x.kind === 'retention_metadata')
  assert.equal(metadata.length, 1); assert.equal(metadata[0].ok, true)
  const comparison = metadata[0].tables.find(x => x.table === 'scanner_comparisons')
  assert.equal(comparison.count, 5); assert.equal(comparison.sample.n, 5)
  assert.equal(comparison.sample.bytes, 5 * Buffer.byteLength(JSON.stringify({ secret })))
  assert.deepEqual(rows.filter(x => x.kind === 'phase').map(x => [x.phase, x.edge, x.ok]), [
    ['retention', 'start', undefined], ['retention', 'end', true], ['retention', 'start', undefined], ['retention', 'end', false],
  ])
  assert.ok(rows.at(-1).hooksRestored)
  assert.ok(!JSON.stringify(rows).includes(secret))
})

test('invalid target fails before claim; absent capture executes the exact supplied operation', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  assert.equal(startContentionDiagnostic(db, { env: { ...envFor('invalid-target-once'), CONTENTION_DIAGNOSTIC_TARGET: 'guess' } }), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_state').get().n, 0)
  assert.equal(withRetentionDiagnostic(db, () => 42), 42)
})

test('a cap reached inside metadata prevents further diagnostic SQL but never skips retention', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  comparisonRecord(db, 'one', 'cpp-scan-tick', 'matched', {}, Date.now())
  const prepared = [], prepare = db.prepare.bind(db)
  db.prepare = sql => { prepared.push(sql); return prepare(sql) }
  const h = startContentionDiagnostic(db, { env: envFor('metadata-cap-once'), events: 3, thresholdMs: 0, log: () => {} })
  prepared.length = 0
  assert.equal(withRetentionDiagnostic(db, () => 456), 456)
  assert.equal(h.stopped, true)
  assert.deepEqual(prepared, ['SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'SELECT COUNT(*) n FROM scanner_references'])
  h.dispose()
})

function actualReportCapture(mode) {
  const path = join(tempDir(`latency-${mode}-`), 'fixture.db')
  const moduleUrl = name => new URL(name, import.meta.url).href
  // Separate process retains production's actual worker stdout and lifecycle,
  // rather than replacing SQL/reporting with stubs. No network/business calls.
  const script = `
    import assert from 'node:assert/strict';
    import {setTimeout as delay} from 'node:timers/promises';
    import {initDB} from ${JSON.stringify(moduleUrl('../db.js'))};
    import {readOrderLifecycle,overrideReportTimingForTest} from ${JSON.stringify(moduleUrl('./performance-populations.js'))};
    import {startContentionDiagnostic} from ${JSON.stringify(moduleUrl('./contention-diagnostic.js'))};
    const db=initDB(${JSON.stringify(path)}), options={account:'all',nowMs:1800000000000};
    const before=await readOrderLifecycle(db,options);
    await delay(50);
    const h=startContentionDiagnostic(db,{env:${JSON.stringify(envFor(`actual-lifecycle-${mode}`))}});
    assert.ok(h);
    const restore=${JSON.stringify(mode)}==='deadline'?overrideReportTimingForTest({deadlineMs:{'order-lifecycle':1}}):()=>{};
    let outcome='';
    try { const after=await readOrderLifecycle(db,options); assert.deepEqual(after,before); outcome='same-report'; }
    catch(e) { if(${JSON.stringify(mode)}!=='deadline')throw e; assert.equal(e.reason,'performance_report_deadline'); outcome=e.reason; }
    finally {restore();}
    await delay(200);
    assert.equal(h.stopped,false,'worker detach must not end main capture');
    h.dispose(); db.close(); console.log(JSON.stringify({testOutcome:outcome}));
  `
  const scriptPath = join(tempDir(`latency-script-${mode}-`), 'fixture.mjs')
  writeFileSync(scriptPath, script)
  return execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 })
    .split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x))
}

test('actual readonly lifecycle worker joins parent/context/rule/SQL/result without changing report or stopping main observer', () => {
  const rows = actualReportCapture('success'), diagnostic = rows.filter(x => x.diagnostic === 'contention-v1')
  assert.equal(rows.at(-1).testOutcome, 'same-report')
  const stages = diagnostic.filter(x => x.kind === 'report_phase')
  for (const stage of ['parent_start', 'worker_entry', 'database_open', 'result_ready', 'parent_result', 'worker_exit'])
    assert.ok(stages.some(x => x.stage === stage), stage)
  assert.equal(new Set(stages.map(x => x.jobId)).size, 1)
  const worker = diagnostic.filter(x => x.role === 'lifecycle-worker')
  assert.ok(worker.some(x => x.kind === 'phase' && x.phase === 'context' && x.edge === 'start'))
  assert.ok(worker.some(x => x.kind === 'phase' && x.ruleId === 'PRE-03' && x.ruleVersion === 2 && x.edge === 'end'))
  const started = worker.filter(x => x.kind === 'statement_start')
  assert.ok(started.length > 0)
  for (const row of started) assert.ok(worker.some(x => x.kind === 'statement' && x.queryId === row.queryId && x.startMonoNs === row.startMonoNs))
  assert.equal(diagnostic.at(-1).kind, 'exit'); assert.equal(diagnostic.at(-1).hooksRestored, true)
  assert.equal(diagnostic.at(-1).dropped, 0)
  assert.ok(diagnostic.length <= 500)
  assert.ok(!JSON.stringify(diagnostic).includes('SELECT '))
})

test('actual parent deadline retains correlated job and original error without guessing an unobserved worker phase', () => {
  const rows = actualReportCapture('deadline'), stages = rows.filter(x => x.kind === 'report_phase')
  assert.equal(rows.at(-1).testOutcome, 'performance_report_deadline')
  const start = stages.find(x => x.stage === 'parent_start'), deadline = stages.find(x => x.stage === 'deadline')
  assert.ok(start && deadline)
  assert.equal(start.jobId, deadline.jobId)
  assert.ok(BigInt(deadline.monoNs) >= BigInt(start.monoNs))
  assert.ok(stages.some(x => x.stage === 'worker_exit' && x.jobId === start.jobId))
})
