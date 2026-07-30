// node --test agent/services/mark-unresolvable.test.js
//
// UNKNOWN vs UNKNOWABLE (owner's decision 2026-07-30, "option 2").
//
// The unknown-P&L veto is fail-closed and stays that way. What it lacked was an
// END: pnl-backfill can only repair a row while the close is inside the broker's
// deal-history window, and once it falls out the row can never fill. Production
// showed 77 such rows with the backfill parked on its 6-hour rung attempting zero
// accounts — a stop with no release. These tests pin the evidence rule that
// decides when a row may stop blocking, and pin that nothing is invented.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  findUnresolvableCandidates, markUnresolvable, sweepUnresolvable,
  DEFAULT_UNRESOLVABLE_HORIZON_DAYS,
} from './mark-unresolvable.js'
import { unresolvedPnlSince, unknownPnlBlocks } from './unresolved-pnl.js'

const ACCT = '46130058'

function closedNoPnl(db, { daysAgo = 30, accountId = ACCT, exitPrice = null } = {}) {
  return db.prepare(`
    INSERT INTO trades (symbol, side, status, net_pnl, account_id, exit_price, opened_at, closed_at)
    VALUES ('EURUSD', 'BUY', 'closed', NULL, ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(accountId, exitPrice, `-${daysAgo + 1} days`, `-${daysAgo} days`).lastInsertRowid
}

test('BOTH halves of the evidence are required — age alone is not enough', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })
  // The backfill has never given up on this account, so nothing qualifies:
  // an outage that merely delayed the backfill must not write rows off.
  assert.deepEqual(findUnresolvableCandidates(db, { exhaustedAccounts: [] }), [])
  assert.equal(findUnresolvableCandidates(db, { exhaustedAccounts: [ACCT] }).length, 1)
})

test('BOTH halves are required — exhaustion alone is not enough either', () => {
  const db = initDB(':memory:')
  // A close from today. The backfill has given up on the account (an unrelated
  // old row pushed its ladder up), but this row is UNKNOWN, not unknowable, and
  // blocking on it is exactly what the veto is for.
  closedNoPnl(db, { daysAgo: 0 })
  assert.deepEqual(findUnresolvableCandidates(db, { exhaustedAccounts: [ACCT] }), [])
})

test('the horizon is respected, and defaults to a week', () => {
  const db = initDB(':memory:')
  assert.equal(DEFAULT_UNRESOLVABLE_HORIZON_DAYS, 7)
  closedNoPnl(db, { daysAgo: 3 })
  assert.deepEqual(findUnresolvableCandidates(db, { exhaustedAccounts: [ACCT] }), [])
  assert.equal(findUnresolvableCandidates(db, { exhaustedAccounts: [ACCT], horizonDays: 1 }).length, 1)
})

test('a row that already has a P&L is never a candidate', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, status, net_pnl, account_id, opened_at, closed_at)
    VALUES ('EURUSD','BUY','closed', -12.5, ?, datetime('now','-31 days'), datetime('now','-30 days'))
  `).run(ACCT)
  assert.deepEqual(findUnresolvableCandidates(db, { exhaustedAccounts: [ACCT] }), [])
})

test('marking stops the row blocking, and net_pnl is STILL NULL — nothing is invented', () => {
  const db = initDB(':memory:')
  const id = closedNoPnl(db, { daysAgo: 30 })
  const since = `datetime('now','-90 days')`
  const dayStart = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ')

  // Before: it blocks.
  const before = unresolvedPnlSince(db, dayStart, { accountId: ACCT })
  assert.equal(before.count, 1)
  assert.equal(unknownPnlBlocks(before).block, true)

  assert.equal(sweepUnresolvable(db, { exhaustedAccounts: [ACCT], dryRun: false }).marked, 1)

  // After: it does not block, it is COUNTED, and the P&L is still unknown.
  const after = unresolvedPnlSince(db, dayStart, { accountId: ACCT })
  assert.equal(after.count, 0, 'no longer blocking')
  assert.equal(after.unresolvableCount, 1, 'but still reported — the decision is visible')
  assert.equal(unknownPnlBlocks(after).block, false)
  assert.equal(db.prepare('SELECT net_pnl FROM trades WHERE id = ?').get(id).net_pnl, null,
    'net_pnl is untouched — no figure was computed, estimated or copied')
  void since
})

test('dry run is the default and writes nothing, but shows whether an exit price exists', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30, exitPrice: 1.2345 })
  closedNoPnl(db, { daysAgo: 30 })
  const out = sweepUnresolvable(db, { exhaustedAccounts: [ACCT] })
  assert.equal(out.dryRun, true)
  assert.equal(out.found, 2)
  // hasExitPrice is the one field that would let a later pass compute a REAL
  // figure instead of writing the row off, so the plan has to show it.
  assert.deepEqual(out.plan.map(p => p.hasExitPrice).sort(), [false, true])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades WHERE pnl_unresolvable = 1').get().n, 0)
})

