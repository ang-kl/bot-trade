import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { archiveAccount } from './account-capabilities.js'
import {
  planPendingDisposition, dispositionFor, drainHoursFor, deadlineFor, mayArmPending,
  DEFAULT_DISPOSITION, DEFAULT_DRAIN_HOURS, STATE_KEY, DISPOSITIONS, UNIMPLEMENTED_SIGNALS,
} from './pause-disposition.js'

const NOW = Date.parse('2026-08-03T12:00:00Z')
const HOUR = 3_600_000

function freshDb() {
  return initDB(':memory:')
}

function seedAccount(db, id, { mode = 'paused', enabled = 1, params = null } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, mode, params, updated_at)
     VALUES (?, 0, ?, ?, ?, ?)`
  ).run(String(id), enabled, mode, params ? JSON.stringify(params) : '{}', new Date(NOW).toISOString())
}

function seedPending(db, { account = 'A', symbol = 'EURUSD', placedMs = NOW - HOUR, expiresMs = null, strategy = null, status = 'working' } = {}) {
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
  const info = db.prepare(
    `INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume,
                                 placed_at, expires_at, status, account_id, strategy)
     VALUES (?, 'H1', 'o1', 1, 1.1, 1.09, 1.12, 0.01, ?, ?, ?, ?, ?)`
  ).run(symbol, iso(placedMs), iso(expiresMs), status, account, strategy)
  return info.lastInsertRowid
}

const plan = (db, over = {}) => planPendingDisposition(db, { accountId: 'A', now: NOW, ...over })

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('the default disposition is the owner decision, not cancel', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  assert.equal(dispositionFor(db, 'A'), 'supervised-drain')
  assert.equal(DEFAULT_DISPOSITION, 'supervised-drain')
})

test('a per-account override beats the global default', () => {
  const db = freshDb()
  seedAccount(db, 'A', { params: { pauseDisposition: 'cancel' } })
  setState(db, STATE_KEY, JSON.stringify({ disposition: 'keep' }))
  assert.equal(dispositionFor(db, 'A'), 'cancel')
})

test('the global setting applies when the account has no override', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  setState(db, STATE_KEY, JSON.stringify({ disposition: 'cancel' }))
  assert.equal(dispositionFor(db, 'A'), 'cancel')
})

test('an unrecognised disposition falls back rather than being obeyed', () => {
  // The dangerous failure would be an unknown value resolving to "keep",
  // since keep is the one that stops looking.
  const db = freshDb()
  seedAccount(db, 'A', { params: { pauseDisposition: 'abandon' } })
  assert.equal(dispositionFor(db, 'A'), 'supervised-drain')
  setState(db, STATE_KEY, '{not json')
  assert.equal(dispositionFor(db, 'A'), 'supervised-drain')
})

test('drain hours default to 24 and are overridable at both levels', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  assert.equal(drainHoursFor(db, 'A'), DEFAULT_DRAIN_HOURS)
  setState(db, STATE_KEY, JSON.stringify({ drainHours: 6 }))
  assert.equal(drainHoursFor(db, 'A'), 6)
  seedAccount(db, 'A', { params: { drainHours: 2 } })
  assert.equal(drainHoursFor(db, 'A'), 2)
  seedAccount(db, 'A', { params: { drainHours: -5 } })
  assert.equal(drainHoursFor(db, 'A'), 6, 'a nonsense override is ignored, not applied')
})

// ---------------------------------------------------------------------------
// Deadlines — the guard that stops supervised-drain becoming keep
// ---------------------------------------------------------------------------

test('an order own expiry wins over the drain window', () => {
  const d = deadlineFor({ expires_at: '2026-08-03T18:00:00Z', placed_at: '2026-08-03T00:00:00Z' }, { drainHours: 24 })
  assert.equal(d.source, 'expires_at')
  assert.equal(d.at, Date.parse('2026-08-03T18:00:00Z'))
})

test('without an expiry the drain window runs from placement', () => {
  const d = deadlineFor({ placed_at: '2026-08-03T00:00:00Z' }, { drainHours: 6 })
  assert.equal(d.source, 'drain_window')
  assert.equal(d.at, Date.parse('2026-08-03T06:00:00Z'))
})

test('SQLite space-form timestamps parse as UTC', () => {
  const spaced = deadlineFor({ placed_at: '2026-08-03 00:00:00' }, { drainHours: 6 })
  const iso = deadlineFor({ placed_at: '2026-08-03T00:00:00Z' }, { drainHours: 6 })
  assert.equal(spaced.at, iso.at)
})

test('an unparseable timestamp yields an UNKNOWN deadline, never "now"', () => {
  const d = deadlineFor({ placed_at: 'nonsense' }, { drainHours: 6 })
  assert.equal(d.at, null)
  assert.equal(d.source, 'unknown')
})

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('an account that may still enter is not paused — its pendings are left alone', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active' })
  seedPending(db, {})
  const out = plan(db)
  assert.equal(out.entering, true)
  assert.equal(out.actions[0].action, 'keep')
  assert.match(out.actions[0].reason, /still entering/)
})

test('supervised-drain WATCHES a fresh pending rather than cancelling it', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { placedMs: NOW - HOUR })
  const a = plan(db).actions[0]
  assert.equal(a.action, 'watch')
  assert.match(a.reason, /draining/)
  assert.ok(a.msLeft > 0)
})

test('supervised-drain CANCELS once the drain window has passed, and says which deadline', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { placedMs: NOW - 30 * HOUR })
  const a = plan(db).actions[0]
  assert.equal(a.action, 'cancel')
  assert.equal(a.signal, 'drain_deadline')
  assert.match(a.reason, /24h drain window/)
})

test('an order past its OWN expiry is cancelled, and the reason names that', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { placedMs: NOW - HOUR, expiresMs: NOW - 60_000 })
  const a = plan(db).actions[0]
  assert.equal(a.action, 'cancel')
  assert.equal(a.signal, 'drain_deadline')
  assert.match(a.reason, /own expiry/)
})

test('an unparseable timestamp keeps the order under supervision — never cancelled on a guess', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  const id = seedPending(db, {})
  db.prepare('UPDATE pending_orders SET placed_at = ?, expires_at = NULL WHERE id = ?').run('not a date', id)
  const a = plan(db).actions[0]
  assert.equal(a.action, 'watch')
  assert.equal(a.msLeft, null)
  assert.match(a.reason, /rather than cancelled on a guess/)
})

test('a disarmed strategy invalidates the resting order', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { strategy: 'cup_handle' })
  const a = plan(db, { armedStrategies: ['ema', 'rsi2'] }).actions[0]
  assert.equal(a.action, 'cancel')
  assert.equal(a.signal, 'strategy_disarmed')
  assert.match(a.reason, /cup_handle/)
})

test('omitting the armed set skips that check rather than treating everything as disarmed', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { strategy: 'cup_handle' })
  assert.equal(plan(db).actions[0].action, 'watch')
})

test('cancel disposition cancels immediately, regardless of the countdown', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused', params: { pauseDisposition: 'cancel' } })
  seedPending(db, { placedMs: NOW })
  const a = plan(db).actions[0]
  assert.equal(a.action, 'cancel')
  assert.equal(a.signal, 'pause_cancel')
})

test('keep leaves the order armed AND says out loud that it is not monitored', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused', params: { pauseDisposition: 'keep' } })
  seedPending(db, { placedMs: NOW - 40 * HOUR })
  const a = plan(db).actions[0]
  assert.equal(a.action, 'keep')
  assert.match(a.reason, /not monitored/,
    'keep is the one disposition that stops looking, and the plan must not hide that')
})

test('an archived account cancels its resting orders', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active' })
  assert.equal(archiveAccount(db, 'A').ok, true)
  seedPending(db, {})
  const a = plan(db).actions[0]
  assert.equal(a.action, 'cancel')
  assert.equal(a.signal, 'account_archived')
})

test('only WORKING rows are planned — filled and cancelled ones are done', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { status: 'filled' })
  seedPending(db, { status: 'cancelled' })
  assert.equal(plan(db).actions.length, 0)
})

test('another account resting orders are not planned', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedAccount(db, 'B', { mode: 'paused' })
  seedPending(db, { account: 'B' })
  assert.equal(plan(db).actions.length, 0)
  assert.equal(planPendingDisposition(db, { accountId: 'B', now: NOW }).actions.length, 1)
})

test('every action carries the countdown and where the deadline came from', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'paused' })
  seedPending(db, { placedMs: NOW - HOUR })
  const a = plan(db).actions[0]
  assert.equal(a.deadlineSource, 'drain_window')
  assert.ok(a.deadlineAt)
  assert.ok(Number.isFinite(a.msLeft))
})

// ---------------------------------------------------------------------------
// The other half: no new orders while paused
// ---------------------------------------------------------------------------

test('all three dispositions agree that a paused account arms nothing new', () => {
  const db = freshDb()
  for (const d of DISPOSITIONS) {
    seedAccount(db, 'A', { mode: 'paused', params: { pauseDisposition: d } })
    const r = mayArmPending(db, 'A')
    assert.equal(r.ok, false, `${d} must still arm nothing new`)
    assert.match(r.reason, /paused/)
  }
})

test('an entering account may still arm', () => {
  const db = freshDb()
  seedAccount(db, 'A', { mode: 'active' })
  assert.equal(mayArmPending(db, 'A').ok, true)
})

test('an account the registry has never seen is LEFT ALONE, not blocked', () => {
  // Deliberately the opposite of accountCapabilities' conservative default,
  // because it is a different question. Blocking here would silently stop
  // pending orders on the legacy single-account path — where the registry row
  // may simply not exist — to prevent a risk that only applies to accounts the
  // operator explicitly paused. The existing pending-order tests caught this.
  const db = freshDb()
  const r = mayArmPending(db, '9999999')
  assert.equal(r.ok, true)
  assert.equal(r.unknownAccount, true, 'allowed, but flagged as an unknown rather than an endorsement')
})

test('the unimplemented invalidation signals are declared, not silently missing', () => {
  // The plan names symbol cooldown, streak breaker and the news window. They
  // are evaluated at ENTRY time in the risk gate, not against a resting order,
  // so this slice does not cover them — and says so rather than letting the
  // absence read as coverage.
  assert.deepEqual(UNIMPLEMENTED_SIGNALS, ['symbol_cooldown', 'streak_breaker', 'news_window'])
})
