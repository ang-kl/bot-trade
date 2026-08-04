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

// ---------------------------------------------------------------------------
// OBSERVABILITY (2026-07-30). The veto's REACH is deliberately unchanged — the
// owner's brief forbids weakening it — but a desk it stops must now say which
// data stopped it. One orphan row halting seven accounts with no on-screen
// reason is what produced "I don't see any trades".
// ---------------------------------------------------------------------------

test('unattributed rows are counted separately', () => {
  const db = mkDb()
  db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, opened_at, closed_at, status, net_pnl, account_id)
     VALUES ('EURUSD','BUY',1.1,0.02,datetime('now','-1 day'),datetime('now','-60 minutes'),'closed',NULL,NULL)`
  ).run()
  closeTrade(db, { pnl: null, accountId: '111', minutesAgo: 60 })
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111' })
  assert.equal(r.count, 2, 'both the orphan and the account row block')
  assert.equal(r.unattributedCount, 1, 'and the orphan is identified')
})

test('a fully attributed blocker reports zero orphans', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, accountId: '111', minutesAgo: 60 })
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111' }).unattributedCount, 0)
})

test('the reason names the orphan rows and what to do about them', () => {
  const v = unknownPnlBlocks({ count: 3, unattributedCount: 1, oldestClosedAt: '2026-07-30 02:00:00' }, { scope: 'account' })
  assert.equal(v.block, true)
  assert.match(v.reason, /1 of them have NO account_id/)
  assert.match(v.reason, /why every account is affected/)
  assert.match(v.reason, /attribute or backfill/)
})

test('with no orphans the reason stays clean — no confusing clause', () => {
  const v = unknownPnlBlocks({ count: 2, unattributedCount: 0 }, { scope: 'account' })
  assert.ok(!/account_id/.test(v.reason))
})

test('a failed lookup still blocks and reports no orphan count', () => {
  const r = unresolvedPnlSince({ prepare() { throw new Error('no such table') } }, EPOCH_ANCHOR, { accountId: '111' })
  assert.equal(r.count, -1)
  assert.equal(r.unattributedCount, 0)
  assert.equal(unknownPnlBlocks(r).block, true)
})

// AGE-OUT (owner, 03-08-2026: "make unresolvable rows age out instead of
// blocking forever"). In production `unknown_daily_pnl` was 32,115 of 46,380
// vetoes in seven days — 69% of everything — off closed trades the backfill
// never filled. The grace window has no upper bound, so those blocked with no
// path back.
//
// The claims that matter: the age-out RELEASES, it does not release too early,
// it is off when unset, and a released desk SAYS what it stopped waiting for.

/** Two unfilled closes: one 20 min old (inside the age line), one 8h old. */
function agedDb() {
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 20 })
  closeTrade(db, { pnl: null, minutesAgo: 8 * 60 })
  return db
}

test('age-out: a row past the age line stops blocking, one inside it does not', () => {
  const r = unresolvedPnlSince(agedDb(), EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360 })
  assert.equal(r.count, 1, 'only the 20-minute row should still block')
  assert.equal(r.agedOutCount, 1)
  assert.equal(r.agedOutAfterMin, 360)
  assert.ok(r.agedOutOldest)
})

test('age-out OFF (null / 0 / junk) is the old behaviour, to the row', () => {
  // `undefined` is NOT in this list on purpose: omitting the option means
  // "use the default", and the default is ON. Only an explicit off-value
  // restores block-until-resolved.
  for (const maxAgeMin of [null, 0, NaN, 'later']) {
    const r = unresolvedPnlSince(agedDb(), EPOCH_ANCHOR, { graceMin: 15, maxAgeMin })
    assert.equal(r.count, 2, `maxAgeMin=${maxAgeMin} must block both`)
    assert.equal(r.agedOutCount, 0)
  }
})

test('an age line at or below the grace window is refused, not silently inverted', () => {
  // maxAge <= grace would age a row out before it had even started blocking.
  const r = unresolvedPnlSince(agedDb(), EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 10 })
  assert.equal(r.count, 2)
  assert.equal(r.agedOutCount, 0)
})

test('once everything has aged out the gate opens — and says why', () => {
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 8 * 60 })
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360 })
  assert.equal(r.count, 0)
  const v = unknownPnlBlocks(r, { graceMin: 15 })
  assert.equal(v.block, false)
  // THE POINT: resuming is never silent about what it stopped waiting for.
  assert.match(v.note, /stopped blocking on AGE alone after 360m/)
  assert.match(v.note, /incomplete by an unknown amount/)
})

test('aged-out and written-off are reported as SEPARATE facts', () => {
  const v = unknownPnlBlocks(
    { count: 0, unresolvableCount: 2, agedOutCount: 1, agedOutAfterMin: 360 },
    { graceMin: 15 },
  )
  assert.match(v.note, /marked unresolvable/)
  assert.match(v.note, /AGE alone/)
  // The weaker claim must not borrow the stronger one's certainty.
  assert.ok(v.note.indexOf('unresolvable') < v.note.indexOf('AGE alone'))
})

test('a still-blocking row keeps blocking even when others aged out', () => {
  const v = unknownPnlBlocks(
    { count: 1, oldestClosedAt: '2026-08-03 10:00:00', agedOutCount: 3, agedOutAfterMin: 360 },
    { graceMin: 15 },
  )
  assert.equal(v.block, true)
  assert.match(v.reason, /unknown_daily_pnl/)
  assert.match(v.note, /AGE alone/)
})

test('the account scope still binds correctly with the age clause in the middle', () => {
  // Positional params: the age-out clause sits BETWEEN grace and account, so a
  // miscount would bind the account id to a date. Two accounts, one unfilled
  // row each; scoping to one must see exactly one.
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 20, accountId: '111' })
  closeTrade(db, { pnl: null, minutesAgo: 20, accountId: '222' })
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111', graceMin: 15, maxAgeMin: 360 })
  assert.equal(r.count, 1)
})

// ---------------------------------------------------------------------------
// EXHAUSTED — tried and never filled (owner, 04-08-2026)
//
// The age-out fixed "blocks forever". It did not fix "blocks six hours a day,
// every day". Production on that date: three rows on account 46130058 at
// pnl_attempts = 8, one of them still inside the age window and therefore
// still holding every entry on the account. Eight failed attempts is better
// evidence than a clock, and it was already being recorded.
// ---------------------------------------------------------------------------

const withAttempts = (db, id, n) =>
  db.prepare('UPDATE trades SET pnl_attempts = ? WHERE id = ?').run(n, id)

test('a row tried past the threshold stops blocking WITHOUT waiting out the age window', () => {
  const db = mkDb()
  const id = closeTrade(db, { pnl: null, minutesAgo: 30 })   // inside the 360m age-out
  assert.equal(unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360 }).count, 1)

  withAttempts(db, id, 8)
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.equal(r.count, 0, 'eight failed attempts is evidence; the clock is not needed')
  assert.equal(r.exhaustedCount, 1)
  assert.equal(r.exhaustedAttempts, 8)
})

test('below the threshold it still blocks — attempts are evidence, not an excuse', () => {
  const db = mkDb()
  const id = closeTrade(db, { pnl: null, minutesAgo: 30 })
  withAttempts(db, id, 5)
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.equal(r.count, 1)
  assert.equal(r.exhaustedCount, 0)
})

test('minAttempts 0/null restores pure time-based behaviour', () => {
  const db = mkDb()
  const id = closeTrade(db, { pnl: null, minutesAgo: 30 })
  withAttempts(db, id, 99)
  // `undefined` is deliberately absent: it means "argument omitted", so the
  // default (6) applies. Only an explicit 0/null/junk turns the check off.
  for (const minAttempts of [0, null, 'nonsense']) {
    const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360, minAttempts })
    assert.equal(r.count, 1, `minAttempts=${minAttempts} must not release anything`)
  }
})

test('a row STILL INSIDE THE GRACE WINDOW is not released by attempts either', () => {
  // The grace window exists because a fresh close is expected to sit NULL for a
  // cycle or two. A row that has not yet started blocking cannot stop blocking.
  const db = mkDb()
  const id = closeTrade(db, { pnl: null, minutesAgo: 2 })
  withAttempts(db, id, 20)
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.equal(r.count, 0, 'inside grace: not blocking')
  assert.equal(r.exhaustedCount, 0, '…and not counted as released, because it was never held')
})

test('the account scope still binds with BOTH the age and attempt clauses in the middle', () => {
  // Positional params again: attempts sits between age and account. A miscount
  // binds the account id to a number and the query silently returns nothing —
  // which this module reads as "nothing is blocking".
  const db = mkDb()
  closeTrade(db, { pnl: null, minutesAgo: 20, accountId: '111' })
  closeTrade(db, { pnl: null, minutesAgo: 20, accountId: '222' })
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { accountId: '111', graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.equal(r.count, 1)
})

test('the release is NAMED, and does not borrow the write-off\'s certainty', () => {
  const v = unknownPnlBlocks(
    { count: 0, exhaustedCount: 2, exhaustedAttempts: 8, exhaustedAfterAttempts: 6, agedOutCount: 1, agedOutAfterMin: 360 },
    { graceMin: 15 },
  )
  assert.match(v.note, /failed backfill attempts/)
  assert.match(v.note, /up to 8 on one row/)
  assert.match(v.note, /AGE alone/)
  assert.ok(!/marked unresolvable/.test(v.note), 'never claims the broker said anything')
})

test('a written-off row is not double-counted as exhausted', () => {
  const db = mkDb()
  const id = closeTrade(db, { pnl: null, minutesAgo: 30 })
  withAttempts(db, id, 9)
  db.prepare('UPDATE trades SET pnl_unresolvable = 1 WHERE id = ?').run(id)
  const r = unresolvedPnlSince(db, EPOCH_ANCHOR, { graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.equal(r.exhaustedCount, 0, 'it is already written off; that is the stronger statement')
  assert.equal(r.unresolvableCount, 1)
})
