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
import { mkdtempSync } from '../test-support/temp-dir.js'
import { enqueueVerifyBacklog, MAX_REVERIFY, REVERIFY_BATCH, resetBacklogReports } from './position-capture.js'
import { VERDICT_CONTRACT_VERSION } from '../lib/verify-contract.js'
import { initDB as realInitDB } from '../db.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

function db () {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE position_history (
      account_id TEXT NOT NULL, ctrader_position_id TEXT NOT NULL,
      symbol TEXT, closed_at_ms INTEGER,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      verifier_version INTEGER, rebuilt_at TEXT, built_at TEXT,
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

const hist = (d, pid, state = 'unverified', closed = 1000, ver = null) =>
  d.prepare('INSERT INTO position_history (account_id, ctrader_position_id, symbol, closed_at_ms, verification_state, verifier_version) VALUES (?,?,?,?,?,?)')
    .run('A1', pid, 'EURUSD', closed, state, ver)

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

test('verified and absent records are left alone, and so is a CURRENT dispute — an answer is an answer', () => {
  const d = db()
  hist(d, '300', 'verified', 1000, VERDICT_CONTRACT_VERSION)
  hist(d, '301', 'disputed', 1000, VERDICT_CONTRACT_VERSION)
  q(d, '300', 'captured'); q(d, '301', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 0)
  assert.equal(row(d, '300').state, 'captured')
  assert.equal(row(d, '301').state, 'captured',
    'a dispute produced by the rules now in force is a FINDING and stays put')
})

// PR-AY. The rule above used to read "verified and disputed records are left
// alone — a dispute is an answer, not a question", and for a dispute under the
// CURRENT contract it still does. What changed is the case it could not see.
//
// MEASURED 18-09-2026: cpp-verify compared cTrader's money integer against
// this keeper's dollars and disputed ten records by exactly 100x. PR-AW fixed
// the comparison and reached NONE of them — `disputed` was terminal, so the
// tally would have read `verified: 0` for ever with a correct verifier and no
// way to show it. `disputed` could not tell "the broker and the keeper
// disagree" from "the verifier was wrong when it asked".
test('PR-AY: a dispute from an OLDER contract is re-asked — the verifier has since been fixed', () => {
  const d = db()
  hist(d, '310', 'disputed', 1000, VERDICT_CONTRACT_VERSION - 1)
  q(d, '310', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 1)
  assert.equal(row(d, '310').state, 'pending', 'it goes back in the queue')
})

test('PR-AY: a dispute with NO version is stale — absent is not the same as up to date', () => {
  // Every verdict written before PR-AY has a NULL version. Reading NULL as
  // current would strand exactly the records this exists to rescue.
  const d = db()
  hist(d, '320', 'disputed', 1000, null)
  q(d, '320', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 1)
})

test('PR-AY: a stale VERIFIED record is NOT re-asked — a stricter rule does not undo an agreement', () => {
  // The asymmetry is deliberate. Re-opening an agreement would eventually
  // overwrite it, and the failure this fixes was disputes that could not be
  // revisited, not agreements that might be wrong.
  const d = db()
  hist(d, '330', 'verified', 1000, null)
  q(d, '330', 'captured')
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 0)
})

test('PR-AY: a stale dispute still respects the re-verify cap — it is not an escape hatch', () => {
  const d = db()
  hist(d, '340', 'disputed', 1000, null)
  q(d, '340', 'captured', MAX_REVERIFY)
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).armed, 0,
    'the cap PR-AP built still bounds the work a bad verifier can cause')
})

