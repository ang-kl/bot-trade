// agent/db-pragmas.test.js — WHOLE-PLAN AUDIT 11-09-2026 (plan §11, TM-26):
// the intent ledger's durability rests on the journal's sync level. FULL (2)
// is pinned here so a "faster" NORMAL cannot come back silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'

test('the database opens with synchronous = FULL, foreign keys on and a busy timeout', () => {
  const db = initDB(':memory:')
  assert.equal(db.pragma('synchronous', { simple: true }), 2, 'FULL')
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000)
})
