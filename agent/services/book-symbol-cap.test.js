// PR-AQ — the book-wide symbol ceiling.
//
// THE TESTS THAT MATTER MOST here are the schema ones. Every read in
// book-symbol-cap.js sits in a try/catch so an older database cannot crash the
// risk gate — which means a WRONG COLUMN NAME fails silently and leaves the
// ceiling permanently open while every count reads zero. That is CLAUDE.md
// failure mode #3 in the guard built to fix failure mode #3. The first cut of
// the resting-order query did exactly this: it read a `side` column that
// `pending_orders` does not have (it stores `dir` INTEGER, 1/−1).
//
// So the tables below are created with the REAL column names and the real
// direction encodings, and each source is asserted to actually contribute.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import {
  checkBookSymbolCap, accountsHolding, normalizeSide,
  DEFAULT_MAX_ACCOUNTS_PER_SYMBOL,
} from './book-symbol-cap.js'

function db () {
  const d = new Database(':memory:')
  // Column names and types mirror agent/db.js: monitored_positions.direction
  // and trades.direction are TEXT; pending_orders carries `dir` INTEGER and an
  // `account_id` added by migration.
  d.exec(`
    CREATE TABLE monitored_positions (account_id TEXT, status TEXT, symbol TEXT, direction TEXT);
    CREATE TABLE trades            (account_id TEXT, status TEXT, symbol TEXT, direction TEXT);
    CREATE TABLE pending_orders    (account_id TEXT, status TEXT, symbol TEXT, dir INTEGER);
  `)
  return d
}
const pos = (d, acct, sym, dir, status = 'active') =>
  d.prepare('INSERT INTO monitored_positions VALUES (?,?,?,?)').run(acct, status, sym, dir)
const trd = (d, acct, sym, dir, status = 'submitting') =>
  d.prepare('INSERT INTO trades VALUES (?,?,?,?)').run(acct, status, sym, dir)
const pend = (d, acct, sym, dir, status = 'working') =>
  d.prepare('INSERT INTO pending_orders VALUES (?,?,?,?)').run(acct, status, sym, dir)

test('normalizeSide folds both vocabularies, and refuses anything else', () => {
  assert.equal(normalizeSide('buy'), 'BUY')
  assert.equal(normalizeSide('LONG'), 'BUY')
  assert.equal(normalizeSide('Sell'), 'SELL')
  assert.equal(normalizeSide('short'), 'SELL')
  assert.equal(normalizeSide('sideways'), null)
  assert.equal(normalizeSide(null), null)
})

test('THE MEASURED CASE: four accounts long NATGAS, the fourth is refused at cap 2', () => {
  const d = db()
  pos(d, '46130058', 'NATGAS', 'BUY')
  pos(d, '43097342', 'NATGAS', 'BUY')
  pos(d, '46979908', 'NATGAS', 'BUY')
  const r = checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: '47790949', cap: 2 })
  assert.equal(r.allow, false)
  assert.equal(r.others.length, 3)
  assert.match(r.reason, /book_symbol_cap: 3 account\(s\) already hold NATGAS BUY/)
})

test('the SECOND account in is allowed at cap 2 — this is a ceiling, not a monopoly', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY')
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'B', cap: 2 }).allow, true)
})

test('the opposite direction is NOT blocked — two accounts on opposite sides is net-flat at the book', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'B', 'NATGAS', 'BUY')
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C', cap: 2 }).allow, false)
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'SELL', accountId: 'C', cap: 2 }).allow, true)
})

test("the account's OWN holdings never count — that is the per-account ceiling's job", () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'A', 'NATGAS', 'BUY')
  const r = checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'A', cap: 2 })
  assert.equal(r.allow, true, 'double-charging A here would make the two ceilings fight')
  assert.deepEqual(r.others, [])
})

// --- each source must actually contribute ----------------------------------
// A silent schema mismatch shows up here and nowhere else.

test('SCHEMA: an in-flight trade counts (trades.direction, status submitting)', () => {
  const d = db()
  trd(d, 'A', 'NATGAS', 'BUY'); trd(d, 'B', 'NATGAS', 'LONG', 'unconfirmed')
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }).sort(), ['A', 'B'])
})

test('SCHEMA: a resting limit counts, read from `dir` INTEGER and not a `side` column', () => {
  const d = db()
  pend(d, 'A', 'NATGAS', 1)      // 1 = BUY, per closed-market-limits.js
  pend(d, 'B', 'NATGAS', -1)     // −1 = SELL
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }), ['A'])
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'SELL', accountId: 'C' }), ['B'])
})

test('SCHEMA: an active position counts under either direction vocabulary', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'LONG'); pos(d, 'B', 'NATGAS', 'BUY')
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'LONG', accountId: 'C' }).sort(), ['A', 'B'])
})

test('closed, filled and cancelled rows never count — a concurrency limit, not a quota', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY', 'closed')
  trd(d, 'B', 'NATGAS', 'BUY', 'filled')
  pend(d, 'C', 'NATGAS', 1, 'cancelled')
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'Z' }), [],
    'a symbol traded twenty times last week, all closed, must be at zero')
})

test('one account counted once however many rows it holds across all three sources', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); trd(d, 'A', 'NATGAS', 'BUY'); pend(d, 'A', 'NATGAS', 1)
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'Z' }), ['A'])
})

test('symbols do not bleed into each other, and matching is case-insensitive', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'B', 'TSLA.US', 'BUY')
  assert.deepEqual(accountsHolding(d, { symbol: 'natgas', direction: 'buy', accountId: 'Z' }), ['A'])
})

test('a NULL-account row counts, under one synthetic id', () => {
  const d = db()
  pos(d, null, 'NATGAS', 'BUY'); pos(d, null, 'NATGAS', 'BUY')
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'Z' }), ['(unassigned)'],
    'legacy rows are real exposure, but two of them are not two accounts')
})

test('a cap of 0 DISABLES the ceiling rather than halting all trading', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'B', 'NATGAS', 'BUY'); pos(d, 'C', 'NATGAS', 'BUY')
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'D', cap: 0 }).allow, true)
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'D', cap: -1 }).allow, true)
})

test('an unreadable direction never blocks — the gate must not refuse what it cannot judge', () => {
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY'); pos(d, 'B', 'NATGAS', 'BUY')
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'sideways', accountId: 'C', cap: 2 }).allow, true)
})

test('the default is 2, and is a small number', () => {
  assert.equal(DEFAULT_MAX_ACCOUNTS_PER_SYMBOL, 2)
  assert.ok(DEFAULT_MAX_ACCOUNTS_PER_SYMBOL >= 1 && DEFAULT_MAX_ACCOUNTS_PER_SYMBOL <= 3,
    'the measured data argues for 1; above 3 the ceiling stops biting at all on a 4-5 account book')
})

// THE CALL SITE IS PINNED. A ceiling nothing consults is the repair that
// nothing calls (failure mode #4) — and this one is invisible from this
// module, so a refactor drops it in silence.
test('risk.js consults the book ceiling, and both ceilings must pass', () => {
  const src = readFileSync(new URL('./risk.js', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')      // strip comments: no passing by matching prose
  assert.match(src, /checkBookSymbolCap\(db,\s*\{/, 'the book ceiling must be called in the risk gate')
  assert.match(src, /if\s*\(!book\.allow\)\s*return veto\(/, 'a refusal must veto, not merely be recorded')
  assert.match(src, /if\s*\(!cap\.allow\)\s*return veto\(/, 'the PER-ACCOUNT ceiling stays: this one does not replace it')
  assert.match(src, /maxAccountsPerSymbol/, 'the cap must be configurable, not a constant in the gate')
})
