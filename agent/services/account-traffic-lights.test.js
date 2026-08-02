import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { archiveAccount } from './account-capabilities.js'
import { recordBrokerRoster } from './broker-roster.js'
import { accountTrafficLights, worstLight, LIGHTS } from './account-traffic-lights.js'

const NOW = Date.parse('2026-08-03T12:00:00Z')

function freshDb() {
  return initDB(':memory:')
}

function seedAccount(db, id, { mode = 'active', enabled = 1, isLive = 0 } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, mode, params, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?)`
  ).run(String(id), isLive, enabled, mode, new Date(NOW).toISOString())
}

function seedPosition(db, { account = null, sl = 1.05, status = 'active' } = {}) {
  db.prepare(
    `INSERT INTO monitored_positions (symbol, status, account_id, current_sl)
     VALUES ('EURUSD', ?, ?, ?)`
  ).run(status, account, sl)
}

/** A healthy main_loop heartbeat, which most lights depend on. */
function seedLoopBeat(db, { status = 'ok', agoSec = 10 } = {}) {
  const at = new Date(NOW - agoSec * 1000).toISOString()
  db.prepare(
    `INSERT OR REPLACE INTO controller_heartbeats (name, last_run_at, last_ok_at, last_error, consecutive_failures, runs)
     VALUES ('main_loop', ?, ?, ?, ?, 5)`
  ).run(at, status === 'ok' ? at : null, status === 'error' ? 'boom' : null, status === 'ok' ? 0 : 5)
  // The loop cadence the heartbeat is judged against.
  setState(db, 'loop_interval_min', '5')
}

const of = (out, id) => out.accounts.find(a => a.accountId === id)

// ---------------------------------------------------------------------------

test('worstLight orders red over amber over green over unknown', () => {
  assert.equal(worstLight('green', 'red'), 'red')
  assert.equal(worstLight('amber', 'green'), 'amber')
  assert.equal(worstLight('unknown', 'green'), 'green')
})

test('every account gets all four lights, each with a reason', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  const row = of(accountTrafficLights(db, { now: NOW }), 'A')
  for (const k of LIGHTS) {
    assert.ok(row.lights[k], `${k} light missing`)
    assert.ok(row.lights[k].reason, `${k} light has no reason`)
  }
})

test('with no broker roster recorded, Link is unknown — never green', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  const row = of(accountTrafficLights(db, { now: NOW }), 'A')
  assert.equal(row.lights.link.state, 'unknown')
  assert.match(row.lights.link.reason, /roster/)
})

test('an account absent from a fresh broker roster is RED on Link', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  recordBrokerRoster(db, [{ accountId: 'B' }])
  const row = of(accountTrafficLights(db, { now: NOW }), 'A')
  assert.equal(row.lights.link.state, 'red')
  assert.match(row.lights.link.reason, /not in the broker roster/)
})

test('at the broker with a healthy loop is green on Link', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  recordBrokerRoster(db, [{ accountId: 'A' }])
  seedLoopBeat(db)
  assert.equal(of(accountTrafficLights(db, { now: NOW }), 'A').lights.link.state, 'green')
})

test('at the broker but with a stalled loop is RED on Link — nothing is reconciling', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  recordBrokerRoster(db, [{ accountId: 'A' }])
  seedLoopBeat(db, { agoSec: 86_400 })
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.link
  assert.equal(l.state, 'red')
  assert.match(l.reason, /stalled|error/)
})

test('Scan is red when the mode says so, and names the mode', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedLoopBeat(db)
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.scan
  assert.equal(l.state, 'red')
  assert.match(l.reason, /paused/)
})

test('Scan is green for a manage_only account — it enters nothing but keeps looking', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'manage_only' })
  seedLoopBeat(db)
  const row = of(accountTrafficLights(db, { now: NOW }), 'A')
  assert.equal(row.lights.scan.state, 'green')
  assert.equal(row.lights.enter.state, 'red', 'entering is the thing manage_only turns off')
})

test('Scan is amber when scanning is on but the loop is stalled', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db, { agoSec: 86_400 })
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.scan
  assert.equal(l.state, 'amber')
  assert.match(l.reason, /nothing is sweeping/)
})

test('Enter is red on a disabled account and says why', () => {
  const db = freshDb()
  seedAccount(db, 'A', { enabled: 0 })
  seedLoopBeat(db)
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.enter
  assert.equal(l.state, 'red')
  assert.match(l.reason, /disabled/)
})

test('Enter is AMBER — armed but blocked — under a portfolio halt', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))
  const out = accountTrafficLights(db, { now: NOW })
  assert.equal(out.globalHalt, true)
  const l = of(out, 'A').lights.enter
  assert.equal(l.state, 'amber', 'armed-but-blocked is not the same as switched off')
  assert.match(l.reason, /portfolio guard/)
})

test('a corrupt guard config fails safe and shows as blocked, not as armed', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  setState(db, 'global_guards_json', '{not json')
  const out = accountTrafficLights(db, { now: NOW })
  assert.equal(out.globalHalt, true)
  assert.equal(of(out, 'A').lights.enter.state, 'amber')
})

test('Manage is green with nothing open', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.manage
  assert.equal(l.state, 'green')
  assert.match(l.reason, /nothing open/)
})

test('Manage is green while watching positions that all have stops', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  seedPosition(db, { account: 'A', sl: 1.05 })
  seedPosition(db, { account: 'A', sl: 1.06 })
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.manage
  assert.equal(l.state, 'green')
  assert.match(l.reason, /2 positions/)
})

test('a position with no stop is AMBER, not red — it is being watched', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  seedPosition(db, { account: 'A', sl: null })
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.manage
  assert.equal(l.state, 'amber')
  assert.match(l.reason, /no stop/)
})

test('Manage RED is the §1 alarm: exposure with nothing watching it', () => {
  // Only reachable by writing the column directly — archiveAccount refuses
  // it — which is exactly why the light computes it rather than trusting it.
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'archived', enabled: 0 })
  seedLoopBeat(db)
  seedPosition(db, { account: 'A' })
  const row = of(accountTrafficLights(db, { now: NOW }), 'A')
  assert.equal(row.lights.manage.state, 'red')
  assert.match(row.lights.manage.reason, /NOT WATCHING/)
  assert.equal(row.unmanagedExposure, true)
  assert.equal(row.overall, 'red')
})

test('a properly archived account is never red on Manage', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  assert.equal(archiveAccount(db, 'A').ok, true)
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.manage
  assert.notEqual(l.state, 'red')
})

test('unstamped positions count toward the asking account stop coverage', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedLoopBeat(db)
  seedPosition(db, { account: null, sl: null })
  const l = of(accountTrafficLights(db, { now: NOW }), 'A').lights.manage
  assert.equal(l.state, 'amber', 'a pre-stamping position without a stop is still exposure')
})

test('the overall state is the worst of the four', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' }) // Scan red
  seedLoopBeat(db)
  recordBrokerRoster(db, [{ accountId: 'A' }])
  assert.equal(of(accountTrafficLights(db, { now: NOW }), 'A').overall, 'red')
})

test('an empty registry produces an empty list rather than throwing', () => {
  const db = freshDb()
  const out = accountTrafficLights(db, { now: NOW })
  assert.deepEqual(out.accounts, [])
  assert.equal(out.globalHalt, false)
})
