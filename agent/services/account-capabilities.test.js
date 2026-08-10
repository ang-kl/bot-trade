import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  capabilitiesFor, accountCapabilities, canScan, canEnter, canManage,
  openWork, archiveAccount, unarchiveAccount, capabilityView, MODES, SETTABLE_MODES,
  repairRosterMembership, rosterInvariantViolations,
} from './account-capabilities.js'

const NOW = '2026-08-03T00:00:00Z'

function freshDb() {
  return initDB(':memory:')
}

function seedAccount(db, id, { mode = 'active', enabled = 1, isLive = 0, params = null } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, mode, params, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(String(id), isLive, enabled, mode, params ? JSON.stringify(params) : '{}', NOW)
}

function seedPosition(db, id, { account = null, status = 'active' } = {}) {
  db.prepare(
    `INSERT INTO monitored_positions (symbol, status, account_id, thesis)
     VALUES ('EURUSD', ?, ?, ?)`
  ).run(status, account, String(id))
}

function seedPending(db, { account = null, status = 'working' } = {}) {
  db.prepare(
    `INSERT INTO pending_orders (symbol, status, account_id) VALUES ('EURUSD', ?, ?)`
  ).run(status, account)
}

// ---------------------------------------------------------------------------
// The preset table (plan §2)
// ---------------------------------------------------------------------------

test('the presets match the plan table exactly', () => {
  assert.deepEqual(capabilitiesFor('active'), { scan: true, enter: true, manage: true })
  assert.deepEqual(capabilitiesFor('manage_only'), { scan: true, enter: false, manage: true })
  assert.deepEqual(capabilitiesFor('paused'), { scan: false, enter: false, manage: true })
  assert.deepEqual(capabilitiesFor('archived'), { scan: false, enter: false, manage: false })
})

test('MANAGE is on in every mode but archived — the safety principle, as an assertion', () => {
  for (const m of MODES.filter(x => x !== 'archived')) {
    assert.equal(capabilitiesFor(m).manage, true, `${m} must keep managing`)
  }
})

test('manage_only scanning is a choice, not an assumption', () => {
  assert.equal(capabilitiesFor('manage_only', { scanWhileManageOnly: false }).scan, false)
  assert.equal(capabilitiesFor('manage_only', { scanWhileManageOnly: false }).manage, true,
    'declining to scan never affects management')
})

test('an unrecognised mode starts nothing new but keeps managing', () => {
  // The dangerous failure would be defaulting to active. This is the other
  // direction on purpose.
  assert.deepEqual(capabilitiesFor('nonsense'), { scan: false, enter: false, manage: true })
  assert.deepEqual(capabilitiesFor(undefined), { scan: false, enter: false, manage: true })
})

// ---------------------------------------------------------------------------
// Reading a real account
// ---------------------------------------------------------------------------

test('an active enabled account may do everything', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active' })
  assert.equal(canScan(db, 'A'), true)
  assert.equal(canEnter(db, 'A'), true)
  assert.equal(canManage(db, 'A'), true)
})

test('a paused account starts nothing and still manages', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  const caps = accountCapabilities(db, 'A')
  assert.equal(caps.scan, false)
  assert.equal(caps.enter, false)
  assert.equal(caps.manage, true, 'pausing must never stop stop-management')
})

test('a DISABLED account cannot enter but still manages', () => {
  // The abandonment bug in one assertion: disabling an account does not close
  // its positions, so the ones still open need their stops fed.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active', enabled: 0 })
  const caps = accountCapabilities(db, 'A')
  assert.equal(caps.enter, false)
  assert.equal(caps.scan, false)
  assert.equal(caps.manage, true)
})

test('params can switch scanning off inside manage_only', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only', params: { scanWhileManageOnly: false } })
  assert.equal(canScan(db, 'A'), false)
  seedAccount(db, 'B', { mode: 'manage_only' })
  assert.equal(canScan(db, 'B'), true, 'the default stays on')
})

test('an account the registry never saw is conservative, not permissive, and does not throw', () => {
  const db = freshDb()
  const caps = accountCapabilities(db, '9999999')
  assert.equal(caps.known, false)
  assert.equal(caps.enter, false)
  assert.equal(caps.scan, false)
  assert.equal(caps.manage, true)
  assert.equal(accountCapabilities(db, null).known, false)
})

