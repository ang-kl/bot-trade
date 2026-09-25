// agent/lib/sqlite-wal-reset.test.js — the SQLite this agent runs carries the
// WAL-reset fix, and a later downgrade turns this file red.
//
// sqlite.org/wal.html §11: SQLite 3.7.0–3.51.2 can corrupt a WAL database when
// two connections in separate threads or processes write or checkpoint at the
// same instant; fixed in 3.51.3 (backports 3.44.6, 3.50.7). The scanner
// bridge's worker is such a second connection. better-sqlite3 11.10.0 bundled
// 3.49.2 (measured in production 25-09-2026); 12.8.0 bundles 3.51.3.
//
// The floor below is written out here on purpose and NOT imported from the
// module under test: lowering the module's constant must not lower the bar
// this file holds the runtime to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'

import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import { parseSqliteVersion, walResetFixed, readSqliteVersion, secondWriterRefusal, WAL_RESET_FIXED_FROM } from './sqlite-wal-reset.js'

const require = createRequire(import.meta.url)
const ROOT = new URL('../../', import.meta.url)
const read = rel => readFileSync(new URL(rel, ROOT), 'utf8')

// 3.51.3 as one comparable integer; independent of parseSqliteVersion.
const FLOOR = 3_051_003
const asInt = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  assert.ok(m, `not a SQLite version: ${v}`)
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])
}

test('the runtime SQLite is at or above 3.51.3 (the WAL-reset fix)', () => {
  const db = new Database(':memory:')
  try {
    const { v, s } = db.prepare('SELECT sqlite_version() AS v, sqlite_source_id() AS s').get()
    assert.ok(asInt(v) >= FLOOR, `runtime SQLite ${v} predates 3.51.3: two writing connections in WAL mode can corrupt the database (sqlite.org/wal.html §11)`)
    assert.ok(s.length > 20, 'the source id is read from the library')
  } finally { db.close() }
})

test('the bridge-shaped second connection, opened in a worker thread on a WAL file made by initDB, runs the fixed SQLite', async () => {
  const dir = tempDir('sqlite-wal-reset-')
  const path = join(dir, 'agent.db')
  const main = initDB(path)
  try {
    assert.equal(main.pragma('journal_mode', { simple: true }), 'wal', 'the production open puts the file in WAL mode')
    // The same open as scanner-bridge-worker.js: its own connection, its own
    // thread, fileMustExist, a 1 s busy timeout, and it writes.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const Database = require(workerData.mod)
      const db = new Database(workerData.path, { fileMustExist: true, timeout: 1000 })
      db.exec('CREATE TABLE IF NOT EXISTS wal_reset_probe (n INTEGER)')
      db.prepare('INSERT INTO wal_reset_probe VALUES (1)').run()
      parentPort.postMessage({ v: db.prepare('SELECT sqlite_version() AS v').get().v, mode: db.pragma('journal_mode', { simple: true }) })
      db.close()
    `, { eval: true, workerData: { path, mod: require.resolve('better-sqlite3') } })
    const reply = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    await worker.terminate()
    assert.equal(reply.mode, 'wal')
    assert.ok(asInt(reply.v) >= FLOOR, `the worker's connection runs SQLite ${reply.v}, which predates 3.51.3`)
    // The main connection sees the worker's committed write.
    assert.equal(main.prepare('SELECT COUNT(*) AS n FROM wal_reset_probe').get().n, 1)
  } finally { main.close() }
})

test('the lockfile pins, and node_modules holds, a better-sqlite3 no older than 12.8.0 (the first bundling SQLite 3.51.3)', () => {
  const pkg = JSON.parse(read('agent/package.json'))
  const lock = JSON.parse(read('agent/package-lock.json'))
  const semverInt = v => { const [a, b, c] = v.split('.').map(Number); return a * 1_000_000 + b * 1_000 + c }
  const range = pkg.dependencies['better-sqlite3']
  const floor = /^\^?(\d+\.\d+\.\d+)$/.exec(range)
  assert.ok(floor, `agent/package.json better-sqlite3 range "${range}" is not a plain ^x.y.z floor`)
  assert.ok(semverInt(floor[1]) >= semverInt('12.8.0'), `the range ${range} admits a release bundling SQLite older than 3.51.3`)
  assert.equal(lock.packages[''].dependencies['better-sqlite3'], range, 'lockfile root and package.json agree')
  const locked = lock.packages['node_modules/better-sqlite3'].version
  assert.ok(semverInt(locked) >= semverInt('12.8.0'), `the lockfile pins better-sqlite3 ${locked}`)
  const installed = require('better-sqlite3/package.json').version
  assert.equal(installed, locked, 'node_modules holds what the lockfile pins (run npm ci in agent/ if this is red)')
})

