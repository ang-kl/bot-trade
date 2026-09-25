// agent/services/scanner-bridge-sqlite-gate.test.js — the scanner bridge does
// not open its second writing connection on a SQLite that carries the
// WAL-reset race, nor on a database held in degraded exclusive mode, and it
// says why instead of reading like a bridge nobody enabled.
//
// The approval gate itself (flag, file database, 1..limit profiles) is pinned
// in scanner-bridge-start.test.js; every case here passes that gate, so a
// refusal can only come from the SQLite check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { ensureScannerBridge, startScannerBridge, scannerObserver, scannerBridgeStatus } from './scanner-feed.js'

const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }
const profile = { source: 'cpp-scan-timeframe', feed, strategy: 'fib_confluence', timeframe: '1h', configVersion: 'tf-v1', profileHash: 'h', candidateTtlMs: 60000 }
const env = { SCANNER_BRIDGE_ENABLED: '1', SCANNER_TICK_URL: 'http://tick', SCANNER_TICK_SECRET: 's' }

function fileDb(t) {
  const db = new Database(join(tempDir('scanner-bridge-sqlite-gate-'), 'bridge.db'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO agent_state VALUES (?,?)').run('scanner_mirror_profiles_json', JSON.stringify([profile]))
  t.after(() => db.close())
  return db
}
function workers() {
  const built = []
  const createWorker = (url, options) => {
    const w = Object.assign(new EventEmitter(), { url: String(url), options, sent: [], postMessage(job) { w.sent.push(job) }, terminate: () => Promise.resolve(0), unref() {} })
    built.push(w); return w
  }
  return { built, createWorker }
}
const quietWarn = t => t.mock.method(console, 'warn', () => {})

test('a runtime without the WAL-reset fix (3.49.2, production before this bump) builds no worker and reports why', t => {
  const warn = quietWarn(t)
  const db = fileDb(t), w = workers()
  const readVersion = () => '3.49.2'
  assert.equal(ensureScannerBridge(db, env, { createWorker: w.createWorker, now: 5_000, readVersion }), null)
  assert.equal(scannerObserver(db, { host: feed.host, accountId: 11 }, env, { createWorker: w.createWorker, readVersion }), null,
    'the scan observer gets no bridge to offer into')
  assert.equal(w.built.length, 0, 'no second connection is opened')
  const status = scannerBridgeStatus(db)
  assert.deepEqual([status.enabled, status.orderAuthority, status.refused, status.sqliteVersion], [false, false, 'sqlite_wal_reset_unfixed', '3.49.2'])
  assert.equal(typeof status.refusedAtMs, 'number')
  assert.equal(warn.mock.callCount(), 1, 'the refusal is logged once, not every ensure')
  assert.match(warn.mock.calls[0].arguments[0], /sqlite_wal_reset_unfixed.*3\.49\.2.*3\.51\.3/)
})

test('the bundled runtime passes: the same approved database builds exactly one worker and carries no refusal', t => {
  const db = fileDb(t), w = workers()
  const ensured = ensureScannerBridge(db, env, { createWorker: w.createWorker, now: 5_000 })
  assert.ok(ensured, 'the gate admits the bridge on the SQLite this package bundles')
  assert.equal(w.built.length, 1)
  assert.equal(w.built[0].options.workerData.path, db.name)
  const status = scannerBridgeStatus(db)
  assert.equal(status.enabled, true)
  assert.equal('refused' in status, false)
})

test('a refusal is not stale: once the check passes the worker is built and the status drops the refusal', t => {
  quietWarn(t)
  const db = fileDb(t), w = workers()
  let version = '3.51.2'
  const readVersion = () => version
  assert.equal(ensureScannerBridge(db, env, { createWorker: w.createWorker, readVersion }), null)
  assert.equal(scannerBridgeStatus(db).refused, 'sqlite_wal_reset_unfixed')
  version = '3.51.3'
  assert.ok(ensureScannerBridge(db, env, { createWorker: w.createWorker, readVersion }))
  assert.equal(w.built.length, 1)
  assert.equal(scannerBridgeStatus(db).enabled, true)
  assert.equal(scannerBridgeStatus(db).refused, undefined)
})

test('the degraded exclusive-locking database (lib/wal-open.js fallback) is refused at boot, with the runtime version read', t => {
  quietWarn(t)
  const db = fileDb(t), w = workers()
  db.__journalDegraded = { mode: 'wal-exclusive', degraded: true, storage: 'db=0MB wal=0MB shm=unknown free=0MB' }
  let timerFn = null
  const stop = startScannerBridge(db, { env, createWorker: w.createWorker, setInterval: fn => { timerFn = fn; return { unref() {} } }, clearInterval() {}, now: () => 9_000 })
  timerFn()
  assert.equal(w.built.length, 0, 'neither the boot ensure nor the timer opens a second connection')
  const status = scannerBridgeStatus(db)
  assert.equal(status.refused, 'db_exclusive_degraded')
  assert.equal(status.sqliteVersion, db.prepare('SELECT sqlite_version() AS v').get().v)
  assert.equal(status.enabled, false)
  stop()
})
