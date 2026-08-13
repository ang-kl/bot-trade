import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { upsertAccount, setAccountEnabled } from './account-registry.js'
import { setAccountArmed } from './account-arming.js'
import {
  capabilitiesFor, accountCapabilities, canScan, canEnter, canManage,
  openWork, archiveAccount, unarchiveAccount, capabilityView, MODES, SETTABLE_MODES,
  OFF_ROSTER_MODES, enabledForMode,
  repairRosterMembership, rosterInvariantViolations, modeForPushedEntry,
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

test('MANAGE is on in every ENGAGED mode — the safety principle, as an assertion', () => {
  // `registered` joins `archived` as a mode with MANAGE off. Both are off the
  // roster and both are only reachable while the account holds nothing —
  // archiveAccount refuses otherwise, and a discovery row is new by
  // definition. Every mode that engages an account still manages it.
  for (const m of MODES.filter(x => !OFF_ROSTER_MODES.includes(x))) {
    assert.equal(capabilitiesFor(m).manage, true, `${m} must keep managing`)
  }
  for (const m of OFF_ROSTER_MODES) {
    assert.equal(capabilitiesFor(m).manage, false, `${m} is off the roster`)
    assert.equal(enabledForMode(m), false, `${m} derives enabled = 0`)
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

test('unarchive returns to the quietest live mode AND re-enters the roster', () => {
  // Changed deliberately. Leaving `enabled = 0` beside `manage_only` was the
  // old "separate, louder decision" — and it is precisely the pair that claims
  // MANAGE with no way to reach it. With `enabled` derived from `mode` the
  // state cannot be written, so un-filing an account puts it back on the
  // roster in the quietest mode that still watches its positions.
  const db = freshDb()
  seedAccount(db, 'A')
  archiveAccount(db, 'A')
  const r = unarchiveAccount(db, 'A')
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'manage_only')
  assert.equal(r.enabled, true, 'managing requires reaching')
  assert.equal(accountCapabilities(db, 'A').manage, true)
  assert.equal(accountCapabilities(db, 'A').enter, false, 'but it enters nothing')
})

test('unarchiving a LIVE account straight to active needs the owner word', () => {
  // The hole this closes: unarchiveAccount(id, 'active') reached live-active
  // with no confirmation, while /actions/registry-account had demanded
  // confirmLive for years. One carve-out, one place, every path.
  const db = freshDb()
  seedAccount(db, 'L', { isLive: 1 })
  archiveAccount(db, 'L')
  const refused = unarchiveAccount(db, 'L', 'active')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /confirmLive/)
  assert.equal(db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get('L').mode, 'archived')

  const allowed = unarchiveAccount(db, 'L', 'active', { confirmLive: true })
  assert.equal(allowed.ok, true)
  assert.equal(accountCapabilities(db, 'L').enter, true)
})

test('a LIVE account may be MANAGED without confirmation — reach is not a privilege', () => {
  // The other half, and the one #701/#702 were about: confirmLive guards
  // ENTRY. Getting a live account back on the roster so its open positions can
  // be amended and closed must never require a ceremony.
  const db = freshDb()
  seedAccount(db, 'L', { isLive: 1 })
  archiveAccount(db, 'L')
  const r = unarchiveAccount(db, 'L', 'manage_only')
  assert.equal(r.ok, true)
  assert.equal(r.enabled, true)
  assert.equal(accountCapabilities(db, 'L').enter, false)
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

test('2.6.5 — the roster check PRESERVES enabled = 0; it never promotes', () => {
  const db = freshDb()
  seedAccount(db, 'MANAGE', { mode: 'manage_only', enabled: 0, isLive: 1 })
  seedPosition(db, 'MANAGE', { account: 'MANAGE' })
  seedAccount(db, 'PAUSED', { mode: 'paused', enabled: 0 })
  seedPending(db, { account: 'PAUSED' })

  // Invariant 5 (aligned plan §2.4.5): a reboot may not change an explicit
  // `enabled = 0`. These two rows DO hold unreachable work — the condition the
  // old repair existed for — and they are still not written to. They are
  // reported instead, and stay reported until a person acts.
  const out = repairRosterMembership(db)
  assert.deepEqual(out.promoted, [], 'nothing is ever promoted')
  for (const id of ['MANAGE', 'PAUSED']) {
    const row = db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get(id)
    assert.equal(row.enabled, 0, `${id} keeps the operator's explicit enabled = 0`)
  }
  assert.equal(out.flagged.length, 2, 'but both are surfaced, not swallowed')
  assert.ok(out.flagged.find(p => p.accountId === 'MANAGE').isLive, 'the LIVE row is named')
  assert.ok(out.flagged.find(p => p.accountId === 'PAUSED'), 'a working order counts as live work')
})

test('2.6.5 — the state it used to repair can no longer be created (#703)', () => {
  // Why dropping the write is safe rather than a regression: `enabled` is
  // derived from `mode`, and the only route off the roster refuses while the
  // account holds anything. So a repair for this state is a write with no
  // cause — which is exactly what Invariant 5 objects to.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only' })
  seedPosition(db, 'A', { account: 'A' })
  const off = setAccountEnabled(db, 'A', false)
  assert.equal(off.ok, false, 'a held position cannot be taken off the roster at all')
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('A').enabled, 1)
  assert.deepEqual(repairRosterMembership(db).flagged, [], 'so there is nothing left to flag')
})

test('a flat account is left alone — registering is not enabling', () => {
  // Three legitimate states match `mode != archived AND enabled != 1`: a
  // discovery row from browsing the broker's list, an unarchived row whose
  // re-entry to the roster is a separate decision, and a deliberate disable.
  // None is the bug, and all three are flat.
  const db = freshDb()
  seedAccount(db, 'DISCOVERED', { mode: 'manage_only', enabled: 0 })
  seedAccount(db, 'UNARCHIVED', { mode: 'manage_only', enabled: 0 })
  seedAccount(db, 'DISABLED', { mode: 'manage_only', enabled: 0, isLive: 1 })

  assert.deepEqual(repairRosterMembership(db).promoted, [])
  for (const id of ['DISCOVERED', 'UNARCHIVED', 'DISABLED']) {
    assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get(id).enabled, 0)
  }
  assert.deepEqual(rosterInvariantViolations(db), [], 'and an intended state is not flagged as a fault')
})

test('an enter-capable mode is reported, never auto-promoted', () => {
  // `enabled = 0, mode = 'active'` is contradictory config reachable from two
  // live routes. Promoting it would flip ENTER on — registryAutopilotAccounts
  // is enabled ∩ enter — which is a boot job handing out entry permission and
  // bypassing the confirmLive carve-out. It needs a human, so it is reported.
  const db = freshDb()
  seedAccount(db, 'ACTIVE', { mode: 'active', enabled: 0, isLive: 1 })
  seedPosition(db, 'ACTIVE', { account: 'ACTIVE' })

  assert.deepEqual(repairRosterMembership(db).promoted, [])
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('ACTIVE').enabled, 0)
  assert.equal(accountCapabilities(db, 'ACTIVE').enter, false, 'no entry permission from a boot job')

  const flagged = rosterInvariantViolations(db)
  assert.equal(flagged.length, 1, 'but it does not go unreported')
  assert.equal(flagged[0].accountId, 'ACTIVE')
})

test('repair never touches an archived account — that mode means MANAGE is off', () => {
  const db = freshDb()
  seedAccount(db, 'GONE', { mode: 'archived', enabled: 0 })
  assert.deepEqual(repairRosterMembership(db).promoted, [])
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('GONE').enabled, 0)
})

