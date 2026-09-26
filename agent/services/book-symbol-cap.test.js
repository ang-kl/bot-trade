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
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { resolveInflightTrades } from './stuck-resolver.js'
import {
  checkBookSymbolCap, accountsHolding, normalizeSide,
  DEFAULT_MAX_ACCOUNTS_PER_SYMBOL,
} from './book-symbol-cap.js'

// C8 (SEQUENCE PR-8, 26-09-2026). These fixtures used to be hand-made
// CREATE TABLEs that gave monitored_positions and trades a `direction` column.
// The real schema (agent/db.js) has no such column: both tables store `side`.
// So the production queries threw into their empty catches and the ceiling
// counted positions for no one, while every test here stayed green against a
// schema that does not exist — failure mode #3 in the guard built to fix #3.
// The fixtures now run on initDB(':memory:'), the schema production runs, and
// rows are written the way reconciler.js and the order path write them
// (`side` 'BUY'/'SELL'; pending_orders `dir` 1/−1 plus the migrated
// `account_id`).
function db () {
  return initDB(':memory:')
}
const pos = (d, acct, sym, side, status = 'active') =>
  d.prepare('INSERT INTO monitored_positions (account_id, status, symbol, side) VALUES (?,?,?,?)').run(acct, status, sym, side)
// trades.status has a CHECK; 'filled' is not one of its values, so the
// "never counts" case below uses the real terminal statuses instead.
const trd = (d, acct, sym, side, status = 'submitting') =>
  d.prepare('INSERT INTO trades (account_id, status, symbol, side) VALUES (?,?,?,?)').run(acct, status, sym, side)
const pend = (d, acct, sym, dir, status = 'working') =>
  d.prepare('INSERT INTO pending_orders (account_id, status, symbol, dir) VALUES (?,?,?,?)').run(acct, status, sym, dir)

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

// --- C8: the defect, on the real schema -----------------------------------

test('C8: a held position and an in-flight order on the REAL schema both count, and the third account is refused', () => {
  // Red on origin/main before C8: accountsHolding returned [] here because
  // both queries read `direction` and threw into their empty catches.
  const d = db()
  pos(d, 'A', 'NATGAS', 'BUY')       // as reconciler.js adopts it: side 'BUY'
  trd(d, 'B', 'NATGAS', 'BUY')       // write-ahead intent, status 'submitting'
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }).sort(), ['A', 'B'])
  const r = checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C', cap: 2 })
  assert.equal(r.allow, false)
  assert.match(r.reason, /^book_symbol_cap: 2 account\(s\) already hold NATGAS BUY/)
})

test('C8: the columns the ceiling reads exist in agent/db.js, and `direction` does not', () => {
  // Pins WHY the fix is `side`: if a migration ever adds `direction` or drops
  // `side`, this names the mismatch instead of the empty catch hiding it.
  const d = db()
  const cols = (t) => new Set(d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name))
  for (const t of ['monitored_positions', 'trades']) {
    const c = cols(t)
    for (const need of ['account_id', 'status', 'symbol', 'side']) assert.ok(c.has(need), `${t}.${need} must exist`)
    assert.ok(!c.has('direction'), `${t} has no direction column — the query must not read one`)
  }
  const p = cols('pending_orders')
  for (const need of ['account_id', 'status', 'symbol', 'dir']) assert.ok(p.has(need), `pending_orders.${need} must exist`)
})

// --- each source must actually contribute ----------------------------------
// A silent schema mismatch shows up here and nowhere else.

test('SCHEMA: an in-flight trade counts (trades.side, status submitting)', () => {
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
  trd(d, 'B', 'NATGAS', 'BUY', 'closed')
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

// --- C8 fix round 2: rows the stuck resolver ENDED stop holding -------------
// V3 I3 keeps an ended in-flight row's status 'submitting' / 'unconfirmed' for
// ever (the trades CHECK has no honest terminal value); `stuck_resolutions`
// is what makes it terminal, and every exposure reader reads through
// inflightLiveSql. These run the REAL resolver on the REAL schema.
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const stuckTrade = (d, acct, sym, side, status, openedMs, extra = {}) =>
  d.prepare(`INSERT INTO trades (account_id, status, symbol, side, opened_at, origin, ctrader_position_id) VALUES (?,?,?,?,?,?,?)`)
    .run(acct, status, sym, side, sqlTs(openedMs), extra.origin ?? null, extra.positionId ?? null).lastInsertRowid

test('C8 fix round 2: two in-flight rows the resolver WROTE OFF (no broker evidence, six days old) stop holding — the FIRST real holder is admitted', () => {
  const d = db()
  const now = Date.now()
  stuckTrade(d, 'A', 'NATGAS', 'BUY', 'unconfirmed', now - 6 * 86_400_000)
  stuckTrade(d, 'B', 'NATGAS', 'BUY', 'submitting', now - 6 * 86_400_000)
  // unresolved, an in-flight row IS possible exposure: the conservative reading stands
  assert.equal(checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C', cap: 2 }).allow, false)
  const r = resolveInflightTrades(d, { nowMs: now })
  assert.equal(r.writtenOff, 2, JSON.stringify(r))
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM stuck_resolutions WHERE kind = 'trade_inflight' AND outcome = 'unresolved'`).get().n, 2)
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM trades WHERE status IN ('submitting', 'unconfirmed')`).get().n, 2, 'the rows keep their status (never deleted, never rewritten)')
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }), [], 'RED without inflightLiveSql: [B, A]')
  const c = checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C', cap: 2 })
  assert.equal(c.allow, true, c.reason)
})

test('C8 fix round 2: an in-flight row the resolver settled as the DUPLICATE of an adopted row (R5) stops holding — the SECOND real holder is admitted', () => {
  const d = db()
  const now = Date.now()
  const t0 = now - 2 * 86_400_000
  // A's submission never promoted; the reconciler adopted the same fill 30 s later (since closed)
  stuckTrade(d, 'A', 'NATGAS', 'BUY', 'submitting', t0)
  const twin = stuckTrade(d, 'A', 'NATGAS', 'BUY', 'closed', t0 + 30_000, { origin: 'reconciler_adopted', positionId: '9001' })
  pos(d, 'B', 'NATGAS', 'BUY') // B holds for real
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }).sort(), ['A', 'B'], 'the unresolved duplicate still counts')
  const r = resolveInflightTrades(d, { nowMs: now })
  assert.equal(r.settledDuplicate, 1, JSON.stringify(r))
  assert.match(d.prepare(`SELECT verdict FROM stuck_resolutions WHERE kind = 'trade_inflight'`).get().verdict, new RegExp(`duplicate of trade #${twin}`))
  assert.deepEqual(accountsHolding(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C' }), ['B'], 'RED without inflightLiveSql: [A, B]')
  const c = checkBookSymbolCap(d, { symbol: 'NATGAS', direction: 'BUY', accountId: 'C', cap: 2 })
  assert.equal(c.allow, true, c.reason)
})
