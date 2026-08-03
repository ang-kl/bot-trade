// node --test agent/entry-roster-capability.test.js
//
// AUDIT F-POLICY-01, 03-08-2026 — "fix the mode enforcement, that's the live
// account risk".
//
// The registry path has always filtered the entry roster on the `enter`
// capability (registryAutopilotAccounts → capabilitiesFor). The LEGACY path did
// not: `ctrader_account_roles_json` was filtered on `autopilot` ALONE and takes
// precedence when more than one role carries it, so `mode` and `enabled` were
// both bypassed — including for the live account.
//
// These tests are about that bypass, and about the one thing that must not
// happen while closing it: a registry that cannot answer must not silently
// empty the roster and stop trading.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from './db.js'
import { getAutopilotAccounts } from './loop.js'

const LIVE = '42993489'   // is_live 1 — the account that must never slip through
const OK = '46130058'     // enabled + active

function db_({ liveMode = 'manage_only', liveEnabled = 0 } = {}) {
  const db = initDB(':memory:')
  db.prepare('INSERT OR REPLACE INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(OK, 0, 1, 'active', '5203012')
  db.prepare('INSERT OR REPLACE INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(LIVE, 1, liveEnabled, liveMode, '1251247')
  return db
}
const roles = (db, ids) => setState(db, 'ctrader_account_roles_json',
  JSON.stringify(ids.map(id => ({ accountId: id, autopilot: true }))))

test('THE BYPASS: a legacy autopilot role cannot enter when the registry refuses it', () => {
  const db = db_()
  roles(db, [OK, LIVE])            // two roles ⇒ the legacy branch takes precedence
  const ids = getAutopilotAccounts(db).map(a => String(a.accountId))
  assert.ok(!ids.includes(LIVE), 'the LIVE account must not be in the entry roster')
  assert.deepEqual(ids, [OK])
})

test('a manage_only account is dropped even when enabled', () => {
  const db = db_({ liveMode: 'manage_only', liveEnabled: 1 })
  roles(db, [OK, LIVE])
  assert.deepEqual(getAutopilotAccounts(db).map(a => String(a.accountId)), [OK])
})

test('an ACTIVE, enabled account is kept — the filter is capability, not a blocklist', () => {
  const db = db_({ liveMode: 'active', liveEnabled: 1 })
  roles(db, [OK, LIVE])
  const ids = getAutopilotAccounts(db).map(a => String(a.accountId)).sort()
  assert.deepEqual(ids, [LIVE, OK].sort())
})

test('an empty registry leaves the legacy roster ALONE — an outage must not stop trading', () => {
  // No accounts rows at all: the registry cannot answer, so the legacy list
  // stands exactly as before. Failing closed here would silently halt the desk
  // on a migration or a fresh volume, and the per-account risk gate still runs
  // downstream regardless.
  const db = initDB(':memory:')
  roles(db, [OK, LIVE])
  const ids = getAutopilotAccounts(db).map(a => String(a.accountId)).sort()
  assert.deepEqual(ids, [LIVE, OK].sort())
})

test('one surviving role is still returned (not treated as "no roles")', () => {
  const db = db_()
  roles(db, [OK, LIVE])
  assert.equal(getAutopilotAccounts(db).length, 1)
})

test('a single legacy role is untouched — the branch only triggers above one', () => {
  const db = db_()
  roles(db, [OK])
  assert.ok(getAutopilotAccounts(db).length >= 1)
})
