// Reproduces the production failure exactly: foreign_keys ON, an analysis
// pointing at an old scan, and a DELETE that took the whole statement down.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { pruneScans, heldByAnalyses } from './prune-scans.js'

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prunescans-'))
  const d = new Database(path.join(dir, 'a.db'))
  d.pragma('foreign_keys = ON')          // as production runs
  d.exec(`
    CREATE TABLE scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      scanned_at TEXT NOT NULL
    );
    CREATE TABLE analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      scan_id INTEGER REFERENCES scans(id)
    );
  `)
  return { d, dir }
}

const OLD = '2020-01-01T00:00:00.000Z'
const OLDER = '2019-01-01T00:00:00.000Z'
const CUT = '2024-01-01T00:00:00.000Z'
const NEW = '2030-01-01T00:00:00.000Z'

test('the unguarded DELETE really does fail — this is the bug, not a theory', () => {
  const { d, dir } = db()
  d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)').run('EURUSD', OLD)
  d.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, 1)').run('EURUSD', OLD)
  assert.throws(
    () => d.prepare('DELETE FROM scans WHERE scanned_at < ?').run(CUT),
    /FOREIGN KEY constraint failed/,
  )
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('one referenced row no longer blocks every other deletion', () => {
  const { d, dir } = db()
  const ins = d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)')
  ins.run('EURUSD', OLD)      // id 1 — referenced
  ins.run('GBPUSD', OLD)      // id 2
  ins.run('USDJPY', OLDER)    // id 3
  d.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, 1)').run('EURUSD', OLD)

  const r = pruneScans(d, CUT)
  assert.equal(r.changes, 2, 'the two unreferenced old scans go')
  const left = d.prepare('SELECT id FROM scans ORDER BY id').all().map((x) => x.id)
  assert.deepEqual(left, [1], 'only the referenced one is held back')
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('scans inside the retention window are never touched', () => {
  const { d, dir } = db()
  const ins = d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)')
  ins.run('EURUSD', OLD)
  ins.run('GBPUSD', NEW)
  pruneScans(d, CUT)
  const left = d.prepare('SELECT symbol FROM scans').all().map((x) => x.symbol)
  assert.deepEqual(left, ['GBPUSD'])
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('a held scan is collected once its analysis ages out', () => {
  const { d, dir } = db()
  d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)').run('EURUSD', OLD)
  d.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, 1)').run('EURUSD', OLD)
  assert.equal(pruneScans(d, CUT).changes, 0)
  assert.equal(heldByAnalyses(d, CUT), 1)

  d.prepare('DELETE FROM analyses').run()          // its own retention runs
  assert.equal(pruneScans(d, CUT).changes, 1, 'the next pass collects it')
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('the analysis itself is never deleted to make room for the prune', () => {
  const { d, dir } = db()
  d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)').run('EURUSD', OLD)
  d.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, 1)').run('EURUSD', OLD)
  pruneScans(d, CUT)
  assert.equal(d.prepare('SELECT COUNT(*) c FROM analyses').get().c, 1,
    'an analysis is the reasoning behind a trade — retention must not destroy it')
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('a NULL scan_id does not swallow the whole NOT IN', () => {
  // SQL trap: `id NOT IN (SELECT scan_id ...)` yields NULL — and deletes
  // NOTHING — the moment one scan_id is NULL. The WHERE clause guards it.
  const { d, dir } = db()
  d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?, ?)').run('EURUSD', OLD)
  d.prepare('INSERT INTO analyses (symbol, analyzed_at, scan_id) VALUES (?, ?, NULL)').run('X', OLD)
  assert.equal(pruneScans(d, CUT).changes, 1, 'a NULL reference must not protect every row')
  d.close(); fs.rmSync(dir, { recursive: true, force: true })
})

test('loop.js calls the service rather than re-inlining the broken DELETE', () => {
  const src = fs.readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(src, /pruneScans\(db, cutoff30d\)/)
  assert.ok(
    !/DELETE FROM scans WHERE scanned_at < \?'\)/.test(src),
    'the unguarded statement is what failed for months — it must not return',
  )
})

test('compaction is deferred while positions are open, and stamps the watchdog', () => {
  const src = fs.readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  // A 1.4GB VACUUM blocked the event loop for 23 minutes and the watchdog
  // killed the process mid-rebuild. Both halves of the fix are load-bearing.
  assert.match(src, /compaction deferred/)
  // SCOPED TO THE COMPACTION BLOCK ON PURPOSE. The first version of this
  // asserted `lastLoopActivityAt = Date.now()` against the whole file, and
  // loop.js stamps that in three other places — so deleting the one that
  // matters left the test green. A mutation check that cannot fail proves
  // nothing (CLAUDE.md, failure mode 1).
  const start = src.indexOf('const { runCompact }')
  const end = src.indexOf('compaction failed (non-fatal)')
  assert.ok(start > 0 && end > start, 'the compaction block is findable')
  const block = src.slice(start, end)
  assert.match(block, /lastLoopActivityAt = Date\.now\(\)/,
    'the rebuild holds the thread — without this stamp the watchdog reads it as a hang')
  assert.match(src, /compaction not needed/,
    'a decision that logs nothing is indistinguishable from a step that never ran')
})
