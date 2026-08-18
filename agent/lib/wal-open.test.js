// Tests for the WAL open path. The failure being modelled is the real one:
// eleven identical SQLITE_IOERR_SHMSIZE crashes in twenty-four seconds on
// 18-08-2026, with a log that named the mechanism and never the cause.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import {
  openJournal, isDiskError, describeStorage, dbFileSizes, freeBytesFor,
} from './wal-open.js'

/** A db whose pragmas fail exactly as better-sqlite3's do on a full volume. */
function fakeDb({ failWal = 0 } = {}) {
  const calls = []
  let walFails = failWal
  return {
    calls,
    pragma(source) {
      calls.push(source)
      if (/journal_mode\s*=\s*WAL/.test(source) && walFails > 0) {
        walFails -= 1
        const err = new Error('disk I/O error')
        err.code = 'SQLITE_IOERR_SHMSIZE'
        throw err
      }
      return []
    },
  }
}

const quiet = { log() {}, warn() {} }

test('the normal path sets WAL and reports undegraded', () => {
  const db = fakeDb()
  const r = openJournal(db, '/tmp/x.db', quiet)
  assert.equal(r.mode, 'wal')
  assert.equal(r.degraded, false)
  assert.deepEqual(db.calls, ['journal_mode = WAL'])
})

test('the normal path never enables exclusive locking — the fallback is a fallback', () => {
  const db = fakeDb()
  openJournal(db, '/tmp/x.db', quiet)
  assert.ok(!db.calls.some((c) => /locking_mode/.test(c)))
})

test('SHMSIZE falls back to exclusive locking and retries WAL, in that order', () => {
  const db = fakeDb({ failWal: 1 })
  const r = openJournal(db, '/tmp/x.db', quiet)
  assert.equal(r.mode, 'wal-exclusive')
  assert.equal(r.degraded, true)
  assert.deepEqual(db.calls, [
    'journal_mode = WAL',
    'locking_mode = EXCLUSIVE',
    'journal_mode = WAL',
  ])
})

test('the fallback warns loudly — a degraded mode nobody is told about is a trap', () => {
  const warned = []
  const db = fakeDb({ failWal: 1 })
  openJournal(db, '/tmp/x.db', { log() {}, warn: (m) => warned.push(String(m)) })
  const all = warned.join('\n')
  assert.match(all, /SQLITE_IOERR_SHMSIZE/)
  assert.match(all, /DEGRADED/)
  assert.match(all, /NO other process can open/)
  assert.match(all, /Grow the volume/)
})

test('when even the fallback fails, the error names the cause, not just the mechanism', () => {
  const db = fakeDb({ failWal: 2 })
  assert.throws(() => openJournal(db, '/tmp/x.db', quiet), (err) => {
    // The bare SQLite message is "disk I/O error" and says nothing about disk
    // space. This is the whole point of the wrapper.
    assert.match(err.message, /storage at failure:/)
    assert.match(err.message, /free=/)
    assert.match(err.message, /grow it before restarting/)
    return true
  })
})

test('a non-disk error is rethrown untouched — the fallback is not a catch-all', () => {
  const db = {
    pragma() {
      const err = new Error('near "WAL": syntax error')
      err.code = 'SQLITE_ERROR'
      throw err
    },
  }
  assert.throws(() => openJournal(db, '/tmp/x.db', quiet), /syntax error/)
})

test('isDiskError matches the IOERR family only', () => {
  assert.ok(isDiskError({ code: 'SQLITE_IOERR_SHMSIZE' }))
  assert.ok(isDiskError({ code: 'SQLITE_IOERR' }))
  assert.ok(!isDiskError({ code: 'SQLITE_BUSY' }))
  assert.ok(!isDiskError({ code: 'SQLITE_ERROR' }))
  assert.ok(!isDiskError(new Error('no code at all')))
})

test('the storage line reports real file sizes and free space', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walopen-'))
  const p = path.join(dir, 'a.db')
  const db = new Database(p)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE t (x TEXT)')
  const ins = db.prepare('INSERT INTO t VALUES (?)')
  for (let i = 0; i < 2000; i += 1) ins.run('x'.repeat(200))

  const sizes = dbFileSizes(p)
  assert.ok(sizes.db > 0, 'the database file exists and has size')
  assert.ok(sizes.wal !== null, 'WAL mode created a -wal sidecar')

  const line = describeStorage(p)
  assert.match(line, /^db=\d+MB wal=\d+MB shm=\S+ free=\d+MB$/)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('free space is null rather than a throw when the path cannot be read', () => {
  assert.equal(freeBytesFor('/nonexistent-mount-xyz/deep/er/a.db'), null)
})

test('unknown free space is rendered as unknown, never as zero', () => {
  const line = describeStorage('/tmp/x.db', { free: null, sizes: { db: null, wal: null, shm: null } })
  assert.equal(line, 'db=unknown wal=unknown shm=unknown free=unknown')
  assert.ok(!/=0MB/.test(line), 'unknown must not be reported as 0 — that reads as a measurement')
})

test('db.js delegates the journal open instead of calling the pragma inline', () => {
  const src = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(src, /openJournal\(db, resolvedPath\)/)
  assert.ok(
    !/db\.pragma\('journal_mode = WAL'\)/.test(src),
    'the inline pragma is what crash-looped — it must not come back',
  )
})