test('the check grants nothing at all — no ENTRY, and no SCAN either', () => {
  // The safety case is about ENTRY, and only about entry. `scan` is
  // `caps.scan && enabled` with `capabilitiesFor('manage_only').scan` true by
  // default, so `enabled` was the false term and promoting flips scan on. An
  // earlier version of this test asserted mode/enter/manage and quietly omitted
  // scan — shaped to the claim rather than testing it. Both are asserted now.
  const db = freshDb()
  seedAccount(db, 'M', { mode: 'manage_only', enabled: 0 })
  seedPosition(db, 'M', { account: 'M' })
  assert.equal(accountCapabilities(db, 'M').scan, false, 'scan was off only because enabled was')

  repairRosterMembership(db)

  // The SCAN widening this test used to document is gone with the write that
  // caused it. Nothing is granted because nothing is written.
  const caps = accountCapabilities(db, 'M')
  assert.equal(caps.mode, 'manage_only', 'the preset the owner set is not rewritten')
  assert.equal(caps.enter, false)
  assert.equal(caps.scan, false, 'no longer widened — the roster is untouched')
  assert.equal(caps.manage, true, 'the CLAIM stands; the reachability gap is what gets reported')
})

test('a promoted paused account keeps SCAN off — its own capability says so', () => {
  const db = freshDb()
  seedAccount(db, 'P', { mode: 'paused', enabled: 0 })
  seedPosition(db, 'P', { account: 'P' })
  repairRosterMembership(db)
  assert.equal(accountCapabilities(db, 'P').scan, false)
  assert.equal(accountCapabilities(db, 'P').manage, true)
})

