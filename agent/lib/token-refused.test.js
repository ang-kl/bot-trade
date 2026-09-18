// node --test agent/lib/token-refused.test.js
//
// B7 (18-09-2026): the refused set B2 records is read by the equity sweep and
// the reactive refresh. These pin the reader: union across sides, strings,
// nothing on an absent or unreadable key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { tokenRefusedAccounts, refusedKeyFor, REFUSED_SIDES } from './token-refused.js'

test('union across sides, ids as strings, absent and unreadable keys contribute nothing', () => {
  const db = initDB(':memory:')
  assert.deepEqual([...tokenRefusedAccounts(db)], [], 'nothing recorded → nothing refused')
  setState(db, refusedKeyFor('cpp_exec'), JSON.stringify([43002148, '43069009']))
  setState(db, refusedKeyFor('cpp_exec_demo'), 'not json')
  assert.deepEqual([...tokenRefusedAccounts(db)].sort(), ['43002148', '43069009'])
  setState(db, refusedKeyFor('cpp_exec_demo'), JSON.stringify(['46979908']))
  assert.deepEqual([...tokenRefusedAccounts(db)].sort(), ['43002148', '43069009', '46979908'])
  assert.deepEqual([...REFUSED_SIDES], ['cpp_exec', 'cpp_exec_demo'])
  assert.deepEqual([...tokenRefusedAccounts(null)], [])
})

test('the heartbeat re-exports the same key helper it writes with', async () => {
  const hb = await import('../services/heartbeat.js')
  assert.equal(hb.refusedKeyFor('cpp_exec'), refusedKeyFor('cpp_exec'))
})
