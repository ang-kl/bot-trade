// node --test agent/services/unresolved-pnl.test.js
//
// P1 / AUDIT F-L6-06 — the daily-loss caps could not see a loss.
//
// SQLite's SUM skips NULLs and the surrounding COALESCE turns an all-NULL sum
// into 0, so a day made of broker-side stop-outs (which close with net_pnl
// left NULL, reconciler.js:285) presented as FLAT and neither the portfolio
// cap nor the per-account cap ever tripped. The brake was off for exactly the
// trades most likely to be losses.
//
// The rule under test: an unknown P&L is not zero. Past a grace window it
// blocks new entries. The grace exists because the backfill legitimately lags
// a cycle or two — without it a normal day would halt trading permanently.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  unresolvedPnlSince, unknownPnlBlocks,
  DEFAULT_UNKNOWN_PNL_GRACE_MIN,
} from './unresolved-pnl.js'
import { evaluateGlobalGuards, DEFAULT_GLOBAL_GUARDS } from './global-guards.js'
import { fxDayStartSql } from './risk.js'

function mkDb() { return initDB(':memory:') }

// These tests once inserted closes a fixed "60 minutes ago" and compared them
// against the REAL FX day anchor — which made every count-1 assertion fail
// between 21:00 and 22:00 UTC daily (right after the 5pm-NY day open, 60
// minutes ago is YESTERDAY'S day). Counting tests now pass a fixed epoch
// anchor (fully deterministic); the end-to-end guard tests, which use the
// real anchor internally, clamp their insert inside today's window instead.
const EPOCH_ANCHOR = '2000-01-01 00:00:00'
const minutesSinceFxDayStart = () =>
  Math.floor((Date.now() - Date.parse(fxDayStartSql().replace(' ', 'T') + 'Z')) / 60_000)
/** minutesAgo clamped to fall AFTER today's FX day open (floor keeps it out of a given grace). */
const safeMinutesAgo = (requested, floorMin = 2) =>
  Math.max(floorMin, Math.min(requested, minutesSinceFxDayStart() - 1))

/** A closed trade. `pnl` null = the broker-side-close shape this is all about. */
function closeTrade(db, { pnl = null, minutesAgo = 60, accountId = '111', symbol = 'EURUSD' } = {}) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, closed_at, status, net_pnl, account_id)
     VALUES (?, 'BUY', 1.1, 0.02, datetime('now','-1 day'), datetime('now', ?), 'closed', ?, ?)`
  ).run(symbol, `-${minutesAgo} minutes`, pnl, accountId).lastInsertRowid
}

// ---------------------------------------------------------------------------
// The reason this exists at all: prove SUM really does read NULLs as nothing.
// ---------------------------------------------------------------------------

test('the original sum reads a day of NULL-pnl closes as exactly zero', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null })
  closeTrade(db, { pnl: null })
  const row = db.prepare(
    `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
     WHERE status = 'closed' AND REPLACE(closed_at, 'T', ' ') >= ?`
  ).get(fxDayStartSql())
  assert.equal(row.pnl, 0, 'two unknown closures must sum to 0 — this is the defect')
})

// ---------------------------------------------------------------------------
// Counting the untrustworthy rows.
// ---------------------------------------------------------------------------

test('counts only NULL-pnl closes older than the grace window', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 60 })   // counts
  closeTrade(db, { pnl: null, minutesAgo: 2 })    // inside grace — the backfill has not had its turn
  closeTrade(db, { pnl: -12.5, minutesAgo: 60 })  // resolved — irrelevant
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15 })
  assert.equal(r.count, 1)
  assert.ok(r.oldestClosedAt)
})

test('a fully resolved day counts zero', () => {
  const db = mkDb()
  closeTrade(db, { pnl: -30 })
  closeTrade(db, { pnl: 12 })
  assert.equal(unresolvedPnlSince(db, fxDayStartSql(), { graceMin: 15 }).count, 0)
})

test('account scoping matches the cap it protects', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, accountId: '222' })
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111' }).count, 0, 'another account must not block this one')
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '222' }).count, 1)
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: null }).count, 1, 'portfolio scope sees every account')
})

test('a legacy NULL-account row still blocks the account being evaluated', () => {
  const db = mkDb()
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, closed_at, status, net_pnl, account_id)
     VALUES ('EURUSD','BUY',1.1,0.02,datetime('now','-1 day'),datetime('now','-60 minutes'),'closed',NULL,NULL)`
  ).run()
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111' }).count, 1)
})