test('the report is stable — it does not go quiet on the second boot', () => {
  // The old repair was idempotent by making the symptom vanish. This one is
  // idempotent by changing nothing, which means a restart cannot be mistaken
  // for a resolution.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only', enabled: 0 })
  seedPosition(db, 'A', { account: 'A' })
  assert.equal(repairRosterMembership(db).flagged.length, 1)
  assert.equal(repairRosterMembership(db).flagged.length, 1, 'still flagged after a second boot')
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('A').enabled, 0)
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

test('the invariant reports violations, and reports nothing once resolved', () => {
  // What /state/heartbeats surfaces. A writer that recreates the pair between
  // boots must be visible without waiting for the next restart to heal it.
  const db = freshDb()
  seedAccount(db, 'OK', { mode: 'active', enabled: 1 })
  seedAccount(db, 'GONE', { mode: 'archived', enabled: 0 })
  seedAccount(db, 'BAD', { mode: 'manage_only', enabled: 0, isLive: 1 })

  seedPosition(db, 'BAD', { account: 'BAD' })
  const bad = rosterInvariantViolations(db)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].accountId, 'BAD')
  assert.equal(bad[0].isLive, true)

  // Resolved by a PERSON re-enabling it — the gesture Invariant 5 reserves for
  // direct user input — not by a restart.
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run('BAD')
  assert.deepEqual(rosterInvariantViolations(db), [], 'healthy is the empty list')
})

// ---------------------------------------------------------------------------
// PR B — the pair is no longer repairable, it is unproducible.
//
// PR A repaired six production rows at `enabled = 0` beside a mode claiming
// MANAGE. This asserts no gesture can write that pair again: `enabled` is
// derived from `mode`, and the only way off the roster is a mode that turns
// MANAGE off — which refuses while the account holds anything.
// ---------------------------------------------------------------------------

test('no registry gesture can produce an unreachable MANAGE claim', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active' })

  const gestures = [
    () => setAccountEnabled(db, 'A', true, 'active'),
    () => setAccountEnabled(db, 'A', true, 'manage_only'),
    () => setAccountEnabled(db, 'A', true, 'paused'),
    () => setAccountEnabled(db, 'A', false),
    () => unarchiveAccount(db, 'A', 'manage_only'),
    () => unarchiveAccount(db, 'A', 'paused'),
    () => archiveAccount(db, 'A'),
    () => upsertAccount(db, { accountId: 'A' }),
    () => setAccountArmed(db, 'A', true),
    () => setAccountArmed(db, 'A', false),
  ]
  for (const [i, run] of gestures.entries()) {
    run()
    const row = db.prepare('SELECT enabled, mode FROM accounts WHERE account_id = ?').get('A')
    assert.equal(
      row.enabled === 1, enabledForMode(row.mode),
      `gesture ${i} left enabled=${row.enabled} with mode='${row.mode}' — the derivation must hold after every write`,
    )
    assert.deepEqual(rosterInvariantViolations(db), [], `gesture ${i} produced an unreachable MANAGE claim`)
  }
})