test('PR-AY: the keeper contract matches the verifier contract, exactly', () => {
  // A keeper that thinks the contract is NEWER than the verifier's would
  // re-ask the same records for ever — every answer would arrive stamped
  // older than the threshold. One that thinks it is OLDER would never re-ask.
  const cpp = readFileSync(new URL('../../cpp-verify/src/verdict.hpp', import.meta.url), 'utf8')
  const m = cpp.match(/constexpr int kVerdictContractVersion = (\d+);/)
  assert.ok(m, 'cpp-verify declares a contract version')
  assert.equal(Number(m[1]), VERDICT_CONTRACT_VERSION,
    'and the two sides agree on what it is')
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
  assert.match(src, /if\s*\(verifier\)\s*\{[\s\S]{0,400}enqueueVerifyBacklog\(db,\s*\{\s*accountId\s*\}\)/,
    'it must be gated on a configured verifier: without one a re-capture costs broker traffic and returns no verdict')

  // PR-AT: the loop must log what the PASS decided is worth saying, not only
  // its successes. `if (backlog.armed)` is the exact line that made 18-09's
  // zero unexplainable, so it must not come back.
  assert.match(src, /if \(backlog\.report\) log\(/,
    'the loop logs backlog.report — which covers the zero case')
  assert.doesNotMatch(src, /if \(backlog\.armed\) log\(/,
    'logging only on a non-zero arming is what made the silent zero undebuggable')
})

// ---------------------------------------------------------------------------
// PR-AT — THE ZERO EXPLAINS ITSELF.
//
// On 18-09-2026 the pass began arming zero with 41 eligible-looking records
// sitting untouched, and it said NOTHING, because loop.js logged only
// `if (backlog.armed)`. Four theories were produced and none could be
// confirmed: no count was exposed, so the logs could not distinguish "nothing
// to do" from "query returned nothing" from "pass never ran".
//
// These tests pin the breakdown and the dedupe. The dedupe matters as much as
// the breakdown: sixty identical lines an hour is a log nobody reads, which
// fails the same way silence does.
// ---------------------------------------------------------------------------

test('the four buckets are EXHAUSTIVE against unverified', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'e1'); q(d, 'e1', 'captured', 0)          // eligible
  hist(d, 'e2')                                      // eligible, no queue row
  hist(d, 'b1'); q(d, 'b1', 'captured', MAX_REVERIFY) // at the cap
  hist(d, 't1'); q(d, 't1', 'gave_up', 0)           // terminal
  hist(d, 'p1'); q(d, 'p1', 'pending', 0)           // already queued
  const r = enqueueVerifyBacklog(d, { accountId: 'A1', limit: 0 })
  assert.equal(r.unverified, 5)
  assert.equal(r.eligible, 2)
  assert.equal(r.blockedByAttempts, 1)
  assert.equal(r.terminal, 1)
  assert.equal(r.alreadyQueued, 1)
  assert.equal(r.eligible + r.blockedByAttempts + r.terminal + r.alreadyQueued, r.unverified,
    'if these do not sum, a record is in a state nothing accounts for — that is the finding')
})

test('A ZERO WITH WORK OUTSTANDING REPORTS, naming why none was armed', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'b1'); q(d, 'b1', 'captured', MAX_REVERIFY)
  hist(d, 'b2'); q(d, 'b2', 'captured', MAX_REVERIFY)
  const r = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.equal(r.armed, 0)
  assert.ok(r.report, 'a zero with unverified records left MUST say something')
  assert.match(r.report, /0 armed of 2 unverified/)
  assert.match(r.report, /0 eligible/)
  assert.match(r.report, /2 at the re-verify cap/)
})

test('a zero with NOTHING outstanding stays silent — that is the healthy state', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'v1', 'verified'); q(d, 'v1', 'captured')
  const r = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.equal(r.armed, 0)
  assert.equal(r.report, null, 'an empty backlog is not news')
})

test('THE SAME ZERO IS NOT REPEATED — sixty lines an hour is silence by another route', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'b1'); q(d, 'b1', 'captured', MAX_REVERIFY)
  const first = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.ok(first.report, 'the first time it enters this state, it says so')
  const second = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.equal(second.report, null, 'unchanged means silence, which is then a fact not an absence')
})

test('...but a CHANGED zero reports again', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'b1'); q(d, 'b1', 'captured', MAX_REVERIFY)
  assert.ok(enqueueVerifyBacklog(d, { accountId: 'A1' }).report)
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).report, null)
  hist(d, 'b2'); q(d, 'b2', 'captured', MAX_REVERIFY)   // the picture moved
  const r = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.ok(r.report, 'a different backlog is different news')
  assert.match(r.report, /0 armed of 2 unverified/)
})

test('a non-zero arming ALWAYS reports — an event, not a state', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'e1'); q(d, 'e1', 'captured', 0)
  const first = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.match(first.report, /re-armed 1 unverified record\(s\)/)
  d.prepare("UPDATE position_capture_queue SET state='captured', reverify_attempts=0 WHERE position_id='e1'").run()
  const second = enqueueVerifyBacklog(d, { accountId: 'A1' })
  assert.match(second.report, /re-armed 1 unverified record\(s\)/, 'repeated work is repeated news')
})

test('accounts are reported independently — one going quiet must not silence another', () => {
  const d = db()
  resetBacklogReports()
  hist(d, 'b1'); q(d, 'b1', 'captured', MAX_REVERIFY)
  assert.ok(enqueueVerifyBacklog(d, { accountId: 'A1' }).report)
  assert.equal(enqueueVerifyBacklog(d, { accountId: 'A1' }).report, null)
  // A2 has its own state and its own first time.
  d.prepare('INSERT INTO position_history (account_id, ctrader_position_id, symbol, closed_at_ms, verification_state) VALUES (?,?,?,?,?)')
    .run('A2', 'x1', 'EURUSD', 1000, 'unverified')
  d.prepare('INSERT INTO position_capture_queue (account_id, position_id, due_at_ms, state, attempts, reverify_attempts) VALUES (?,?,?,?,?,?)')
    .run('A2', 'x1', 1, 'captured', 0, MAX_REVERIFY)
  assert.ok(enqueueVerifyBacklog(d, { accountId: 'A2' }).report, 'A2 has never reported before')
})


