// The scenario under test is the real one: bot-trade-vol at 100% capacity,
// an agent that cannot boot because a full volume cannot size the WAL's -shm,
// and a compaction pass that only runs inside the agent that cannot boot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import {
  emergencyReclaim, maybeEmergencyReclaim, reclaimableFiles, volumeReport,
  PURGE_TABLES, EMERGENCY_FREE_BYTES,
} from './emergency-reclaim.js'

const quiet = { warn() {}, log() {} }

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'))
  const p = path.join(dir, 'agent.db')
  const db = new Database(p)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE scans (id INTEGER PRIMARY KEY, scanned_at TEXT, blob TEXT);
    CREATE TABLE signals (id INTEGER PRIMARY KEY, recorded_at TEXT, blob TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, closed_at TEXT, net_pnl REAL);
  `)
  return { dir, p, db }
}

test('the WAL is never unlinked — that would discard committed transactions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'))
  for (const n of ['agent.db', 'agent.db-wal', 'agent.db-shm', 'old.bak']) {
    fs.writeFileSync(path.join(dir, n), 'x')
  }
  const names = reclaimableFiles(dir, 'agent.db').map((f) => f.name)
  assert.ok(!names.includes('agent.db'), 'never the database')
  assert.ok(!names.includes('agent.db-wal'), 'never the WAL — data loss')
  assert.ok(names.includes('old.bak'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stale sidecars and crash leftovers are reclaimable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'))
  for (const n of ['agent.db', 'a.tmp', 'b.old', 'agent.db-journal', 'core.123', 'keep.json']) {
    fs.writeFileSync(path.join(dir, n), 'x')
  }
  const names = reclaimableFiles(dir, 'agent.db').map((f) => f.name).sort()
  assert.deepEqual(names, ['a.tmp', 'agent.db-journal', 'b.old', 'core.123'])
  assert.ok(!names.includes('keep.json'), 'unknown files are left alone')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stale files are deleted and the bytes counted', () => {
  const { dir, p, db } = tmpDb()
  fs.writeFileSync(path.join(dir, 'junk.bak'), Buffer.alloc(200_000))
  const r = emergencyReclaim(db, p, { ...quiet, deps: { freeBytes: () => 1_000 } })
  const files = r.steps.find((s) => s.step === 'stale-files')
  assert.equal(files.freedBytes, 200_000)
  assert.ok(!fs.existsSync(path.join(dir, 'junk.bak')))
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('the WAL is truncated, returning real bytes', () => {
  const { dir, p, db } = tmpDb()
  const ins = db.prepare('INSERT INTO scans (scanned_at, blob) VALUES (?, ?)')
  const many = db.transaction(() => {
    for (let i = 0; i < 3000; i += 1) ins.run('2020-01-01 00:00:00', 'x'.repeat(400))
  })
  many()
  const walBefore = fs.statSync(`${p}-wal`).size
  assert.ok(walBefore > 0, 'the WAL has content to reclaim')

  const r = emergencyReclaim(db, p, { ...quiet, deps: { freeBytes: () => 1_000 } })
  const step = r.steps.find((s) => s.step === 'wal-truncate')
  assert.equal(step.ok, true)
  assert.ok(step.freedBytes > 0, 'truncating a populated WAL returns bytes')
  assert.ok(fs.statSync(`${p}-wal`).size < walBefore)
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('old telemetry is purged and recent telemetry is kept', () => {
  const { dir, p, db } = tmpDb()
  const ins = db.prepare('INSERT INTO scans (scanned_at, blob) VALUES (?, ?)')
  ins.run('2020-01-01 00:00:00', 'old')
  ins.run('2020-01-02 00:00:00', 'old')
  const recent = new Date(Date.now() - 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  ins.run(recent, 'recent')

  emergencyReclaim(db, p, { ...quiet, retainDays: 7, deps: { freeBytes: () => 1_000 } })
  const rows = db.prepare('SELECT blob FROM scans').all().map((r) => r.blob)
  assert.deepEqual(rows, ['recent'], 'only rows inside the retention window survive')
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('trades are never touched — an emergency is not a licence to improvise', () => {
  const { dir, p, db } = tmpDb()
  db.prepare('INSERT INTO trades (closed_at, net_pnl) VALUES (?, ?)').run('2019-01-01 00:00:00', -123.45)
  emergencyReclaim(db, p, { ...quiet, retainDays: 1, deps: { freeBytes: () => 1_000 } })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM trades').get().c, 1)
  // Named exactly, not matched loosely: `position_events` is an event LOG that
  // routine housekeeping already prunes, and a substring rule would ban it
  // while permitting a table called `ledger`. The invariant is about the
  // RECORDS — the things that cannot be regenerated — so it names them.
  const FORBIDDEN = ['trades', 'positions', 'orders', 'accounts', 'trade_postmortems',
    'agent_state', 'account_registry', 'labels']
  for (const f of FORBIDDEN) {
    assert.ok(!PURGE_TABLES.some((t) => t.table === f), `${f} must never be purged`)
  }
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('a failing step does not skip the steps after it', () => {
  const { dir, p, db } = tmpDb()
  fs.writeFileSync(path.join(dir, 'junk.bak'), Buffer.alloc(1000))
  const r = emergencyReclaim(db, p, {
    ...quiet,
    // Deleting fails the way a read-only mount would.
    deps: { freeBytes: () => 1_000, unlink: () => { throw new Error('EROFS') } },
  })
  assert.equal(r.steps.find((s) => s.step === 'stale-files').freedBytes, 0)
  assert.equal(r.steps.find((s) => s.step === 'wal-truncate').ok, true,
    'the WAL step still ran after the file step failed')
  assert.ok(r.steps.some((s) => s.step === 'row-purge'))
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('it does not run when the volume is healthy', () => {
  const { dir, p, db } = tmpDb()
  const r = maybeEmergencyReclaim(db, p, { ...quiet, deps: { freeBytes: () => 5_000_000_000 } })
  assert.equal(r.ran, false)
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('it runs when free space is below the emergency floor', () => {
  const { dir, p, db } = tmpDb()
  const r = maybeEmergencyReclaim(db, p, {
    ...quiet, deps: { freeBytes: () => EMERGENCY_FREE_BYTES - 1 },
  })
  assert.equal(r.ran, true)
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('unreadable free space does not trigger a reclaim on a healthy box', () => {
  const { dir, p, db } = tmpDb()
  const r = maybeEmergencyReclaim(db, p, { ...quiet, deps: { freeBytes: () => null } })
  assert.equal(r.ran, false, 'unknown is not an emergency — it is unknown')
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('the volume report lists the largest files first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'))
  fs.writeFileSync(path.join(dir, 'small'), Buffer.alloc(10))
  fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(5000))
  const rep = volumeReport(dir)
  assert.equal(rep[0].name, 'big')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the reclaim runs before the schema writes that would fail on a full disk', () => {
  const src = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const reclaim = src.indexOf('maybeEmergencyReclaim(db, resolvedPath)')
  const tables = src.indexOf('db.exec(TABLES)')
  assert.ok(reclaim > 0 && tables > 0)
  assert.ok(reclaim < tables, 'reclaiming after the first write is reclaiming too late')
})

test('sub-megabyte sizes are reported in kB, never rounded to 0MB', () => {
  const { dir, p, db } = tmpDb()
  fs.writeFileSync(path.join(dir, 'small.bak'), Buffer.alloc(400_000))
  const lines = []
  emergencyReclaim(db, p, {
    log() {}, warn: (m) => lines.push(String(m)),
    deps: { freeBytes: () => 1_000 },
  })
  const removed = lines.find((l) => l.includes('removed small.bak'))
  assert.match(removed, /400kB/)
  assert.ok(!/\(0MB\)/.test(removed), 'a 400kB file must not be reported as 0MB')
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})