test('an account holding work cannot be taken off the roster at all', () => {
  // The refusal is the whole safety case: disabling routes through
  // archiveAccount, so "I'm done with this account" cannot strand its
  // positions. Both the disable gesture and the archive gesture must refuse.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only' })
  seedPosition(db, 'A', { account: 'A' })

  const disabled = setAccountEnabled(db, 'A', false)
  assert.equal(disabled.ok, false)
  assert.match(disabled.error, /open position/)
  assert.equal(archiveAccount(db, 'A').ok, false)

  const row = db.prepare('SELECT enabled, mode FROM accounts WHERE account_id = ?').get('A')
  assert.equal(row.enabled, 1, 'still reachable')
  assert.equal(accountCapabilities(db, 'A').manage, true)
})

test('a registered account is off the roster and claims nothing', () => {
  const db = freshDb()
  upsertAccount(db, { accountId: 'NEW', isLive: true })
  const caps = accountCapabilities(db, 'NEW')
  assert.equal(caps.mode, 'registered')
  assert.equal(caps.enabled, false, 'registering is not enabling')
  assert.equal(caps.scan, false)
  assert.equal(caps.enter, false)
  assert.equal(caps.manage, false, 'and it claims no MANAGE it cannot deliver')
  assert.deepEqual(rosterInvariantViolations(db), [], 'an honest off-roster row is not a violation')
})

test('setAccountEnabled will not hand a LIVE account entry without the word', () => {
  const db = freshDb()
  seedAccount(db, 'L', { mode: 'manage_only', isLive: 1 })
  const refused = setAccountEnabled(db, 'L', true, 'active')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /confirmLive/)
  assert.equal(accountCapabilities(db, 'L').enter, false)

  assert.equal(setAccountEnabled(db, 'L', true, 'active', { confirmLive: true }).ok, true)
  assert.equal(accountCapabilities(db, 'L').enter, true)
})

// ---------------------------------------------------------------------------
// The mirror rule, as a unit — 11-08-2026.
//
// /actions/ctrader-config has no route-level harness, and that is exactly how
// its first fix shipped over-wide: `enabled = 1` for every pushed account,
// which put all SEVEN production accounts on the roster including the two flat
// live rows the boot repair had been narrowed to leave alone. The rule the
// route now applies is small enough to state and assert directly.
// ---------------------------------------------------------------------------

test('a push without the autopilot role never enlists an unengaged account', () => {
  // `registered` and `archived` are off-roster ON PURPOSE. A routine
  // account-list refresh describes them; it does not engage them. `null` means
  // "leave the row alone", which is the only answer that cannot over-reach.
  assert.equal(modeForPushedEntry('registered', false), null)
  assert.equal(modeForPushedEntry('archived', false), null)
})

test('losing the autopilot role costs entries and nothing else', () => {
  // An account already on the roster keeps managing what it holds — the whole
  // point of manage_only, and what the pre-#701 `enabled = 0` write destroyed.
  for (const m of ['active', 'manage_only', 'paused']) {
    assert.equal(modeForPushedEntry(m, false), 'manage_only')
    assert.equal(enabledForMode(modeForPushedEntry(m, false)), true, `${m} keeps its reach`)
  }
})

test('the autopilot role engages an account, but cannot un-file an archived one', () => {
  assert.equal(modeForPushedEntry('registered', true), 'active')
  assert.equal(modeForPushedEntry('manage_only', true), 'active')
  assert.equal(modeForPushedEntry('archived', true), null, 'un-filing takes /actions/account-archive')
})

test('an unknown or absent mode is left alone rather than guessed at', () => {
  // `undefined` is what the row lookup returns when there is no row. Writing a
  // mode into that is guessing, and guessing is how both previous versions of
  // this write went over-wide. It holds with the autopilot role too — the role
  // says "engage this", not "engage whatever this turns out to be".
  for (const bad of [null, undefined, '', 'nonsense']) {
    assert.equal(modeForPushedEntry(bad, false), null, `${bad} must be left alone`)
    assert.equal(modeForPushedEntry(bad, true), null, `${bad} must be left alone even with the role`)
  }
})