// ---------------------------------------------------------------------------
// B1 (18-09-2026): the cap counts asks of ONE record. #951's boot rebuild
// moved volume and close time on 18 …0949 records that were already at the
// cap; without this they could never be asked about what they now say.
// ---------------------------------------------------------------------------

test('B1: a record rebuilt AFTER its last ask is eligible past the cap, and its count restarts at 1', () => {
  const d = db()
  hist(d, 'p1', 'unverified', 1000, VERDICT_CONTRACT_VERSION)
  q(d, 'p1', 'captured', 3)                                    // at the cap …
  d.prepare(`UPDATE position_capture_queue SET settled_at = '2026-09-18T07:00:00.000Z' WHERE position_id = 'p1'`).run()
  d.prepare(`UPDATE position_history SET rebuilt_at = '2026-09-18T08:20:00.000Z' WHERE ctrader_position_id = 'p1'`).run() // … rebuilt after
  const out = enqueueVerifyBacklog(d, { accountId: 'A1', now: 5 })
  assert.equal(out.armed, 1, 'asked again about the record as it now stands')
  assert.equal(d.prepare(`SELECT reverify_attempts, state FROM position_capture_queue WHERE position_id = 'p1'`).get().reverify_attempts, 1)
  assert.equal(out.blockedByAttempts, 0, 'not counted as capped')
})

test('B1: a record rebuilt BEFORE its last ask stays capped — the rebuild was already asked about', () => {
  const d = db()
  hist(d, 'p2', 'unverified', 1000, VERDICT_CONTRACT_VERSION)
  q(d, 'p2', 'captured', 3)
  d.prepare(`UPDATE position_capture_queue SET settled_at = '2026-09-18T09:00:00.000Z' WHERE position_id = 'p2'`).run()
  d.prepare(`UPDATE position_history SET rebuilt_at = '2026-09-18T08:20:00.000Z' WHERE ctrader_position_id = 'p2'`).run()
  const out = enqueueVerifyBacklog(d, { accountId: 'A1', now: 5 })
  assert.equal(out.armed, 0)
  assert.equal(out.blockedByAttempts, 1)
})

test('B1: the migration backfills rebuilt_at only for records that HAD a verdict and were reset (unverified + verifier_version)', () => {
  const { tmpdir } = require('node:os'); const { join } = require('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'b1-')), 'agent.db')
  let real = realInitDB(file)
  const cols = () => real.prepare(`PRAGMA table_info(position_history)`).all().map(c => c.name)
  assert.ok(cols().includes('rebuilt_at'), 'the column exists on a fresh schema')
  // Recreate the pre-B1 state: drop the column, seed the three shapes, reopen.
  real.exec(`ALTER TABLE position_history DROP COLUMN rebuilt_at`)
  const ins = (pid, state, ver) => real.prepare(`INSERT INTO position_history (account_id, ctrader_position_id, symbol, direction, direction_reason, strategy, origin,
        planned_entry, planned_sl, risk_dist, entry_price, exit_price, volume, opened_at_ms, closed_at_ms, hold_ms, gross_pnl, commission, swap, net_pnl, realised_r,
        close_reason, sl_moves, tp_moves, scale_outs, events_json, sources_json, verification_state, verifier_version)
      VALUES ('A1', ?, 'EURUSD', 'long', 'r', 's', 'scan_dispatch', 1, 0.9, 0.1, 1, 1, 1, 1, 2, 1, 0, 0, 0, 0, 0, 'x', 0, 0, 0, '[]', '{}', ?, ?)`).run(pid, state, ver)
  ins('reset', 'unverified', 3)      // had a verdict, then rebuilt → backfilled
  ins('never', 'unverified', null)   // never answered → not backfilled
  ins('kept', 'disputed', 3)         // still carries its verdict → not backfilled
  real.close()
  real = realInitDB(file)
  const row = (pid) => real.prepare(`SELECT rebuilt_at FROM position_history WHERE ctrader_position_id = ?`).get(pid).rebuilt_at
  assert.ok(row('reset'), 'reset by a rebuild → stamped')
  assert.equal(row('never'), null)
  assert.equal(row('kept'), null)
  real.close()
})