test('closures before the day anchor are out of scope', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 60 * 48 })
  assert.equal(unresolvedPnlSince(db, fxDayStartSql(), { graceMin: 15 }).count, 0)
})

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

test('unknown rows block; a clean day does not', () => {
  assert.equal(unknownPnlBlocks({ count: 0 }).block, false)
  const v = unknownPnlBlocks({ count: 2, oldestClosedAt: '2026-07-26 03:00:00' }, { graceMin: 15, scope: 'account' })
  assert.equal(v.block, true)
  assert.match(v.reason, /^unknown_daily_pnl \(account\): 2 closed trade\(s\)/)
  assert.match(v.reason, /15m/)
})

test('a failed lookup blocks too — not knowing is not the same as zero', () => {
  const v = unknownPnlBlocks({ count: -1 })
  assert.equal(v.block, true)
  assert.match(v.reason, /lookup failed/)
})

test('the knob can turn it off, and turning it off is the only way past it', () => {
  assert.equal(unknownPnlBlocks({ count: 5 }, { enabled: false }).block, false)
  assert.equal(unknownPnlBlocks({ count: 5 }, { enabled: true }).block, true)
})

test('the default grace is 15 minutes', () => {
  assert.equal(DEFAULT_UNKNOWN_PNL_GRACE_MIN, 15)
})

// ---------------------------------------------------------------------------
// The portfolio layer, end to end.
// ---------------------------------------------------------------------------

test('the portfolio cap now refuses to read an unknown day as flat', () => {
  const db = mkDb()
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 100, unknownPnlGraceMin: 1 }))
  closeTrade(db, { pnl: null, minutesAgo: safeMinutesAgo(60) })

  const r = evaluateGlobalGuards(db)
  assert.equal(r.ok, false, 'an unknown closure must not pass as a flat day')
  assert.match(r.reason, /^unknown_daily_pnl \(portfolio\)/)
  assert.equal(r.checks.portfolio_unresolved_pnl_trades, 1)
})

test('a resolved day still passes, and a real loss still trips the cap', () => {
  const db = mkDb()
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 100 }))
  closeTrade(db, { pnl: -20, minutesAgo: safeMinutesAgo(60) })
  assert.equal(evaluateGlobalGuards(db).ok, true)

  closeTrade(db, { pnl: -95, minutesAgo: safeMinutesAgo(30) })
  const r = evaluateGlobalGuards(db)
  assert.equal(r.ok, false)
  assert.match(r.reason, /^portfolio_daily_loss/)
})

test('with no portfolio cap configured the layer stays a no-op', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 60 })
  assert.equal(evaluateGlobalGuards(db).ok, true, 'unknown P&L only matters where a cap depends on it')
})

test('an unknown closure inside the grace window does not block yet', () => {
  const db = mkDb()
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 100 }))
  closeTrade(db, { pnl: null, minutesAgo: 2 })
  assert.equal(evaluateGlobalGuards(db).ok, true, 'the backfill must be given its turn')
})

test('the defaults ship blocking on, at 15 minutes', () => {
  assert.equal(DEFAULT_GLOBAL_GUARDS.blockOnUnknownPnl, true)
  assert.equal(DEFAULT_GLOBAL_GUARDS.unknownPnlGraceMin, 15)
})