// ---------------------------------------------------------------------------
// Open work and archiving
// ---------------------------------------------------------------------------

test('open work counts positions AND working entry orders', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedPosition(db, 'p1', { account: 'A' })
  seedPending(db, { account: 'A' })
  const w = openWork(db, 'A')
  assert.equal(w.positions, 1)
  assert.equal(w.pendings, 1)
  assert.equal(w.flat, false)
})

test('closed positions and filled orders do not count as open work', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedPosition(db, 'p1', { account: 'A', status: 'closed' })
  seedPending(db, { account: 'A', status: 'filled' })
  assert.equal(openWork(db, 'A').flat, true)
})

test('unstamped rows count against the account asking — the safe reading', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedPosition(db, 'p1', { account: null })
  assert.equal(openWork(db, 'A').positions, 1,
    'a position that predates stamping is somebody open position, and archiving must not step over it')
})

test('another account open work does not block this one', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedAccount(db, 'B')
  seedPosition(db, 'p1', { account: 'B' })
  assert.equal(openWork(db, 'A').flat, true)
  assert.equal(openWork(db, 'B').flat, false)
})

test('archiving is REFUSED while anything is open, and names what', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedPosition(db, 'p1', { account: 'A' })
  seedPending(db, { account: 'A' })
  const r = archiveAccount(db, 'A')
  assert.equal(r.ok, false)
  assert.match(r.error, /1 open position/)
  assert.match(r.error, /1 working entry order/)
  assert.equal(accountCapabilities(db, 'A').manage, true, 'still managing after the refusal')
})

test('archiving a flat account succeeds and is the only state that stops managing', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  const r = archiveAccount(db, 'A')
  assert.equal(r.ok, true)
  const caps = accountCapabilities(db, 'A')
  assert.equal(caps.mode, 'archived')
  assert.deepEqual([caps.scan, caps.enter, caps.manage], [false, false, false])
})

test('archiving an unknown account fails rather than inserting one', () => {
  const db = freshDb()
  const r = archiveAccount(db, 'nope')
  assert.equal(r.ok, false)
  assert.match(r.error, /not in the registry/)
})

test('unarchive returns to the quietest live mode and does not re-enable', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  archiveAccount(db, 'A')
  const r = unarchiveAccount(db, 'A')
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'manage_only')
  assert.equal(r.enabled, false, 're-entering the roster is a separate, louder decision')
  assert.equal(accountCapabilities(db, 'A').manage, true)
})

test('unarchive refuses a mode outside the settable set, and a non-archived account', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  assert.equal(unarchiveAccount(db, 'A', 'archived').ok, false)
  assert.equal(unarchiveAccount(db, 'A').ok, false, 'A is not archived')
  assert.ok(!SETTABLE_MODES.includes('archived'))
})

// ---------------------------------------------------------------------------
// The view the traffic lights read
// ---------------------------------------------------------------------------

test('the capability view carries counts and capabilities per account', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active', isLive: 0 })
  seedAccount(db, 'B', { mode: 'paused' })
  seedPosition(db, 'p1', { account: 'B' })
  const view = capabilityView(db)
  const a = view.find(r => r.accountId === 'A')
  const b = view.find(r => r.accountId === 'B')
  assert.equal(a.enter, true)
  assert.equal(b.enter, false)
  assert.equal(b.manage, true)
  assert.equal(b.positions, 1)
  assert.equal(b.flat, false)
})

test('unmanagedExposure is false everywhere the API can reach', () => {
  // The §1 invariant. Every mode the operator can set, with open work
  // present, must still be managing it.
  const db = freshDb()
  for (const m of SETTABLE_MODES) seedAccount(db, m, { mode: m })
  for (const m of SETTABLE_MODES) seedPosition(db, `p-${m}`, { account: m })
  assert.equal(capabilityView(db).some(r => r.unmanagedExposure), false)
})

