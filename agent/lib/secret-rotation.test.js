// node --test agent/lib/secret-rotation.test.js
//
// MEASURED 24-08-2026: the owner rotated AGENT_SECRET over a suspected
// credential exposure, and a device token minted two days earlier still
// answered 200 — fourteen live sessions survived the one action the
// login-alert message named as the revocation path. Device sessions are
// validated against their own stored map; the secret never entered the
// check. The sweep makes rotation mean what the message says.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { secretRotationSweep, hashSecret } from './secret-rotation.js'

const deps = { getState, setState }
const sessions = (db) => JSON.parse(getState(db, 'device_sessions') || '{}')

function withSessions(db, n = 3) {
  const s = {}
  for (let i = 0; i < n; i++) s[`sess_${i}`] = Date.now() + 86_400_000
  setState(db, 'device_sessions', JSON.stringify(s))
  return db
}

test('FIRST BOOT stores the hash and clears NOTHING — a fresh db is not a rotation', () => {
  const db = withSessions(initDB(':memory:'))
  const out = secretRotationSweep(db, 'secret-A', deps)
  assert.deepEqual(out, { rotated: false, cleared: 0 })
  assert.equal(Object.keys(sessions(db)).length, 3, 'first boot must not log every device out')
  assert.equal(getState(db, 'agent_secret_hash'), hashSecret('secret-A'))
})

test('same secret across boots clears nothing — restarts are not rotations', () => {
  const db = withSessions(initDB(':memory:'))
  secretRotationSweep(db, 'secret-A', deps)
  const out = secretRotationSweep(db, 'secret-A', deps)
  assert.deepEqual(out, { rotated: false, cleared: 0 })
  assert.equal(Object.keys(sessions(db)).length, 3)
})

test('THE PRODUCTION CASE: a rotated secret revokes every device session', () => {
  const db = withSessions(initDB(':memory:'), 14) // the measured count
  secretRotationSweep(db, 'old-secret', deps)
  const out = secretRotationSweep(db, 'new-secret', deps)
  assert.deepEqual(out, { rotated: true, cleared: 14 })
  assert.deepEqual(sessions(db), {}, 'a surviving session is the whole defect')
  assert.equal(getState(db, 'agent_secret_hash'), hashSecret('new-secret'),
    'the new hash must be stored, or every later boot re-clears')
})

test('rotating back to a previous secret still revokes — any CHANGE is a rotation', () => {
  const db = initDB(':memory:')
  secretRotationSweep(db, 'A', deps)
  secretRotationSweep(db, 'B', deps)
  withSessions(db)
  const out = secretRotationSweep(db, 'A', deps)
  assert.equal(out.rotated, true)
  assert.deepEqual(sessions(db), {})
})

test('only a HASH lands in agent_state — the secret itself never does', () => {
  const db = initDB(':memory:')
  secretRotationSweep(db, 'super-secret-value', deps)
  const rows = db.prepare('SELECT value FROM agent_state').all()
  for (const r of rows) {
    assert.ok(!String(r.value).includes('super-secret-value'),
      'the raw secret must not be recoverable from a database dump')
  }
})

test('corrupt session json still rotates cleanly — cleared count degrades, revocation does not', () => {
  const db = initDB(':memory:')
  secretRotationSweep(db, 'A', deps)
  setState(db, 'device_sessions', '{not json')
  const out = secretRotationSweep(db, 'B', deps)
  assert.equal(out.rotated, true)
  assert.equal(out.cleared, 0)
  assert.deepEqual(sessions(db), {}, 'the map must be reset even when unreadable')
})
