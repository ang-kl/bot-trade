// The arm that was stored and overruled.
//
// Owner, 04-08-2026: "why is the auto-trade and ratchet conflict with user
// request", and hours earlier: "I armed it 10 minutes ago and now
// disarmed-autotrade!!!!!"
//
// Measured on production that evening:
//
//   43097342 (5067353)  mode active       override T=true  → effective true
//   46130058 (5203012)  mode manage_only  override T=true  → effective FALSE
//   47790949 (5306502)  mode manage_only  override T=true  → effective FALSE
//
// Nothing disarmed anything and there is no disarm in the action log, because
// there was none: the write succeeded and the READ was overruled by the mode.
// The switch then repainted OFF, so the page showed the opposite of what the
// operator had just said, with no reason given and no control to change it.
//
// These tests hold the two halves apart — the OWNER'S ANSWER and the SYSTEM'S
// VERDICT are different facts and the view must carry both.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { phasesView } from './account-phases.js'

let db
const seed = (id, { enabled = 1, mode = 'active', isLive = 0 } = {}) => {
  db.prepare(
    `INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(String(id), String(id), isLive, enabled, mode)
}
const row = (v, id) => v.accounts.find(a => a.accountId === String(id))

beforeEach(() => {
  db = initDB(':memory:')
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
})

test('an armed manage_only account reports the arm AND the veto, not a bare OFF', () => {
  seed('46130058', { mode: 'manage_only' })
  setState(db, 'acct:46130058:autotrade_enabled', 'true')   // the owner's ON

  const r = row(phasesView(db), '46130058')
  assert.equal(r.overrides.autotrade, true, 'the owner\'s answer is still stored')
  assert.equal(r.effective.autotrade, false, 'and it is not in force')
  assert.equal(r.effective.source.autotrade, 'capability')
  // The half that was missing: WHICH capability, so the UI can name it and
  // offer the fix instead of springing the switch back with no explanation.
  assert.equal(r.capability.mode, 'manage_only')
  assert.equal(r.capability.enter, false)
  assert.equal(r.capability.enabled, true)
  assert.equal(r.capability.manage, true, 'management is never withdrawn')
})

test('the same arm on an ACTIVE account is in force — the mode is the only difference', () => {
  seed('43097342', { mode: 'active' })
  setState(db, 'acct:43097342:autotrade_enabled', 'true')

  const r = row(phasesView(db), '43097342')
  assert.equal(r.effective.autotrade, true)
  assert.equal(r.capability.mode, 'active')
  assert.equal(r.capability.enter, true)
})

test('a DISABLED account says so through capability, and still manages what it holds', () => {
  seed('46979908', { enabled: 0, mode: 'manage_only' })
  setState(db, 'acct:46979908:autotrade_enabled', 'true')

  const r = row(phasesView(db), '46979908')
  assert.equal(r.effective.autotrade, false)
  assert.equal(r.capability.enabled, false)
  assert.equal(r.capability.enter, false)
  // The invariant the whole capability file exists to protect: disabling an
  // account does not close its positions, so it must keep managing them.
  assert.equal(r.capability.manage, true)
})

test('capability never turns a master-off into a capability story', () => {
  seed('46130058', { mode: 'manage_only' })
  setState(db, 'autotrade_enabled', 'false')
  const r = row(phasesView(db), '46130058')
  assert.equal(r.effective.autotrade, false)
  assert.equal(r.effective.source.autotrade, 'master', 'the master is the more actionable reason')
})
