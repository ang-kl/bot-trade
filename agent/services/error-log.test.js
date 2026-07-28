// error-log tests — the defect being pinned is specifically the one production
// showed: errors_today going up while last_error stayed months old.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, getState, setState } from '../db.js'
import { recordError, readRecentErrors, clearErrorLog, RING_MAX } from './error-log.js'

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'errlog-')), 'agent.db')
  return initDB(file)
}

test('recordError bumps the counter AND writes last_error', () => {
  const db = tmpDb()
  setState(db, 'last_error', '2026-04-01T00:00:00.000Z stale april failure')

  const n = recordError(db, 'scan-fetch', 'trendbar timeout')

  assert.equal(n, 1)
  assert.equal(getState(db, 'errors_today'), '1')
  // The regression: the counter must never move without last_error moving.
  const last = getState(db, 'last_error')
  assert.ok(!last.includes('april'), `last_error still stale: ${last}`)
  assert.match(last, /\[scan-fetch\] trendbar timeout$/)
})

test('the counter and the ring never disagree about how many failures happened', () => {
  const db = tmpDb()
  recordError(db, 'scan-fetch', 'a')
  recordError(db, 'loop', 'b')
  recordError(db, 'loop', 'b')
  recordError(db, 'loop', 'b')

  assert.equal(Number(getState(db, 'errors_today')), 4)
  const ring = readRecentErrors(db)
  // 4 failures, 2 distinct causes → 2 entries, not 4.
  assert.equal(ring.length, 2, 'repeats collapse into one entry')
  assert.equal(ring.reduce((sum, e) => sum + e.n, 0), 4)
  assert.equal(ring[0].source, 'loop')
  assert.equal(ring[0].n, 3)
  assert.equal(ring[1].source, 'scan-fetch')
})

test('extraKey keeps the per-API last-error field working', () => {
  const db = tmpDb()
  recordError(db, 'scan-fetch', 'CH_RATE_LIMIT', { extraKey: 'api_ctrader_last_error' })
  assert.match(getState(db, 'api_ctrader_last_error'), /CH_RATE_LIMIT$/)
})

test('the ring is bounded — a failure storm cannot grow agent_state without limit', () => {
  const db = tmpDb()
  for (let i = 0; i < RING_MAX + 25; i++) recordError(db, 'loop', `distinct failure ${i}`)

  const ring = readRecentErrors(db)
  assert.equal(ring.length, RING_MAX)
  // Newest first: the last one written is at the head.
  assert.match(ring[0].message, new RegExp(`failure ${RING_MAX + 24}$`))
  assert.equal(Number(getState(db, 'errors_today')), RING_MAX + 25)
})

test('readRecentErrors survives corrupt JSON rather than throwing into a health route', () => {
  const db = tmpDb()
  setState(db, 'recent_errors_json', '{not json')
  assert.deepEqual(readRecentErrors(db), [])
  // And recovers on the next write.
  recordError(db, 'loop', 'after corruption')
  assert.equal(readRecentErrors(db).length, 1)
})

test('clearErrorLog clears counter, last_error and ring together', () => {
  const db = tmpDb()
  recordError(db, 'loop', 'x')
  clearErrorLog(db)
  assert.equal(getState(db, 'errors_today'), '0')
  assert.equal(getState(db, 'last_error'), null)
  assert.deepEqual(readRecentErrors(db), [])
})

test('a missing or empty message still records something resolvable', () => {
  const db = tmpDb()
  recordError(db, 'loop', undefined)
  assert.match(getState(db, 'last_error'), /\[loop\] unknown error$/)
})
