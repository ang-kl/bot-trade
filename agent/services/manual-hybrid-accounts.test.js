// node --test agent/services/manual-hybrid-accounts.test.js
// W9 — Claude · № 13,391 12-Oct (owner's yes naming manual-hybrid-policy.js;
// docs/instruction-2026-10-12-decisions.md W9; claude-builder). `"_all"`
// covers every enabled registry account; explicit ids still name themselves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { manualHybridAccountIds, manualHybridAccountAuthorised, MANUAL_HYBRID_CONFIG } from './manual-hybrid-policy.js'

function registry() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, enabled, mode) VALUES ('47790949', 1, 'active'), ('46979908', 1, 'manage_only'),
    ('43097342', 1, 'active'), ('43002148', 0, 'archived')`).run()
  return db
}

test('W9: `_all` covers every enabled registry account and no disabled one', () => {
  const db = registry()
  assert.deepEqual(manualHybridAccountIds(db, ['_all']), ['43097342', '46979908', '47790949'])
  for (const a of ['47790949', '46979908', '43097342']) assert.equal(manualHybridAccountAuthorised(db, a, ['_all']), true, a)
  assert.equal(manualHybridAccountAuthorised(db, '43002148', ['_all']), false, 'archived')
  assert.equal(manualHybridAccountAuthorised(db, '99999999', ['_all']), false, 'unknown')
  assert.equal(manualHybridAccountAuthorised(db, 'abc', ['_all']), false, 'malformed')
})

test('W9: an explicit list still names exactly its ids; `_all` plus an id adds nothing twice', () => {
  const db = registry()
  assert.deepEqual(manualHybridAccountIds(db, ['43097342', '42993489']), ['43097342', '42993489'])
  assert.equal(manualHybridAccountAuthorised(db, '47790949', ['43097342', '42993489']), false)
  assert.equal(manualHybridAccountAuthorised(db, '42993489', ['43097342', '42993489']), true, 'named, though this registry lacks it')
  assert.deepEqual(manualHybridAccountIds(db, ['_all', '43097342']), ['43097342', '46979908', '47790949'])
  assert.deepEqual(manualHybridAccountIds(db, []), [])
})

test('W9: the shipped config names every enabled account; the authority version is unchanged', () => {
  assert.deepEqual([...MANUAL_HYBRID_CONFIG.accounts], ['_all'])
  assert.equal(MANUAL_HYBRID_CONFIG.version, 'manual_capped_hybrid_2026_10_09_v1', 'authorities already recorded keep validating')
  const db = registry()
  assert.equal(manualHybridAccountAuthorised(db, '47790949'), true, '…0949, outside the pre-W9 list')
})
