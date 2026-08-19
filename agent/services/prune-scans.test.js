// ---------------------------------------------------------------------------
// These tests run against the REAL schema, built by initDB, and execute the
// real statements. The previous version asserted on loop.js SOURCE TEXT and
// was green against `FROM positions` — a table that does not exist in this
// schema at all. A test that matches text near the code instead of exercising
// it is the failure mode in CLAUDE.md #2, and it cost a shipped blocker.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, accountsWithOpenPositions } from '../db.js'
import { pruneScans, heldByAnalyses, DEFAULT_BATCH } from './prune-scans.js'

function realDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prunescans-'))
  const db = initDB(path.join(dir, 'agent.db'))
  return { db, dir, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const OLD = '2020-01-01T00:00:00.000Z'
const CUT = '2024-01-01T00:00:00.000Z'
const NEW = '2030-01-01T00:00:00.000Z'

const addScan = (db, at) =>
  db.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)').run('EURUSD', at).lastInsertRowid
const addAnalysis = (db, scanId, at = OLD) =>
  db.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, ?)').run('EURUSD', at, scanId)

test('foreign_keys is ON — without it none of this bug exists', () => {
  const { db, cleanup } = realDb()
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  cleanup()
})

test('the unguarded DELETE really fails on the real schema', () => {
  const { db, cleanup } = realDb()
  const id = addScan(db, OLD)
  addAnalysis(db, id)
  assert.throws(
    () => db.prepare('DELETE FROM scans WHERE scanned_at < ?').run(CUT),
    /FOREIGN KEY constraint failed/,
  )
  cleanup()
})

test('one referenced row no longer blocks every other deletion', () => {
  const { db, cleanup } = realDb()
  const held = addScan(db, OLD)
  addScan(db, OLD)
  addScan(db, OLD)
  addAnalysis(db, held)

  const r = pruneScans(db, CUT)
  assert.equal(r.changes, 2)
  assert.equal(r.done, true)
  assert.deepEqual(db.prepare('SELECT id FROM scans').all().map((x) => x.id), [held])
  cleanup()
})

test('scans inside the retention window are untouched', () => {
  const { db, cleanup } = realDb()
  addScan(db, OLD)
  addScan(db, NEW)
  pruneScans(db, CUT)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scans').get().c, 1)
  cleanup()
})

test('a NULL scan_id does not swallow the whole NOT IN', () => {
  const { db, cleanup } = realDb()
  addScan(db, OLD)
  addAnalysis(db, null)
  assert.equal(pruneScans(db, CUT).changes, 1, 'a NULL reference must not protect every row')
  cleanup()
})

test('the analysis is never destroyed to make room for the prune', () => {
  const { db, cleanup } = realDb()
  const id = addScan(db, OLD)
  addAnalysis(db, id)
  pruneScans(db, CUT)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analyses').get().c, 1)
  cleanup()
})

test('a held scan is collected once its analysis ages out', () => {
  const { db, cleanup } = realDb()
  const id = addScan(db, OLD)
  addAnalysis(db, id)
  assert.equal(pruneScans(db, CUT).changes, 0)
  assert.equal(heldByAnalyses(db, CUT), 1)
  db.prepare('DELETE FROM analyses').run()
  assert.equal(pruneScans(db, CUT).changes, 1)
  cleanup()
})

test('the delete is batched, and progress is reported between batches', () => {
  const { db, cleanup } = realDb()
  const ins = db.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)')
  const many = db.transaction(() => { for (let i = 0; i < 25; i += 1) ins.run('EURUSD', OLD) })
  many()

  const beats = []
  const r = pruneScans(db, CUT, { batch: 10, onProgress: (n) => beats.push(n) })
  assert.equal(r.changes, 25)
  assert.equal(r.batches, 3, '10 + 10 + 5')
  assert.deepEqual(beats, [10, 20, 25],
    'the heartbeat fires BETWEEN batches — after the whole delete it would be the stall it prevents')
  cleanup()
})

test('hitting the batch cap reports done:false rather than pretending', () => {
  const { db, cleanup } = realDb()
  const ins = db.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)')
  const many = db.transaction(() => { for (let i = 0; i < 12; i += 1) ins.run('EURUSD', OLD) })
  many()
  const r = pruneScans(db, CUT, { batch: 5, maxBatches: 2 })
  assert.equal(r.changes, 10)
  assert.equal(r.done, false, 'the remainder is collected next pass, and says so')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scans').get().c, 2)
  cleanup()
})

test('the FK child index exists — without it the delete is a full analyses scan per row', () => {
  const { db, cleanup } = realDb()
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_analyses_scan_id'"
  ).get()
  assert.ok(idx, 'idx_analyses_scan_id must exist: the FK check is invisible in EXPLAIN QUERY PLAN')
  cleanup()
})

test('the compaction guard queries a table that actually exists', () => {
  // THE TEST THAT WAS MISSING. The shipped guard read `FROM positions`, which
  // is not a table here; it threw at prepare time and disabled compaction
  // entirely. Executing the real helper against the real schema is what makes
  // that impossible to ship again.
  const { db, cleanup } = realDb()
  assert.deepEqual(accountsWithOpenPositions(db), [], 'no open positions in a fresh database')

  db.prepare(
    `INSERT INTO monitored_positions (symbol, status, account_id) VALUES (?, 'active', ?)`
  ).run('EURUSD', '42993489')
  assert.deepEqual(accountsWithOpenPositions(db), ['42993489'])

  db.prepare("UPDATE monitored_positions SET status = 'closed'").run()
  assert.deepEqual(accountsWithOpenPositions(db), [], 'a closed position must not defer compaction for ever')
  cleanup()
})

test('loop.js defers on that helper, and stamps the watchdog after the rebuild', () => {
  const src = fs.readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(src, /accountsWithOpenPositions\(db\)/)
  assert.ok(!/FROM positions\b/.test(src), 'there is no `positions` table — it is monitored_positions')
  assert.ok(!/DELETE FROM scans WHERE scanned_at/.test(src),
    'the unguarded statement failed for months; it must not be re-inlined')

  // Scoped: loop.js stamps lastLoopActivityAt in three other places, so a
  // whole-file match here would pass with the line deleted.
  const start = src.indexOf('const { runCompact }')
  const end = src.indexOf('compaction failed (non-fatal)')
  assert.ok(start > 0 && end > start)
  assert.match(src.slice(start, end), /lastLoopActivityAt = Date\.now\(\)/)
})

test('the default batch is large enough to be useful and small enough to yield', () => {
  assert.ok(DEFAULT_BATCH >= 1000 && DEFAULT_BATCH <= 100_000)
})
