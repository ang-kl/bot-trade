// PR-AU — returning the attempts spent against a verifier that could not answer.
//
// THE TEST THAT MATTERS MOST is "runs exactly once". A reset that re-runs on
// every boot does not repair the cap, it ABOLISHES it: the predicate
// ("unverified and capped") starts matching again the moment the verifier has
// another bad run, so a predicate-only version would hand back the attempts
// for ever and the guard PR-AP built would stop existing. That is why this
// migration carries a marker, and why the marker is written in the same
// transaction as the update.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resetReverifyAttempts, REVERIFY_RESET_ID } from './reverify-reset.js'

function db () {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE position_history (
      account_id TEXT NOT NULL, ctrader_position_id TEXT NOT NULL,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      PRIMARY KEY (account_id, ctrader_position_id)
    );
    CREATE TABLE position_capture_queue (
      account_id TEXT NOT NULL, position_id TEXT NOT NULL,
      due_at_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','captured','gave_up')),
      reverify_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, position_id)
    );
  `)
  return d
}
const row = (d, pid, { vstate = 'unverified', qstate = 'captured', rv = 3, acct = 'A1' } = {}) => {
  d.prepare('INSERT INTO position_history (account_id, ctrader_position_id, verification_state) VALUES (?,?,?)')
    .run(acct, pid, vstate)
  d.prepare('INSERT INTO position_capture_queue (account_id, position_id, state, reverify_attempts) VALUES (?,?,?,?)')
    .run(acct, pid, qstate, rv)
}
const rv = (d, pid, acct = 'A1') =>
  d.prepare('SELECT reverify_attempts FROM position_capture_queue WHERE account_id = ? AND position_id = ?')
    .get(acct, pid).reverify_attempts

test('THE MEASURED CASE: capped unverified records get their attempts back', () => {
  const d = db()
  row(d, '1'); row(d, '2'); row(d, '3')
  const r = resetReverifyAttempts(d)
  assert.equal(r.applied, true)
  assert.equal(r.changes, 3)
  assert.equal(rv(d, '1'), 0)
  assert.equal(rv(d, '2'), 0)
})

test('IT RUNS EXACTLY ONCE — a second call is a no-op even with fresh matching rows', () => {
  const d = db()
  row(d, '1')
  assert.equal(resetReverifyAttempts(d).changes, 1)

  // The verifier has another bad run: a row is capped again. A predicate-only
  // migration would hand the attempts back here, which is the cap abolished.
  d.prepare("UPDATE position_capture_queue SET reverify_attempts = 3 WHERE position_id = '1'").run()
  row(d, '2')

  const second = resetReverifyAttempts(d)
  assert.equal(second.applied, false)
  assert.equal(second.reason, 'already')
  assert.equal(rv(d, '1'), 3, 'the cap holds on the second run — that is the whole point')
  assert.equal(rv(d, '2'), 3)
})

test('the marker records what it did, under a name that reads in six months', () => {
  const d = db()
  row(d, '1'); row(d, '2')
  resetReverifyAttempts(d)
  const m = d.prepare('SELECT * FROM migrations_applied WHERE id = ?').get(REVERIFY_RESET_ID)
  assert.ok(m, 'the marker exists')
  assert.equal(m.changes, 2, 'and carries the count, so the repair is auditable after the fact')
  assert.ok(m.applied_at, 'and when')
})

test('gave_up rows are NEVER touched — that record could not be built at all', () => {
  const d = db()
  row(d, 'g', { qstate: 'gave_up' })
  const r = resetReverifyAttempts(d)
  assert.equal(r.changes, 0)
  assert.equal(rv(d, 'g'), 3, 'the terminal count of trades this system could not describe survives')
})

test('verified and disputed records are left alone — a verdict is an answer', () => {
  const d = db()
  row(d, 'v', { vstate: 'verified' })
  row(d, 'x', { vstate: 'disputed' })
  assert.equal(resetReverifyAttempts(d).changes, 0)
  assert.equal(rv(d, 'v'), 3)
  assert.equal(rv(d, 'x'), 3, 'a dispute must not be re-opened and eventually overwritten by agreement')
})

test('pending rows are left alone — they are already on their way', () => {
  const d = db()
  row(d, 'p', { qstate: 'pending' })
  assert.equal(resetReverifyAttempts(d).changes, 0)
})

test('rows already at zero are not counted as repaired', () => {
  const d = db()
  row(d, 'z', { rv: 0 })
  assert.equal(resetReverifyAttempts(d).changes, 0, 'changes must mean records actually returned')
})

test('every account is repaired, not just the first', () => {
  const d = db()
  row(d, '1', { acct: 'A1' }); row(d, '1', { acct: 'A2' }); row(d, '1', { acct: 'A3' })
  assert.equal(resetReverifyAttempts(d).changes, 3)
  assert.equal(rv(d, '1', 'A2'), 0)
  assert.equal(rv(d, '1', 'A3'), 0)
})

test('a queue row with no matching history record is not touched', () => {
  const d = db()
  d.prepare('INSERT INTO position_capture_queue (account_id, position_id, state, reverify_attempts) VALUES (?,?,?,?)')
    .run('A1', 'orphan', 'captured', 3)
  assert.equal(resetReverifyAttempts(d).changes, 0,
    'without a complete record there is nothing to verify, so nothing to give back')
})

test('THE MARKER IS ATOMIC WITH THE UPDATE', () => {
  const d = db()
  row(d, '1')
  // Break the INSERT by pre-seeding the marker's primary key inside a table
  // the transaction will also write: the conflict throws, and the UPDATE must
  // roll back with it. If it did not, the next boot would reset again — and a
  // repair that can run twice is the same hazard as having no cap.
  d.exec(`CREATE TABLE IF NOT EXISTS migrations_applied (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            changes INTEGER)`)
  // A row under a DIFFERENT id, so the guard does not short-circuit, plus a
  // trigger that makes the marker insert fail.
  d.exec(`CREATE TRIGGER boom BEFORE INSERT ON migrations_applied
          BEGIN SELECT RAISE(ABORT, 'no'); END;`)
  assert.throws(() => resetReverifyAttempts(d))
  assert.equal(rv(d, '1'), 3, 'the update rolled back with the failed marker')
})

// THE CALL SITE IS PINNED. A migration nothing calls is the repair that
// nothing calls — failure mode #4, and invisible from this module. The first
// wiring of this one used `require()` inside an ESM file: it would have thrown
// on every boot and been swallowed by the surrounding catch, so the repair
// would never have run and nothing would have said so.
test('db.js imports and calls the reset, statically', () => {
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /import \{ resetReverifyAttempts \} from '\.\/services\/reverify-reset\.js'/,
    'a STATIC import: db.js is ESM, so require() would throw into the catch and run nothing')
  assert.doesNotMatch(code, /require\(['"]\.\/services\/reverify-reset\.js['"]\)/,
    'require() in an ESM module fails silently here')
  assert.match(code, /resetReverifyAttempts\(db\)/, 'and it must actually be called')
})
