import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { runProtectionAuditBothSides } from './naked-position-guard.js'

test('protection reaches both broker sides even if one side cannot answer', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled) VALUES ('demo',0,1),('live',1,1)").run()
  const seen = []
  const out = await runProtectionAuditBothSides(db, { ready: true, accountId: 'demo', isLive: false }, {
    credsForSide: (isLive, accountId) => ({ ready: true, isLive, accountId }),
    auditSide: async (_db, c) => {
      seen.push(c.accountId)
      if (!c.isLive) throw new Error('demo unavailable')
      return { accounts: 1, targetless: 2, errors: [], unauditable: [] }
    },
  })
  assert.deepEqual(seen.sort(), ['demo', 'live'])
  assert.equal(out.accounts, 1)
  assert.equal(out.targetless, 2)
  assert.match(out.errors.join(' '), /demo unavailable/)
  db.close()
})

test('no credentials for a required side is a failure, not a clean audit', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled) VALUES ('live',1,1)").run()
  const out = await runProtectionAuditBothSides(db, null, { credsForSide: () => ({ ready: false }) })
  assert.equal(out.accounts, 0)
  assert.match(out.errors.join(' '), /credentials unavailable/)
  db.close()
})
