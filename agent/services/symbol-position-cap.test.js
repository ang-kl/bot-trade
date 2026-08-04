// node --test agent/services/symbol-position-cap.test.js
//
// The ceiling that would have stopped 04-08-2026: 17 × DOW.US SELL on
// 46130058, submitted inside 89 milliseconds, every one stopped out, −$1,615.
//
// The load-bearing test is `an 89-millisecond burst is stopped at the cap` —
// it counts IN-FLIGHT orders, because at the moment each of those seventeen
// was checked, none of them was a position yet. Every guard that reads only
// the reconciled book is outrun by exactly that.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  DEFAULT_MAX_PER_SYMBOL, IN_FLIGHT_STATUSES,
  countForSymbol, symbolCapVerdict, checkSymbolCap, overCapClusters, clusterLine,
} from './symbol-position-cap.js'

const ACCT = '46130058'

function openPos(db, symbol, account = ACCT, n = 1, openedAt = null) {
  // monitored_positions carries no timestamp of its own — opened_at lives on
  // the joined trades row, which is why the cluster report joins.
  const tr = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id, source)
    VALUES (?, 'SELL', 29.84, 250, 'open', COALESCE(?, datetime('now')), ?, 'autopilot')
  `)
  const ins = db.prepare(`
    INSERT INTO monitored_positions (symbol, side, status, account_id, trade_id)
    VALUES (?, 'short', 'active', ?, ?)
  `)
  for (let i = 0; i < n; i++) {
    const id = tr.run(symbol, openedAt, account).lastInsertRowid
    ins.run(symbol, account, id)
  }
}

function inFlight(db, symbol, account = ACCT, n = 1, status = 'submitting') {
  const ins = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id, source)
    VALUES (?, 'SELL', 29.84, 250, ?, datetime('now'), ?, 'autotrade')
  `)
  for (let i = 0; i < n; i++) ins.run(symbol, status, account)
}

// ---------------------------------------------------------------------------
// The owner's number
// ---------------------------------------------------------------------------

test('the ceiling is two, and it is a CEILING not a permission', () => {
  // Owner 05-08-2026: "maximum 2 positions hard cap". duplicate_symbol still
  // refuses the second on the normal path — this does not relax it. Anything
  // reaching here bypassed that gate.
  assert.equal(DEFAULT_MAX_PER_SYMBOL, 2)
  assert.equal(symbolCapVerdict({ symbol: 'DOW.US', count: 0 }).allow, true)
  assert.equal(symbolCapVerdict({ symbol: 'DOW.US', count: 1 }).allow, true)
  assert.equal(symbolCapVerdict({ symbol: 'DOW.US', count: 2 }).allow, false)
  assert.equal(symbolCapVerdict({ symbol: 'DOW.US', count: 17 }).allow, false)
})

test('THE 89-MILLISECOND BURST: in-flight orders count, or the cap is useless', () => {
  // At the moment each of the seventeen was checked, NONE of them was a
  // position yet — they were submitted and unreconciled. A cap that counts
  // only the reconciled book would have let all seventeen through exactly as
  // duplicate_symbol did.
  const db = initDB(':memory:')
  inFlight(db, 'DOW.US', ACCT, 2)
  const c = countForSymbol(db, ACCT, 'DOW.US')
  assert.equal(c.open, 0, 'nothing has reconciled yet')
  assert.equal(c.inFlight, 2)
  assert.equal(c.total, 2)
  const v = symbolCapVerdict({ symbol: 'DOW.US', accountId: ACCT, count: c })
  assert.equal(v.allow, false, 'the third order in the burst is refused')
  assert.match(v.reason, /symbol_position_cap DOW\.US=2\/2/)
  assert.match(v.reason, /2 submitted and unresolved/)
})

test('open and in-flight add up — they are both real exposure', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', ACCT, 1)
  inFlight(db, 'DOW.US', ACCT, 1)
  const c = countForSymbol(db, ACCT, 'DOW.US')
  assert.deepEqual({ ...c }, { total: 2, open: 1, inFlight: 1 })
  assert.equal(checkSymbolCap(db, { accountId: ACCT, symbol: 'DOW.US' }).allow, false)
})

test('both in-flight statuses count — an unconfirmed order may be live', () => {
  const db = initDB(':memory:')
  assert.deepEqual([...IN_FLIGHT_STATUSES], ['submitting', 'unconfirmed'])
  inFlight(db, 'DOW.US', ACCT, 1, 'submitting')
  inFlight(db, 'DOW.US', ACCT, 1, 'unconfirmed')
  assert.equal(countForSymbol(db, ACCT, 'DOW.US').total, 2)
})

