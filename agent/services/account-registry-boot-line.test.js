// agent/services/account-registry-boot-line.test.js — OWNER PRINCIPLES
// 11-09-2026 (PR-A): the boot line reports HOW MANY accounts are enabled and
// which, never one arbitrary id under a field called `enabled`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { upsertAccount, ensureAccountRegistry } from './account-registry.js'

test('ensureAccountRegistry returns the enabled COUNT and every enabled id, not the first row', () => {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: '46130058', isLive: false })
  upsertAccount(db, { accountId: '46979908', isLive: false })
  upsertAccount(db, { accountId: '42993489', isLive: true })
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id IN (?, ?)').run('46979908', '42993489')
  const reg = ensureAccountRegistry(db)
  assert.equal(reg.total, 3)
  assert.equal(reg.enabledCount, 2)
  assert.deepEqual(reg.enabledIds, ['42993489', '46979908'])
  assert.equal('enabled' in reg, false, 'the misleading single-id field is gone')
})

test('the boot line prints the count and the last-4 of each enabled id (comment-stripped pin)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(src.includes('${reg.enabledCount} enabled'), 'the line carries the count')
  assert.ok(src.includes('reg.enabledIds.map(id => `…${id.slice(-4)}`)'), 'the line carries the redacted ids')
  assert.ok(!src.includes('enabled=${reg.enabled'), 'the old single-id line is gone')
})