test('unmanagedExposure catches a mode written straight into the column', () => {
  // archiveAccount refuses this, so the only way in is a direct UPDATE. The
  // flag exists so that if it ever happens the panel screams rather than
  // rendering a quiet, wrong "archived".
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'archived', enabled: 0 })
  seedPosition(db, 'p1', { account: 'A' })
  const row = capabilityView(db).find(r => r.accountId === 'A')
  assert.equal(row.unmanagedExposure, true)
})

// ---------------------------------------------------------------------------
// THE ROSTER INVARIANT — mode !== 'archived' ⇒ enabled = 1 (10-08-2026).
//
// `manage` is deliberately never gated on `enabled`, on the principle that an
// account out of the roster still holds positions worth watching. The principle
// is right and the mechanism did not honour it: `enabled = 0` drops the row
// from the roster pushed to the sidecar, so no amend and no close can reach it.
// MANAGE read `true` while being unreachable — six of seven production accounts,
// 17 open positions, every one reporting "manage": true beside
// "connectivity": "disconnected".
// ---------------------------------------------------------------------------

test('repair promotes every non-archived account back into the roster', () => {
  const db = freshDb()
  seedAccount(db, 'ACTIVE', { mode: 'active', enabled: 0 })
  seedAccount(db, 'MANAGE', { mode: 'manage_only', enabled: 0, isLive: 1 })
  seedAccount(db, 'PAUSED', { mode: 'paused', enabled: 0 })

  const out = repairRosterMembership(db)
  assert.equal(out.promoted.length, 3)
  for (const id of ['ACTIVE', 'MANAGE', 'PAUSED']) {
    const row = db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get(id)
    assert.equal(row.enabled, 1, `${id} must be reachable to be manageable`)
  }
  // The LIVE side is repaired too — its positions are the ones that matter most.
  assert.ok(out.promoted.find(p => p.accountId === 'MANAGE').isLive)
})

test('repair never touches an archived account — that mode means MANAGE is off', () => {
  const db = freshDb()
  seedAccount(db, 'GONE', { mode: 'archived', enabled: 0 })
  assert.deepEqual(repairRosterMembership(db).promoted, [])
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('GONE').enabled, 0)
})

test('repair grants no new capability — mode is untouched, so SCAN and ENTER hold', () => {
  // The whole safety case: promoting a row into the roster restores REACH, not
  // permission. `manage_only` must still refuse to enter afterwards.
  const db = freshDb()
  seedAccount(db, 'M', { mode: 'manage_only', enabled: 0 })
  repairRosterMembership(db)
  const caps = accountCapabilities(db, 'M')
  assert.equal(caps.mode, 'manage_only', 'the preset the owner set is not rewritten')
  assert.equal(caps.enter, false, 'a repaired account may still not open anything')
  assert.equal(caps.manage, true)
})

test('repair is idempotent — a second boot finds nothing to promote', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only', enabled: 0 })
  assert.equal(repairRosterMembership(db).promoted.length, 1)
  assert.deepEqual(repairRosterMembership(db).promoted, [])
})

test('after repair no account reports unmanaged exposure', () => {
  // capabilityView already computes `unmanagedExposure`; nothing had ever made
  // it false in production. This is that assertion, as a test.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only', enabled: 0 })
  seedPosition(db, 'A', { account: 'A' })
  repairRosterMembership(db)
  for (const row of capabilityView(db)) {
    assert.equal(row.unmanagedExposure, false, `${row.accountId} holds work it cannot reach`)
  }
})

test('the invariant reports violations, and reports nothing once repaired', () => {
  // What /state/heartbeats surfaces. A writer that recreates the pair between
  // boots must be visible without waiting for the next restart to heal it.
  const db = freshDb()
  seedAccount(db, 'OK', { mode: 'active', enabled: 1 })
  seedAccount(db, 'GONE', { mode: 'archived', enabled: 0 })
  seedAccount(db, 'BAD', { mode: 'manage_only', enabled: 0, isLive: 1 })

  const bad = rosterInvariantViolations(db)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].accountId, 'BAD')
  assert.equal(bad[0].isLive, true)

  repairRosterMembership(db)
  assert.deepEqual(rosterInvariantViolations(db), [], 'healthy is the empty list')
})
