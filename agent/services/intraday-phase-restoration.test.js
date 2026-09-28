import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { effectivePhases, setAccountPhases } from './account-phases.js'
import { setPhaseFlag } from './phase-audit.js'
import { restoreApprovedAccountPhases, PHASE_RESTORE_STATE_KEY } from './intraday-phase-restoration.js'

const ids = ['42993489', '43002148', '43069009', '43097342', '46130058', '46979908', '47790949']
function fixture() {
  const db = initDB(':memory:')
  for (const id of ids) upsertAccount(db, { accountId: id, isLive: ids.indexOf(id) < 3 })
  db.prepare("UPDATE accounts SET mode = 'active', enabled = 1").run()
  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'owner-ui' })
  setAccountPhases(db, '43002148', { scan: false, analyze: false, autotrade: false }, { actor: 'owner-ui' })
  setAccountPhases(db, '43069009', { scan: false, analyze: false }, { actor: 'owner-ui' })
  return db
}

test('one owner order restores all seven account phases, including the manage_only live account, once', () => {
  const db = fixture()
  const first = restoreApprovedAccountPhases(db)
  assert.equal(first.error, null)
  assert.deepEqual(first.applied, ids)
  for (const id of ids) {
    const p = effectivePhases(db, id)
    assert.equal(p.scan && p.analyze && p.autotrade, true, id)
  }
  assert.equal(db.prepare("SELECT mode FROM accounts WHERE account_id = '43002148'").get().mode, 'active')
  const record = JSON.parse(getState(db, PHASE_RESTORE_STATE_KEY))
  assert.deepEqual(record.doneIds, ids)
  setPhaseFlag(db, 'acct:43002148:scan_enabled', 'false', { actor: 'owner-ui', accountId: '43002148' })
  setAccountPhases(db, '43069009', { autotrade: false }, { actor: 'equity_stop' })
  const again = restoreApprovedAccountPhases(db)
  assert.equal(again.applied.length, 0)
  assert.equal(again.held.length, 7)
  assert.equal(effectivePhases(db, '43002148').scan, false, 'later human pause persists')
  assert.equal(effectivePhases(db, '43069009').autotrade, false, 'later guard disarm persists')
})

test('a human master stop holds the entire order, including live account arming', () => {
  const db = fixture()
  setPhaseFlag(db, 'scan_enabled', 'false', { actor: 'owner-ui' })
  const result = restoreApprovedAccountPhases(db)
  assert.match(result.error, /master emergency stop/)
  assert.deepEqual(result.applied, [])
  assert.equal(getState(db, PHASE_RESTORE_STATE_KEY), null)
  assert.equal(db.prepare("SELECT mode FROM accounts WHERE account_id = '43002148'").get().mode, 'manage_only')
})

test('a disabled or paused account is not promoted by a boot order', () => {
  const db = fixture()
  db.prepare("UPDATE accounts SET mode = 'paused' WHERE account_id = '42993489'").run()
  db.prepare("UPDATE accounts SET enabled = 0 WHERE account_id = '43002148'").run()
  const result = restoreApprovedAccountPhases(db)
  assert.ok(result.skipped.includes('42993489: mode paused'))
  assert.ok(!result.applied.includes('43002148'))
  assert.equal(db.prepare("SELECT mode FROM accounts WHERE account_id = '42993489'").get().mode, 'paused')
  assert.equal(db.prepare("SELECT mode FROM accounts WHERE account_id = '43002148'").get().mode, 'manage_only')
})
