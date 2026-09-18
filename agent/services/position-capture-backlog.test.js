// PR-AP — the verify backlog: complete records that never got a verdict are
// re-armed into the EXISTING capture queue, and the re-arming terminates.
//
// WHAT THESE TESTS ARE FOR. The backlog pass touches rows that are already
// settled, which is the dangerous direction: a mistake here does not fail
// loudly, it quietly re-opens terminal rows or loops for ever against a
// verifier that is down. So the assertions are about what it REFUSES to touch
// at least as much as what it arms.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { enqueueVerifyBacklog, MAX_REVERIFY, REVERIFY_BATCH } from './position-capture.js'

function db () {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE position_history (
      account_id TEXT NOT NULL, ctrader_position_id TEXT NOT NULL,
      symbol TEXT, closed_at_ms INTEGER,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      PRIMARY KEY (account_id, ctrader_position_id)
    );
    CREATE TABLE position_capture_queue (
      account_id TEXT NOT NULL, position_id TEXT NOT NULL, symbol TEXT,
      due_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','captured','gave_up')),
      last_error TEXT, enqueued_at TEXT, settled_at TEXT,
      reverify_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, position_id)
    );
  `)
  return d
}

const hist = (d, pid, state = 'unverified', closed = 1000) =>
  d.prepare('INSERT INTO position_history (account_id, ctrader_position_id, symbol, closed_at_ms, verification_state) VALUES (?,?,?,?,?)')
    .run('A1', pid, 'EURUSD', closed, state)

const q = (d, pid, state, rv = 0, attempts = 0) =>
  d.prepare('INSERT INTO position_capture_queue (account_id, position_id, due_at_ms, state, attempts, reverify_attempts, settled_at) VALUES (?,?,?,?,?,?,?)')
    .run('A1', pid, 1, state, attempts, rv, 'then')

const row = (d, pid) =>
  d.prepare('SELECT * FROM position_capture_queue WHERE account_id = ? AND position_id = ?').get('A1', pid)

test('a captured row with no verdict is re-armed to pending and due now', () => {
  const d = db()
  hist(d, '100')
  q(d, '100', 'captured', 0, 4)
  const r = enqueueVerifyBacklog(d, { accountId: 'A1', now: 7777 })
  assert.equal(r.armed, 1)
  const got = row(d, '100')
  assert.equal(got.state, 'pending')
  assert.equal(got.due_at_ms, 7777)
  assert.equal(got.reverify_attempts, 1)
  // attempts is reset: the previous build SUCCEEDED, so carrying a count of 4
  // would push a healthy row toward gave_up on the next two failures.
  assert.equal(got.attempts, 0)
  assert.equal(got.settled_at, null)
})

test('a gave_up row is NEVER re-armed — that record could not be built at all', () => {
  const d = db()
  hist(d, '200')
  q(d, '200', 'gave_up', 0)
  const r = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.equal(r.armed, 0)
  assert.equal(row(d, '200').state, 'gave_up', 'the terminal state and its count must survive')
})

test('verified and disputed records are left alone — a dispute is an answer, not a question', () => {
  const d = db()
  hist(d, '300', 'verified')
  hist(d, '301', 'disputed')
  q(d, '300', 'captured'); q(d, '301', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 0)
  assert.equal(row(d, '300').state, 'captured')
  assert.equal(row(d, '301').state, 'captured')
})

test('a record with no queue row at all is inserted, due immediately', () => {
  const d = db()
  hist(d, '400')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1', now: 555 }).armed, 1)
  const got = row(d, '400')
  assert.equal(got.state, 'pending')
  assert.equal(got.due_at_ms, 555, 'the broker settled long ago; the 30 s delay does not apply')
  assert.equal(got.reverify_attempts, 1)
})

test('IT TERMINATES: a row stops being armed once it hits MAX_REVERIFY', () => {
  const d = db()
  hist(d, '500')
  q(d, '500', 'captured', 0)
  // Simulate a verifier that never answers: arm, row stays unverified, arm again.
  for (let i = 0; i < MAX_REVERIFY; i++) {
    assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 1, `pass ${i + 1} should arm`)
    d.prepare("UPDATE position_capture_queue SET state='captured' WHERE position_id='500'").run()
  }
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 0,
    'without this cap a dead verifier re-pulls every record from the broker on every loop pass, for ever')
  assert.equal(row(d, '500').reverify_attempts, MAX_REVERIFY)
})

test('the batch is bounded, and takes the oldest closes first', () => {
  const d = db()
  for (let i = 0; i < 25; i++) { hist(d, String(600 + i), 'unverified', 9000 - i); q(d, String(600 + i), 'captured') }
  const r = enqueueVerifyBacklog(d, { accountId: 'A1', limit: 10 })
  assert.equal(r.armed, 10, 'one pass must not fire 25 broker deal pulls')
  // 624 has the smallest closed_at_ms, so it is armed; 600 the largest, so not.
  assert.equal(row(d, '624').state, 'pending')
  assert.equal(row(d, '600').state, 'captured')
})

test('another account is never touched', () => {
  const d = db()
  hist(d, '700'); q(d, '700', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A2' }).armed, 0)
  assert.equal(row(d, '700').state, 'captured')
})

test('no account id is refused rather than scanning the whole table', () => {
  const d = db()
  hist(d, '800'); q(d, '800', 'captured')
  const r = enqueueVerifyBacklog(d, { accountId: null })
  assert.equal(r.armed, 0)
  assert.equal(r.reason, 'no_identity')
})

// THE DEFAULT ITSELF MUST BE BOUNDED, not just the explicit argument.
//
// The batch test above passes `limit: 10`, so it keeps passing however large
// the default grows — a mutation raising REVERIFY_BATCH to 1000 left every
// test green. That is the whole of CLAUDE.md failure mode #1: a check that
// cannot distinguish the thing it is meant to guard. The default is what
// production actually uses, so the default is what gets pinned.
test('the DEFAULT batch is small — production passes no limit', () => {
  const d = db()
  for (let i = 0; i < 40; i++) { hist(d, String(900 + i), 'unverified', 9000 - i); q(d, String(900 + i), 'captured') }
  const r = enqueueVerifyBacklog(d, { accountId: 'A1' })   // no limit: the production call
  assert.equal(r.armed, REVERIFY_BATCH)
  assert.ok(REVERIFY_BATCH <= 25,
    `REVERIFY_BATCH is ${REVERIFY_BATCH}: each armed row costs a broker deal pull on the next drain, so a large default turns one loop pass into a burst of broker traffic`)
})

// THE CALL SITE IS PINNED, because it is invisible from this module and a
// refactor drops it in silence — CLAUDE.md failure mode #4, the repair that
// nothing calls. A backlog pass wired to nothing is not a cautious backlog,
// it is a dead one.
test('loop.js arms the backlog, and only when a verifier is configured', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')          // strip comments: a test must not pass by matching prose
  assert.match(src, /enqueueVerifyBacklog/, 'the backlog pass must be imported in the loop')
  assert.match(src, /if\s*\(verifier\)\s*\{[\s\S]{0,200}enqueueVerifyBacklog\(db,\s*\{\s*accountId\s*\}\)/,
    'it must be gated on a configured verifier: without one a re-capture costs broker traffic and returns no verdict')
})
