// node --test agent/services/db-compact.test.js
//
// Retention has worked for months; the file only ever grew. SQLite does not
// shrink on DELETE — freed pages go on the freelist and are reused for NEW
// rows, so a database inserting faster than it deletes grows for ever however
// much it prunes. Nothing ran VACUUM. storage-report.js had been reporting
// `freelistPages` the whole time, with the comment "pages already reclaimable
// without VACUUM" — measuring the problem while nothing acted on it.
//
// Measured cost, 2026-08-17: the Railway volume filled and the agent
// crash-looped on boot with SQLITE_IOERR_SHMSIZE at `journal_mode = WAL`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import {
  bloatOf, compactDecision, loadCompactConfig, runCompact,
  DEFAULT_COMPACT, SPACE_HEADROOM, LAST_COMPACT_KEY,
} from './db-compact.js'

const MB = 1e6
const bloat = (totalMB, freeFrac) => ({
  pageSize: 4096,
  pageCount: (totalMB * MB) / 4096,
  freelistPages: ((totalMB * MB) / 4096) * freeFrac,
  totalBytes: totalMB * MB,
  reclaimableBytes: totalMB * MB * freeFrac,
  freeFrac,
})
const cfg = { ...DEFAULT_COMPACT }

// ---------------------------------------------------------------------------
// The space guard is the point. Everything else is a threshold.
// ---------------------------------------------------------------------------

