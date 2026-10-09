// Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import { startContentionDiagnostic } from './contention-diagnostic.js'
import { startBoundedNodeDiagnostic } from './bounded-node-diagnostic.js'

const require = createRequire(import.meta.url)
const envFor = id => ({ CONTENTION_DIAGNOSTIC_RUN_ID: id,
  CONTENTION_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() })
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'contention-capture-')), path = join(dir, 'agent.db')
  const db = new Database(path, { timeout: 40 })
  db.pragma('journal_mode=WAL')
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT)')
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, path }
}
function worker(t, path, rows) {
  const w = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const Database = require(workerData.database);
      const { startContentionWorkerDiagnostic } = await import(workerData.module);
      const { recordScannerMirrorPage } = await import(workerData.scanner);
      const db = new Database(workerData.path, { timeout: 40 });
      const diag = startContentionWorkerDiagnostic(db, { log: line => parentPort.postMessage({ log: JSON.parse(line) }) });
      parentPort.on('message', command => {
        try {
          if (command === 'hold') {
            db.prepare('BEGIN IMMEDIATE').run();
            db.prepare('INSERT INTO fixture VALUES (?,?)').run(1, 'worker-private-value');
            parentPort.postMessage({ held: true });
          } else if (command === 'rollback') {
            db.prepare('ROLLBACK').run(); parentPort.postMessage({ released: true });
          } else if (command === 'scanner') {
            const receipt = recordScannerMirrorPage(db, 'cpp-scan-tick', { instanceId: 'a'.repeat(64), orderAuthority: false,
              oldestCursor: 1, latestCursor: 0, candidates: [] });
            parentPort.postMessage({ scanner: receipt });
          } else if (command === 'stop') {
            diag?.dispose(); db.close(); parentPort.postMessage({ stopped: true }); parentPort.close();
          }
        } catch (e) { parentPort.postMessage({ failure: e.code || e.message }); }
      });
      parentPort.postMessage({ ready: true, active: !!diag });
    })().catch(e => { throw e });
  `, { eval: true, workerData: { path, database: require.resolve('better-sqlite3'),
    module: new URL('./contention-diagnostic.js', import.meta.url).href,
    scanner: new URL('./scanner-candidates.js', import.meta.url).href } })
  const messages = [], waiters = []
  w.on('message', message => {
    if (message.log) rows.push(message.log)
    else { messages.push(message); for (const wake of waiters.splice(0)) wake() }
  })
  const next = async key => {
    const until = Date.now() + 5000
    while (!messages.some(x => key in x)) {
      assert.ok(Date.now() < until, `worker ${key} timeout: ${JSON.stringify(messages)}`)
      await Promise.race([new Promise(resolve => waiters.push(resolve)), delay(25)])
    }
    const index = messages.findIndex(x => key in x)
    return messages.splice(index, 1)[0]
  }
  t.after(() => w.terminate())
  return { w, next }
}

test('real file worker reservation overlaps actual cached main BUSY; scanner transaction, rollback and redaction retained', async t => {
  const { db, path } = fixture(t), rows = []
  const statement = db.prepare('INSERT INTO agent_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  const original = Object.getPrototypeOf(statement).run
  const handle = startContentionDiagnostic(db, { env: envFor('worker-contention-once'), log: line => rows.push(JSON.parse(line)), thresholdMs: 0 })
  assert.ok(handle)
  const peer = worker(t, path, rows)
  assert.equal((await peer.next('ready')).active, true)
  peer.w.postMessage('hold'); await peer.next('held')
  let thrown
  try { statement.run('independent_watchdog_json', 'main-private-value') } catch (e) { thrown = e }
  assert.equal(thrown?.code, 'SQLITE_BUSY')
  peer.w.postMessage('rollback'); await peer.next('released')
  assert.equal(statement.run('independent_watchdog_json', 'succeeded-after-release').changes, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture').get().n, 0)
  peer.w.postMessage('scanner'); assert.equal((await peer.next('scanner')).scanner.recorded, 0)
  const acquired = rows.find(x => x.role === 'scanner-worker' && x.kind === 'writer_reserved')
  const busy = rows.find(x => x.role === 'main' && x.code === 'SQLITE_BUSY')
  const release = rows.find(x => x.role === 'scanner-worker' && x.control === 'rollback' && x.releaseConfirmed)
  assert.ok(acquired && busy && release)
  assert.equal(acquired.acquiredAfterReturn, true)
  assert.ok(BigInt(acquired.endMonoNs) <= BigInt(busy.startMonoNs))
  // SQLite releases somewhere inside rollback; only its entry safely bounds
  // the end of the known-held interval, not the later native return.
  assert.ok(BigInt(release.startMonoNs) >= BigInt(busy.endMonoNs))
  assert.equal(acquired.transactionId, release.transactionId)
  assert.equal(release.reservationReleased, true)
  assert.equal(release.reservationHeldThroughStart, true)
  assert.equal(busy.operation, 'state:independent_watchdog_json')
  assert.equal(acquired.dbId, busy.dbId); assert.equal(acquired.pid, busy.pid)
  assert.notEqual(acquired.threadId, busy.threadId)
  assert.ok(rows.some(x => x.role === 'scanner-worker' && x.control === 'commit' && x.releaseConfirmed))
  peer.w.postMessage('stop'); await peer.next('stopped')
  handle.dispose()
  assert.equal(Object.getPrototypeOf(statement).run, original)
  assert.equal(rows.at(-1).kind, 'exit'); assert.equal(rows.at(-1).hooksRestored, true)
  const output = JSON.stringify(rows)
  for (const secret of ['main-private-value', 'worker-private-value', 'succeeded-after-release', 'INSERT INTO']) assert.ok(!output.includes(secret))
})

test('disabled/expired and claimed-run restart do not activate or write another claim', t => {
  const { db } = fixture(t)
  assert.equal(startContentionDiagnostic(db, { env: {} }), null)
  assert.equal(startContentionDiagnostic(db, { env: { ...envFor('expired-diagnostic'), CONTENTION_DIAGNOSTIC_EXPIRES_AT: '2000-01-01Z' } }), null)
  assert.equal(startContentionDiagnostic(db, { env: { ...envFor('too-long-diagnostic'), CONTENTION_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 3601_000).toISOString() } }), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_state').get().n, 0)
  const conflictRows = [], originalRun = Object.getPrototypeOf(db.prepare('SELECT 1')).run
  const bothEnv = { ...envFor('overlap-once-diag'), NODE_DIAGNOSTIC_RUN_ID: 'legacy-valid-once',
    NODE_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() }
  assert.equal(startContentionDiagnostic(db, { env: bothEnv, log: line => conflictRows.push(JSON.parse(line)) }), null)
  assert.equal(conflictRows[0].reason, 'legacy_sql_capture_requested')
  assert.equal(Object.getPrototypeOf(db.prepare('SELECT 1')).run, originalRun)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_state').get().n, 0)
  // Exercise the real legacy lifecycle after the new diagnostic refuses,
  // matching index.js ordering. Only CPU profiling is a controlled boundary.
  const legacy = startBoundedNodeDiagnostic(db, { env: bothEnv, log: () => {},
    profileStart: callback => () => callback({ nodes: [], samples: [], timeDeltas: [] }) })
  assert.equal(typeof legacy, 'function')
  db.prepare('SELECT 1').get(); legacy()
  assert.equal(Object.getPrototypeOf(db.prepare('SELECT 1')).run, originalRun)
  const env = envFor('restart-claim-once'), rows = []
  const h = startContentionDiagnostic(db, { env, log: line => rows.push(JSON.parse(line)) })
  assert.equal(startContentionDiagnostic(db, { env: envFor('second-concurrent-diag'), log: line => rows.push(JSON.parse(line)) }), null)
  assert.ok(rows.some(x => x.reason === 'contention_capture_active'))
  h.dispose()
  assert.equal(startContentionDiagnostic(db, { env }), null)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_state WHERE key LIKE 'contention_diagnostic:%'").get().n, 1)
})

test('deferred/savepoint transactions preserve native result/error and never invent immediate reservation', t => {
  const { db } = fixture(t), rows = []
  const insert = db.prepare('INSERT INTO fixture VALUES (?,?)'), expected = Error('same-exception')
  const original = Object.getPrototypeOf(insert).run
  const h = startContentionDiagnostic(db, { env: envFor('nested-once-diag'), log: line => rows.push(JSON.parse(line)), thresholdMs: 0 })
  const nested = db.transaction(() => { insert.run(2, 'nested-private'); throw expected })
  const outer = db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS fixture(id INTEGER PRIMARY KEY,value TEXT)')
    insert.run(1, 'outer-private')
    assert.throws(nested, e => e === expected)
    return 123
  })
  assert.equal(outer(), 123)
  assert.deepEqual(db.prepare('SELECT id FROM fixture').all(), [{ id: 1 }])
  assert.ok(rows.some(x => x.control === 'begin_deferred' && !x.acquiredAfterReturn))
  assert.ok(rows.some(x => x.kind === 'first_write_observed'))
  assert.ok(rows.filter(x => x.kind === 'first_write_observed').every(x => !x.reservationKnownAfter && !x.acquiredAfterReturn))
  assert.ok(rows.some(x => x.control === 'rollback_savepoint' && x.inTransactionAfter && !x.releaseConfirmed))
  assert.ok(rows.some(x => x.control === 'release_savepoint' && x.inTransactionAfter && !x.releaseConfirmed))
  const ids = new Set(rows.filter(x => x.transactionId).map(x => x.transactionId))
  assert.equal(ids.size, 1)
  assert.ok(!rows.some(x => x.kind === 'writer_reserved'))
  h.dispose(); assert.equal(Object.getPrototypeOf(insert).run, original)
})

test('aggregate caps stop hooks without capping SQL execution and deadline restores idle connection', async t => {
  const { db } = fixture(t), rows = [], statement = db.prepare('SELECT ? value')
  const original = Object.getPrototypeOf(statement).get
  const h = startContentionDiagnostic(db, { env: envFor('aggregate-cap-once'), events: 4,
    log: line => rows.push(JSON.parse(line)), thresholdMs: 0 })
  for (let i = 0; i < 12; i++) assert.equal(statement.get(i).value, i)
  h.dispose()
  assert.ok(rows.length <= 4); assert.equal(rows.at(-1).kind, 'exit'); assert.equal(rows.at(-1).reason, 'cap')
  assert.equal(Object.getPrototypeOf(statement).get, original)
  const timed = startContentionDiagnostic(db, { env: envFor('deadline-once-diag'), durationMs: 5, log: () => {} })
  await delay(80)
  assert.equal(timed.stopped, true); assert.equal(timed.hooksRestored, true)
  timed.dispose(); assert.equal(Object.getPrototypeOf(statement).get, original)
})
