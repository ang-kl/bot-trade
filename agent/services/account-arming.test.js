// node --test agent/services/account-arming.test.js
//
// Owner, 04-08-2026: "do we need to have this extra layer of Auto-trade (armed
// and disarmed capability)" and "it is a wasted opportunities and time, if I
// don't check mean a few hours gone for not trading."
//
// One fact for "may this account enter", a notice whenever it changes, and a
// migration that leaves nothing behind to drift.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { upsertAccount, setAccountEnabled } from './account-registry.js'
import {
  accountArmed, setAccountArmed, migrateLegacyArmFlags, legacyArmFlagsRemaining, legacyArmKey,
} from './account-arming.js'
import { effectivePhases } from './account-phases.js'

const fresh = () => initDB(':memory:')
const modeOf = (db, id) => db.prepare('SELECT mode, enabled FROM accounts WHERE account_id = ?').get(id)
const armRows = (db) => db.prepare(
  "SELECT path, body FROM action_log WHERE method = 'AUDIT' AND path LIKE '/arm/%' ORDER BY id"
).all().map(r => ({ path: r.path, ...JSON.parse(r.body) }))

test('arming and disarming move the MODE, and nothing else stores the answer', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')

  assert.equal(accountArmed(db, 'A'), true)
  setAccountArmed(db, 'A', false, { actor: 'owner-ui' })
  assert.equal(modeOf(db, 'A').mode, 'manage_only')
  assert.equal(accountArmed(db, 'A'), false)
  assert.equal(getState(db, legacyArmKey('A')), null, 'no second store is written')

  setAccountArmed(db, 'A', true, { actor: 'owner-ui' })
  assert.equal(modeOf(db, 'A').mode, 'active')
  assert.equal(accountArmed(db, 'A'), true)
})

test('DISARMING KEEPS THE ACCOUNT MANAGED — it costs entries and nothing else', () => {
  // Setting enabled = 0 would drop the row from the reconcile sweep and the
  // sidecar roster, so stops and trails would stop running on positions still
  // open at the broker. That is a protection failure, not a disarm.
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setAccountArmed(db, 'A', false, { actor: 'equity_stop' })
  assert.equal(modeOf(db, 'A').enabled, 1, 'still watched')
  assert.equal(modeOf(db, 'A').mode, 'manage_only', 'but not entering')
})

test('arming an account that was dropped from the roster puts it back', () => {
  // Otherwise the switch reads ON while the reconciler has never heard of it.
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', false)
  setAccountArmed(db, 'A', true, { actor: 'owner-ui' })
  assert.equal(modeOf(db, 'A').enabled, 1)
  assert.equal(modeOf(db, 'A').mode, 'active')
})

test('a DISARM always lands, even for an account the registry has never seen', () => {
  // Fail-open is the one outcome a brake may not have. Refusing here would
  // make the equity stop and /killall silently do nothing on an unknown row.
  const db = fresh()
  const r = setAccountArmed(db, 'GHOST', false, { actor: 'equity_stop', reason: 'cap breached' })
  assert.equal(r.ok, true)
  assert.equal(modeOf(db, 'GHOST').mode, 'manage_only')
})

test('…but an ARM on an unknown account is refused', () => {
  // The asymmetry is the point: a typo must never be able to create an armed
  // account out of nothing.
  const db = fresh()
  const r = setAccountArmed(db, 'GHOST', true, { actor: 'owner-ui' })
  assert.equal(r.ok, false)
  assert.equal(modeOf(db, 'GHOST'), undefined)
})

test('a PAUSED account is not silently promoted by an arm-off', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'paused')
  const r = setAccountArmed(db, 'A', false, { actor: 'owner-ui' })
  assert.equal(r.changed, false)
  assert.equal(modeOf(db, 'A').mode, 'paused', 'paused is its own deliberate state')
})

// ---------------------------------------------------------------------------
// the notice — the half that turns a silent demotion into a known one
// ---------------------------------------------------------------------------

test('every change writes an attributed audit row, both directions', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setAccountArmed(db, 'A', false, { actor: 'equity_stop', reason: 'daily cap' })
  setAccountArmed(db, 'A', true, { actor: 'owner-ui', via: '/actions/account-phases' })

  const rows = armRows(db)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].path, '/arm/A')
  assert.deepEqual([rows[0].from, rows[0].to], ['active', 'manage_only'])
  assert.equal(rows[0].actor, 'equity_stop')
  assert.match(rows[0].reason, /daily cap/)
  assert.equal(rows[1].to, 'active', 'a re-arm is news too — a brake that lifts silently is the same problem')
})

test('an unchanged write leaves no row — the trail records changes, not chatter', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setAccountArmed(db, 'A', true, { actor: 'owner-ui' })
  assert.equal(armRows(db).length, 0)
})

// ---------------------------------------------------------------------------
// the migration — nothing may survive that could disagree later
// ---------------------------------------------------------------------------

test('a legacy DISARM survives the migration; a legacy ARM does not promote', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'OFF', isLive: false })
  upsertAccount(db, { accountId: 'ON', isLive: false })
  setAccountEnabled(db, 'OFF', true, 'active')
  setAccountEnabled(db, 'ON', true, 'manage_only')
  setState(db, legacyArmKey('OFF'), 'false')   // an owner or a brake said no
  setState(db, legacyArmKey('ON'), 'true')     // …and the drift being removed

  const r = migrateLegacyArmFlags(db)
  assert.equal(r.folded, 1)
  assert.equal(modeOf(db, 'OFF').mode, 'manage_only', 'the disarm is preserved')
  assert.equal(modeOf(db, 'ON').mode, 'manage_only', 'resolving towards trading would arm on a deploy')
  assert.equal(legacyArmFlagsRemaining(db), 0, 'nothing is left to drift')
})

test('the migration is idempotent — a second boot finds nothing to do', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setState(db, legacyArmKey('A'), 'false')
  migrateLegacyArmFlags(db)
  assert.deepEqual(migrateLegacyArmFlags(db), { folded: 0, cleared: 0 })
})

test('after the migration the readout agrees with the mode', () => {
  // The whole point: one fact, so the page and the dispatcher cannot differ.
  const db = fresh()
  setState(db, 'autotrade_enabled', 'true')
  upsertAccount(db, { accountId: 'A', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setState(db, legacyArmKey('A'), 'false')
  migrateLegacyArmFlags(db)

  const eff = effectivePhases(db, 'A')
  assert.equal(eff.autotrade, false)
  assert.equal(eff.source.autotrade, 'capability', 'and it names the mode, not a vanished flag')
})