test('marking is idempotent and records its reason on the row', () => {
  const db = initDB(':memory:')
  const id = closedNoPnl(db, { daysAgo: 30 })
  assert.equal(markUnresolvable(db, id, 'because'), true)
  assert.equal(markUnresolvable(db, id, 'again'), false, 'already marked')
  const row = db.prepare('SELECT pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at FROM trades WHERE id = ?').get(id)
  assert.equal(row.pnl_unresolvable, 1)
  assert.equal(row.pnl_unresolvable_reason, 'because')
  assert.ok(row.pnl_unresolvable_at)
})

test('the sweep is audited — stopping to wait for money data must never be silent', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })
  sweepUnresolvable(db, { exhaustedAccounts: [ACCT], dryRun: false })
  const rows = db.prepare(`SELECT * FROM action_log WHERE method = 'PNL_UNRESOLVABLE'`).all()
  assert.equal(rows.length, 1)
  const body = JSON.parse(rows[0].body)
  assert.equal(body.marked, 1)
  assert.deepEqual(body.accounts, [ACCT])
})

test('a still-blocking row and an unresolvable row coexist — the veto keeps working', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })   // will be written off
  closedNoPnl(db, { daysAgo: 0 })    // today's close, must keep blocking
  sweepUnresolvable(db, { exhaustedAccounts: [ACCT], dryRun: false })
  const dayStart = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ')
  const v = unresolvedPnlSince(db, dayStart, { accountId: ACCT, graceMin: 0 })
  assert.equal(v.count, 1, 'the recent unknown still blocks')
  assert.equal(v.unresolvableCount, 1)
  assert.equal(unknownPnlBlocks(v, { graceMin: 0 }).block, true)
})

// ---------------------------------------------------------------------------
// AUDIT FINDING, 2026-07-30, against my own #513. That PR claimed excluding
// unresolvable rows from the blocking count meant "trading resuming is never
// silent about what it stopped waiting for". It was not true as shipped:
// unresolvableCount was computed, passed to unknownPnlBlocks, and dropped —
// the signature did not destructure it, and a reason string only exists on a
// VETO. So in the exact case that matters (rows written off, veto lifted,
// trading resumes) nothing was said anywhere.
// ---------------------------------------------------------------------------

test('a lifted veto SAYS what it stopped waiting for', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })
  const dayStart = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ')
  sweepUnresolvable(db, { exhaustedAccounts: [ACCT], dryRun: false })

  const after = unresolvedPnlSince(db, dayStart, { accountId: ACCT })
  const verdict = unknownPnlBlocks(after)
  assert.equal(verdict.block, false, 'the veto is lifted')
  // ...and it is not silent about why it is now allowed to be.
  assert.match(verdict.note, /1 closed trade\(s\).*unresolvable/)
  assert.match(verdict.note, /permanently unknown, not zero/)
})

test('a STILL-blocking veto names the written-off rows alongside the blocking ones', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })                 // will be written off
  const dayStart = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ')
  sweepUnresolvable(db, { exhaustedAccounts: [ACCT], dryRun: false })
  closedNoPnl(db, { daysAgo: 20 })                 // still blocking, still fillable

  const both = unresolvedPnlSince(db, dayStart, { accountId: ACCT })
  assert.equal(both.count, 1)
  assert.equal(both.unresolvableCount, 1)
  const verdict = unknownPnlBlocks(both)
  assert.equal(verdict.block, true)
  // The reason stays about the refusal; the note carries the other fact.
  assert.match(verdict.reason, /1 closed trade\(s\) today have no realised P&L/)
  assert.match(verdict.note, /unresolvable/)
})

test('no note at all when nothing has been written off — never a phantom reassurance', () => {
  const db = initDB(':memory:')
  closedNoPnl(db, { daysAgo: 30 })
  const dayStart = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ')
  const v = unknownPnlBlocks(unresolvedPnlSince(db, dayStart, { accountId: ACCT }))
  assert.equal(v.block, true)
  assert.equal(v.note, undefined)
  // Same for the clean case and for the disabled case.
  assert.equal(unknownPnlBlocks({ count: 0 }).note, undefined)
  assert.equal(unknownPnlBlocks({ count: 5, unresolvableCount: 0 }, { enabled: false }).note, undefined)
})

test('the note survives even when the veto is switched OFF entirely', () => {
  // blockOnUnknownPnl=false returns early. A row the broker will never explain
  // is still worth saying out loud, whatever the veto is set to.
  const v = unknownPnlBlocks({ count: 3, unresolvableCount: 2 }, { enabled: false })
  assert.equal(v.block, false)
  assert.match(v.note, /2 closed trade\(s\)/)
})
