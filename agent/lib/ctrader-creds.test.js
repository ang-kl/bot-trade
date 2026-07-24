// node --test agent/lib/ctrader-creds.test.js
//
// M2: getCtraderCreds carries the registry's enabled-account roster
// (accountIds) so the sidecar pre-authorizes every enabled account on one
// session — restricted to the creds' own live/demo side, primary first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { getCtraderCreds } from './ctrader-creds.js'
import { upsertAccount, syncSelectedAccount } from '../services/account-registry.js'

function fresh() {
  process.env.CTRADER_CLIENT_ID = 'ci'
  process.env.CTRADER_CLIENT_SECRET = 'cs'
  const db = initDB(':memory:')
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '100')
  setState(db, 'ctrader_is_live', 'false')
  return db
}

test('roster: primary first, other enabled same-side accounts follow, other side excluded', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)                       // demo, enabled primary
  upsertAccount(db, { accountId: '200', isLive: false })      // demo, disabled → excluded
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '200'`).run()
  upsertAccount(db, { accountId: '900', isLive: true })       // live → excluded (wrong side)
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '900'`).run()

  const creds = getCtraderCreds(db)
  assert.equal(creds.accountId, '100')
  assert.deepEqual(creds.accountIds, ['100', '200'])
  assert.equal(creds.ready, true)
})

test('roster: single enabled account degrades to a one-entry roster (legacy shape)', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)
  const creds = getCtraderCreds(db)
  assert.deepEqual(creds.accountIds, ['100'])
})

test('roster: accountOverride flips the side filter and leads the roster', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)
  upsertAccount(db, { accountId: '900', isLive: true })
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '900'`).run()

  const creds = getCtraderCreds(db, { accountId: '900', isLive: true })
  assert.equal(creds.host, 'live.ctraderapi.com')
  assert.deepEqual(creds.accountIds, ['900'], 'demo accounts must not ride a live session')
})

test('roster: empty registry leaves accountIds as the primary only', () => {
  const db = fresh() // no registry rows at all
  const creds = getCtraderCreds(db)
  assert.deepEqual(creds.accountIds, ['100'])
})