test('a resolved order does NOT count — only live and in-flight do', () => {
  const db = initDB(':memory:')
  inFlight(db, 'DOW.US', ACCT, 1, 'closed')
  inFlight(db, 'DOW.US', ACCT, 1, 'rejected')
  assert.equal(countForSymbol(db, ACCT, 'DOW.US').total, 0, 'a dead order is not exposure')
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('the cap is PER ACCOUNT — one account\'s book cannot block another', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', '46130058', 2)
  assert.equal(checkSymbolCap(db, { accountId: '46130058', symbol: 'DOW.US' }).allow, false)
  assert.equal(checkSymbolCap(db, { accountId: '43097342', symbol: 'DOW.US' }).allow, true,
    'the other account placed one correctly-sized position and must still be able to')
})

test('the cap is PER SYMBOL', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', ACCT, 2)
  assert.equal(checkSymbolCap(db, { accountId: ACCT, symbol: 'EURUSD' }).allow, true)
})

test('an unattributed row counts for every account — stricter, never looser', () => {
  // The correct direction for a safety ceiling, and the same rule risk.js
  // uses for its scoped reads.
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', null, 2)
  assert.equal(checkSymbolCap(db, { accountId: ACCT, symbol: 'DOW.US' }).allow, false)
})

test('symbols are matched case-insensitively', () => {
  const db = initDB(':memory:')
  openPos(db, 'dow.us', ACCT, 2)
  assert.equal(checkSymbolCap(db, { accountId: ACCT, symbol: 'DOW.US' }).allow, false)
})

test('a custom cap is honoured; junk falls back to the default', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', ACCT, 3)
  assert.equal(checkSymbolCap(db, { accountId: ACCT, symbol: 'DOW.US', cap: 5 }).allow, true)
  assert.equal(symbolCapVerdict({ symbol: 'X', count: 2, cap: 0 }).cap, DEFAULT_MAX_PER_SYMBOL)
  assert.equal(symbolCapVerdict({ symbol: 'X', count: 2, cap: 'nonsense' }).cap, DEFAULT_MAX_PER_SYMBOL)
})

test('a database without the tables fails OPEN, not closed', () => {
  // A safety ceiling that threw would stop all trading on a schema gap. The
  // same fail-safe reasoning unresolved-pnl.js had to learn.
  const broken = { prepare() { throw new Error('no such table') } }
  assert.deepEqual(countForSymbol(broken, ACCT, 'DOW.US'), { total: 0, open: 0, inFlight: 0 })
  assert.equal(checkSymbolCap(broken, { accountId: ACCT, symbol: 'DOW.US' }).allow, true)
  assert.deepEqual(overCapClusters(broken), [])
})

// ---------------------------------------------------------------------------
// The detector — alert only (owner: "if exist now, alert only")
// ---------------------------------------------------------------------------

test('clusters already over the ceiling are REPORTED, and nothing is closed', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', ACCT, 17, '2026-08-04 15:33:17')   // the real event
  openPos(db, '0066.HK', '43097342', 9)                     // #179
  openPos(db, 'EURUSD', ACCT, 1)                            // fine

  const clusters = overCapClusters(db)
  assert.equal(clusters.length, 2)
  assert.equal(clusters[0].symbol, 'DOW.US')
  assert.equal(clusters[0].n, 17)
  assert.equal(clusters[0].over, 15)
  assert.ok(!clusters.some(c => c.symbol === 'EURUSD'), 'one position is not a cluster')

  // …and the rows are untouched. Auto-closing on a reading is a bigger action
  // than the one that created them.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM monitored_positions WHERE status='active'`).get().n, 27)
})

test('exactly AT the cap is not over it', () => {
  const db = initDB(':memory:')
  openPos(db, 'DOW.US', ACCT, 2)
  assert.deepEqual(overCapClusters(db), [])
})

test('the cluster line names symbol, count, account and cap', () => {
  const line = clusterLine({ symbol: 'DOW.US', accountId: ACCT, n: 17, cap: 2, over: 15, firstAt: '2026-08-04 15:33:17', lastAt: '2026-08-04 15:33:17' })
  assert.match(line, /DOW\.US × 17 on 46130058/)
  assert.match(line, /cap 2, 15 over/)
  assert.match(line, /opened 2026-08-04 15:33:17/)
})