test('every Node the agent is built and tested on is inside better-sqlite3\'s engines range', () => {
  const engines = require('better-sqlite3/package.json').engines?.node
  assert.ok(engines, 'better-sqlite3 declares its Node range')
  const admits = major => engines.split('||').map(s => s.trim()).some(part => {
    let m
    if ((m = /^(\d+)\.x$/.exec(part))) return Number(m[1]) === major
    if ((m = /^>=\s*(\d+)(?:\.\d+)*$/.exec(part))) return major >= Number(m[1])
    assert.fail(`unparsed engines clause "${part}" in "${engines}" — extend this check rather than pass it`)
  })
  const majors = []
  for (const file of ['Dockerfile', 'agent/Dockerfile']) {
    const froms = [...read(file).matchAll(/^FROM node:(\d+)/gm)].map(m => Number(m[1]))
    assert.ok(froms.length, `${file} names a node base image`)
    majors.push(...froms.map(n => [file, n]))
  }
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/cpp-scanners.yml']) {
    const versions = [...read(file).matchAll(/node-version:\s*(\d+)/g)].map(m => Number(m[1]))
    assert.ok(versions.length, `${file} names a node version`)
    majors.push(...versions.map(n => [file, n]))
  }
  for (const [file, major] of majors) assert.ok(admits(major), `${file} builds on Node ${major}, outside better-sqlite3's engines "${engines}"`)
})

test('walResetFixed follows sqlite.org/wal.html §11: 3.7.0–3.51.2 unfixed, 3.51.3+ fixed, backports 3.44.6 and 3.50.7', () => {
  const cases = [
    ['3.49.2', false], ['3.51.2', false], ['3.7.0', false], ['3.50.6', false], ['3.44.5', false], ['3.45.0', false],
    ['3.51.3', true], ['3.52.0', true], ['3.53.0', true], ['4.0.0', true], ['3.50.7', true], ['3.44.6', true], ['3.44.7', true],
    ['3.51', false], ['3.52', true],
    [null, null], [undefined, null], ['', null], ['three', null], ['3.51.3-beta', null],
  ]
  for (const [v, want] of cases) assert.equal(walResetFixed(v), want, `walResetFixed(${JSON.stringify(v)})`)
  assert.equal(WAL_RESET_FIXED_FROM, '3.51.3')
  assert.deepEqual(parseSqliteVersion(' 3.51.3 '), [3, 51, 3])
})

test('secondWriterRefusal: a fixed runtime is allowed; unfixed, unreadable and degraded-exclusive are refused with the version read', () => {
  const db = new Database(':memory:')
  try {
    assert.equal(readSqliteVersion(db), db.prepare('SELECT sqlite_version() AS v').get().v)
    assert.equal(secondWriterRefusal(db), null, 'the bundled runtime passes')
    assert.deepEqual(secondWriterRefusal(db, { readVersion: () => '3.49.2' }), { reason: 'sqlite_wal_reset_unfixed', sqliteVersion: '3.49.2' })
    assert.deepEqual(secondWriterRefusal(db, { readVersion: () => '3.50.7' }), null)
    assert.deepEqual(secondWriterRefusal(db, { readVersion: () => null }), { reason: 'sqlite_version_unreadable', sqliteVersion: null })
    db.__journalDegraded = { mode: 'wal-exclusive', degraded: true }
    assert.deepEqual(secondWriterRefusal(db, { readVersion: () => '3.51.3' }), { reason: 'db_exclusive_degraded', sqliteVersion: '3.51.3' })
  } finally { db.close() }
  assert.equal(readSqliteVersion({ prepare() { throw new Error('closed') } }), null, 'an unreadable connection reads as null, not a version')
})