test('refuses to rebuild when the disk cannot hold a second copy', () => {
  // VACUUM writes a NEW file and swaps it, so it needs ~the database's size
  // free. On a full volume — exactly the machine that needs compacting — an
  // unguarded VACUUM fails, and can fail partway.
  const d = compactDecision({ bloat: bloat(500, 0.5), freeBytes: 100 * MB, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, false)
  assert.equal(d.blocked, true, 'this is BLOCKED, not "not worth it" — an operator must act')
  assert.match(d.reason, /grow the volume/)
  assert.ok(d.needBytes > 500 * MB, 'the requirement includes headroom over the raw size')
})

test('unknown free space is treated as not enough', () => {
  // Rebuilding blind on the machine that just filled its disk is how a cleanup
  // becomes an outage.
  const d = compactDecision({ bloat: bloat(500, 0.5), freeBytes: null, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, false)
  assert.equal(d.blocked, true)
  assert.match(d.reason, /refusing to rebuild blind/)
})

test('compacts when the space is demonstrably there', () => {
  const d = compactDecision({ bloat: bloat(500, 0.5), freeBytes: 900 * MB, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, true)
  assert.equal(d.blocked, false)
})

test('the headroom margin is real, not just the raw size', () => {
  const b = bloat(500, 0.5)
  const exact = compactDecision({ bloat: b, freeBytes: b.totalBytes, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(exact.compact, false, 'exactly the file size is NOT enough')
  const withRoom = compactDecision({ bloat: b, freeBytes: b.totalBytes * SPACE_HEADROOM + 1, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(withRoom.compact, true)
})

// ---------------------------------------------------------------------------
// Thresholds — a VACUUM rewrites the entire file, so it is not a hot path.
// ---------------------------------------------------------------------------

test('a nearly-clean file is left alone, and that is not "blocked"', () => {
  const d = compactDecision({ bloat: bloat(500, 0.02), freeBytes: 900 * MB, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, false)
  assert.equal(d.blocked, false, 'below threshold is a no-op, not something to act on')
  assert.match(d.reason, /below the threshold/)
})

test('a high free FRACTION of a tiny file is not worth a rewrite', () => {
  // 50% of 4MB is 2MB. Rewriting the world to reclaim that is pure churn.
  const d = compactDecision({ bloat: bloat(4, 0.5), freeBytes: 900 * MB, cfg, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, false)
  assert.match(d.reason, /below the threshold/)
})

test('the minimum interval holds it off', () => {
  const now = 1_000_000_000
  const recent = compactDecision({ bloat: bloat(500, 0.5), freeBytes: 900 * MB, cfg, lastAtMs: now - 3600_000, nowMs: now })
  assert.equal(recent.compact, false)
  assert.match(recent.reason, /minimum interval/)
  const old = compactDecision({ bloat: bloat(500, 0.5), freeBytes: 900 * MB, cfg, lastAtMs: now - 48 * 3600_000, nowMs: now })
  assert.equal(old.compact, true)
})

test('off means off', () => {
  const d = compactDecision({ bloat: bloat(500, 0.9), freeBytes: 9e12, cfg: { ...cfg, on: false }, lastAtMs: null, nowMs: 0 })
  assert.equal(d.compact, false)
  assert.equal(d.reason, 'off')
})

// ---------------------------------------------------------------------------
// Against a real database
// ---------------------------------------------------------------------------

test('bloatOf reads real page accounting, and freeFrac rises after a delete', () => {
  const db = initDB(':memory:')
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = db.prepare('INSERT INTO big (blob) VALUES (?)')
  const pad = 'x'.repeat(4000)
  db.transaction(() => { for (let i = 0; i < 2000; i++) ins.run(pad) })()
  const full = bloatOf(db)
  assert.ok(full.totalBytes > 0 && full.pageCount > 0)

  db.exec('DELETE FROM big')
  const emptied = bloatOf(db)
  assert.ok(emptied.freeFrac > full.freeFrac, 'deleting rows must raise the reclaimable fraction')
  // THE WHOLE BUG IN ONE ASSERTION: the rows are gone, the file is not smaller.
  assert.equal(emptied.totalBytes, full.totalBytes,
    'DELETE does not shrink the file — this is why VACUUM is required')
})

test('runCompact actually shrinks the file, and records it', () => {
  const db = initDB(':memory:')
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = db.prepare('INSERT INTO big (blob) VALUES (?)')
  const pad = 'x'.repeat(4000)
  db.transaction(() => { for (let i = 0; i < 5000; i++) ins.run(pad) })()
  db.exec('DELETE FROM big')

  const out = runCompact(db, {
    dbPath: ':memory:',
    deps: { freeBytesFor: () => 9e12, cfg: { ...cfg, minReclaimBytes: 0, minFreeFrac: 0.01, minIntervalHours: 0 } },
  })
  assert.equal(out.ran, true, `did not run: ${out.reason}`)
  assert.ok(out.freedBytes > 0, 'the file must actually be smaller')
  assert.ok(out.after.totalBytes < out.before.totalBytes)
  const rec = JSON.parse(db.prepare('SELECT value FROM agent_state WHERE key = ?').get(LAST_COMPACT_KEY).value)
  assert.ok(rec.freedBytes > 0)
})

test('dryRun reports the decision and changes nothing', () => {
  const db = initDB(':memory:')
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = db.prepare('INSERT INTO big (blob) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('y'.repeat(4000)) })()
  db.exec('DELETE FROM big')
  const before = bloatOf(db).totalBytes
  const out = runCompact(db, {
    dbPath: ':memory:', dryRun: true,
    deps: { freeBytesFor: () => 9e12, cfg: { ...cfg, minReclaimBytes: 0, minFreeFrac: 0.01, minIntervalHours: 0 } },
  })
  assert.equal(out.ran, false)
  assert.equal(out.compact, true, 'it should still SAY it would compact')
  assert.equal(bloatOf(db).totalBytes, before, 'and have touched nothing')
})

test('a corrupt config falls back to defaults rather than disabling itself', () => {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run('db_compact_json', '{not json')
  assert.deepEqual(loadCompactConfig(db), { ...DEFAULT_COMPACT })
})

// ---------------------------------------------------------------------------
// Wiring — invisible from this module, and a refactor would drop it silently.
// ---------------------------------------------------------------------------

test('housekeeping calls it, after the prunes it reclaims', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const code = loop.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /runCompact\(db\)/, 'the housekeeping pass must invoke compaction')
  const prune = code.indexOf("prune-risk-events")
  const compact = code.indexOf('runCompact(db)')
  assert.ok(prune > -1 && compact > prune,
    'compaction must run AFTER the deletes whose pages it is reclaiming')
})
