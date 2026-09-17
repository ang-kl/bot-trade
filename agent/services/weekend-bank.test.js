// node --test agent/services/weekend-bank.test.js
//
// Weekend bank: the pre-closure profit sweep. Pure decision + the
// closure-window math it depends on (nextCloseInfo).

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { shouldBank } from './weekend-bank.js'
import { nextCloseInfo } from './symbol-hours.js'

const H = 3600

test('shouldBank: profit inside the window before a long closure → true', () => {
  const base = { open: true, closesInSec: 30 * 60, closureSec: 49 * H, side: 'BUY', entry: 2.87, price: 2.905 }
  assert.equal(shouldBank(base), true)
  // SELL in profit (price below entry)
  assert.equal(shouldBank({ ...base, side: 'SELL', entry: 2.905, price: 2.87 }), true)
})

test('shouldBank: refuses losers, short closures, early hours, missing data', () => {
  const base = { open: true, closesInSec: 30 * 60, closureSec: 49 * H, side: 'BUY', entry: 2.87, price: 2.905 }
  assert.equal(shouldBank({ ...base, price: 2.80 }), false, 'losing position is left alone')
  assert.equal(shouldBank({ ...base, closureSec: 2 * H }), false, 'overnight break is not a weekend')
  assert.equal(shouldBank({ ...base, closesInSec: 5 * H }), false, 'hours before the close — too early')
  assert.equal(shouldBank({ ...base, open: false }), false)
  assert.equal(shouldBank({ ...base, price: null }), false)
  assert.equal(shouldBank({ ...base, closureSec: null }), false, 'unknown schedule never banks')
})

test('nextCloseInfo: Friday pre-close reads closes_in + weekend closure length', () => {
  const db = initDB(':memory:')
  // FX-style week in UTC: Sun 21:00 → Fri 21:00 as one interval.
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('EURUSD', ?, 'UTC')`)
    .run(JSON.stringify([{ start: 21 * H, end: (5 * 24 + 21) * H }]))
  // Friday 20:30 UTC = 30 min before the close.
  const fri2030 = new Date(Date.UTC(2026, 6, 17, 20, 30, 0)) // 2026-07-17 is a Friday
  const info = nextCloseInfo(db, 'EURUSD', fri2030)
  assert.equal(info.open, true)
  assert.equal(info.closes_in_sec, 30 * 60)
  assert.equal(info.closure_sec, 48 * H) // Fri 21:00 → Sun 21:00
  // Tuesday mid-session: open, but the close is days away.
  const tue = new Date(Date.UTC(2026, 6, 14, 12, 0, 0))
  assert.ok(nextCloseInfo(db, 'EURUSD', tue).closes_in_sec > 24 * H)
  // Unknown symbol → nulls, never actionable.
  assert.equal(nextCloseInfo(db, 'MYSTERY', fri2030).closes_in_sec, null)
})

// ---------------------------------------------------------------------------
// Gap-prone list (owner, 2026-08-16: "gap-prone list only")
//
// The profit-only rule above leaves a LOSING position exposed to the reopen
// gap, on the stated reasoning that selling into a thin pre-close market locks
// the loss at bad prices. Production disagreed: JPYX -7.93R, US30 -2.68R,
// GER40 -1.50R, all "stopped beyond the SL — gap/slippage through the stop".
// A gap jumps over the stop, so no stop placement helps; only being flat does.
// For listed symbols the sign test is dropped. For everything else it is not.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { initDB as initDB2, setState as setState2 } from '../db.js'
import { isGapProne, loadGapProneConfig, DEFAULT_GAP_PRONE } from './weekend-bank.js'

const LOSER = { open: true, closesInSec: 30 * 60, closureSec: 49 * H, side: 'BUY', entry: 2.87, price: 2.80 }

test('gap-prone: a LOSING position is flattened; the same loser off-list is not', () => {
  assert.equal(shouldBank({ ...LOSER, gapProne: true }), true, 'listed → flatten either way')
  assert.equal(shouldBank({ ...LOSER, gapProne: false }), false, 'unlisted → unchanged, left alone')
  // And a winner still banks on both paths — the extension adds a case, it
  // does not replace the existing one.
  const WINNER = { ...LOSER, price: 2.905 }
  assert.equal(shouldBank({ ...WINNER, gapProne: true }), true)
  assert.equal(shouldBank({ ...WINNER, gapProne: false }), true)
})

test('gap-prone drops ONLY the profit test — window and closure still bind', () => {
  // Otherwise this would fire on every ordinary overnight break, closing
  // every listed position daily. The blast radius is the whole point.
  assert.equal(shouldBank({ ...LOSER, gapProne: true, closureSec: 2 * H }), false, 'overnight break is not a closure')
  assert.equal(shouldBank({ ...LOSER, gapProne: true, closesInSec: 5 * H }), false, 'hours early — outside the window')
  assert.equal(shouldBank({ ...LOSER, gapProne: true, open: false }), false)
  assert.equal(shouldBank({ ...LOSER, gapProne: true, closureSec: null }), false, 'unknown schedule never acts')
  assert.equal(shouldBank({ ...LOSER, gapProne: true, price: null }), false)
})

test('the list is exact — no prefix or substring matching', () => {
  // 'US30' must not drag in 'US300', and 'USDX' must not match 'USDXYZ'.
  // A list that quietly grows changes risk behaviour with nobody deciding to.
  const cfg = loadGapProneConfig(initDB2(':memory:'))
  assert.equal(isGapProne('US30', cfg), true)
  assert.equal(isGapProne('us30', cfg), true, 'case-insensitive')
  assert.equal(isGapProne('US300', cfg), false)
  assert.equal(isGapProne('EURUSD', cfg), false, 'FX majors keep running')
  assert.equal(isGapProne('BTCUSD', cfg), false, 'crypto has no cash-market closure')
  assert.equal(isGapProne('', cfg), false)
  assert.equal(isGapProne(null, cfg), false)
})

test('the three measured offenders are on the list by default', () => {
  // Named individually: if someone trims the list, the symbols that actually
  // cost more than 1R are the ones a test should notice leaving.
  for (const s of ['JPYX', 'GER40', 'US30']) {
    assert.ok(DEFAULT_GAP_PRONE.includes(s), `${s} lost >1R to a gap and must stay listed`)
  }
})

test('the list is configurable, and a corrupt config falls back to defaults', () => {
  const db = initDB2(':memory:')
  setState2(db, 'weekend_bank_gap_json', JSON.stringify({ symbols: ['XAUUSD'] }))
  const cfg = loadGapProneConfig(db)
  assert.equal(isGapProne('XAUUSD', cfg), true)
  assert.equal(isGapProne('US30', cfg), false, 'an explicit list REPLACES the default')

  setState2(db, 'weekend_bank_gap_json', '{not json')
  const repaired = loadGapProneConfig(db)
  assert.equal(isGapProne('US30', repaired), true, 'corrupt → defaults, not an empty list')
})

test('turning the extension off restores the profit-only rule exactly', () => {
  const db = initDB2(':memory:')
  setState2(db, 'weekend_bank_gap_json', JSON.stringify({ on: false }))
  const cfg = loadGapProneConfig(db)
  assert.equal(isGapProne('US30', cfg), false)
  assert.equal(shouldBank({ ...LOSER, gapProne: isGapProne('US30', cfg) }), false)
})

// ---------------------------------------------------------------------------
// Momentum-book exemption (owner, 2026-09-07: "exempt the book from the
// weekend bank, build it")
//
// The bank swept book rows every US pre-close (GD.US twice on 04-09, JPM.US
// on 05-09 for +$3.76, re-bought 3.43 higher four minutes later). The book's
// trailed stop is the exit, across closures too. A position an OPEN book row
// points at is skipped; everything else banks exactly as before.
// ---------------------------------------------------------------------------

import { runWeekendBank, bookHeldPositionIds, bookExemptOn } from './weekend-bank.js'

const FRI_2030 = new Date(Date.UTC(2026, 6, 17, 20, 30, 0)) // 30 min before an FX-style Friday close

function bankDb() {
  const db = initDB2(':memory:')
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('GD.US', ?, 'UTC')`)
    .run(JSON.stringify([{ start: 21 * H, end: (5 * 24 + 21) * H }]))
  return db
}

function bookRow(db, accountId, positionId, status = 'open') {
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status)
              VALUES (NULL, ?, 'GD.US', ?, 'long', 362.43, 345.46, 5.6, 1, '2026-07-16T13:33:00Z', ?)`).run(String(accountId), String(positionId), status)
}

function fakeDeps(closed) {
  return {
    closePosition: async (_creds, { positionId }) => { closed.push(positionId) },
    wsGetSpotOnce: async () => ({ bid: 370, ask: 370.1 }), // in profit vs entry 362.43
  }
}

const POS = (positionId) => ({ positionId, symbolName: 'GD.US', price: 362.43, tradeData: { symbolId: 1, tradeSide: 1, volume: 100 } })
const CREDS = { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '43097342' }

test('book exemption: a book-held winner is left alone, the same winner off the book is banked', async () => {
  const db = bankDb()
  bookRow(db, CREDS.accountId, 111)
  const closed = []
  const r = await runWeekendBank(db, CREDS, [POS(111), POS(222)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [222], 'only the non-book position is closed')
  assert.deepEqual(r.exempt, [{ symbol: 'GD.US', positionId: 111 }], 'the skip is recorded with its reason')
  assert.equal(r.banked.length, 1)
  assert.equal(r.banked[0].positionId, 222)
})

test('book exemption: exit_sent counts as held; a CLOSED row does not', async () => {
  const db = bankDb()
  bookRow(db, CREDS.accountId, 333, 'exit_sent')
  bookRow(db, CREDS.accountId, 444, 'closed')
  const closed = []
  await runWeekendBank(db, CREDS, [POS(333), POS(444)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [444], 'a row the book already released is bankable again')
})

test('book exemption is per account — another account\'s book row does not shield this position', async () => {
  const db = bankDb()
  bookRow(db, '46130058', 555)
  const closed = []
  await runWeekendBank(db, CREDS, [POS(555)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [555])
  assert.equal(bookHeldPositionIds(db, '46130058').has('555'), true)
  assert.equal(bookHeldPositionIds(db, CREDS.accountId).has('555'), false)
})

test('book exemption toggle off restores the sweep over book rows exactly', async () => {
  const db = bankDb()
  bookRow(db, CREDS.accountId, 666)
  setState2(db, 'weekend_bank_book_exempt', 'false')
  assert.equal(bookExemptOn(db), false)
  const closed = []
  const r = await runWeekendBank(db, CREDS, [POS(666)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [666])
  assert.deepEqual(r.exempt, [])
})

test('book exemption: the loop says why a winner was not banked', () => {
  // The line is the read-back: without it a book position in profit at the
  // close looks like a bank that failed silently.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(src, /wb\.exempt\?\.length\) log\(/)
  assert.match(src, /book rows are exempt from the sweep/)
})

// ---------------------------------------------------------------------------
// THE NULL-position_id HOLE (16-09-2026, review) — the test that could not
// exist while the rule was a local query.
//
// `momentum_book.position_id` is written once at insert and is NULL for the
// resting-limit-then-fill path the book uses at closed markets. Nothing
// backfills it. The local `bookHeldPositionIds` filtered `IS NOT NULL`, so
// that row was not in the held set and this sweep would have CLOSED a momentum
// runner ahead of a weekend — against the book's whole premise that the trail
// is the exit. It stayed invisible because the exemption visibly works on every
// row that DOES carry a position id.
// ---------------------------------------------------------------------------

/** A book row from the resting-limit path: a trade, but no position id yet. */
function bookRowNoPositionId(db, accountId, tradeId, symbol = 'GD.US', status = 'open') {
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status)
              VALUES (?, ?, ?, NULL, 'long', 362.43, 345.46, 5.6, 1, '2026-07-16T13:33:00Z', ?)`)
    .run(tradeId, String(accountId), symbol, status)
}

/** The trade the book opened, carrying the broker position id the book lacks. */
function tradeFor(db, accountId, positionId, symbol = 'GD.US') {
  return db.prepare('INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)')
    .run(symbol, 'long', 'open', String(accountId), String(positionId)).lastInsertRowid
}

test('THE HOLE: a book row with a NULL position_id is exempt from the weekend bank', async () => {
  const db = bankDb()
  const tid = tradeFor(db, CREDS.accountId, 777)
  bookRowNoPositionId(db, CREDS.accountId, tid)
  const closed = []
  const r = await runWeekendBank(db, CREDS, [POS(777)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [], 'a momentum runner must not be banked ahead of a weekend')
  assert.deepEqual(r.exempt, [{ symbol: 'GD.US', positionId: 777 }], 'and the skip is recorded with its reason')
})

test('the NULL-position_id exemption is per account too', async () => {
  const db = bankDb()
  const tid = tradeFor(db, '46130058', 888)
  bookRowNoPositionId(db, '46130058', tid)
  const closed = []
  await runWeekendBank(db, CREDS, [POS(888)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [888], "another account's book row is another position")
})

test('a CLOSED book row with a NULL position_id shields nothing', async () => {
  const db = bankDb()
  const tid = tradeFor(db, CREDS.accountId, 999)
  bookRowNoPositionId(db, CREDS.accountId, tid, 'GD.US', 'closed')
  const closed = []
  await runWeekendBank(db, CREDS, [POS(999)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [999], 'the book has let this one go')
})

test('the toggle still switches the WHOLE exemption off, trade-id half included', async () => {
  const db = bankDb()
  const tid = tradeFor(db, CREDS.accountId, 1111)
  bookRowNoPositionId(db, CREDS.accountId, tid)
  setState2(db, 'weekend_bank_book_exempt', 'false')
  const closed = []
  await runWeekendBank(db, CREDS, [POS(1111)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [1111])
})

test('a position with no trade row at all is still bankable — no exemption by accident', async () => {
  const db = bankDb()
  const tid = tradeFor(db, CREDS.accountId, 1212)
  bookRowNoPositionId(db, CREDS.accountId, tid)
  const closed = []
  // 1313 is a different position; the book's held trade must not shield it.
  await runWeekendBank(db, CREDS, [POS(1313)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [1313])
})

test('WIRING: the weekend bank uses the shared rule, not a local query', async () => {
  // The defect being pinned is a rule that existed in two files with two
  // definitions, one of them wrong. A source test is the last resort and this
  // is its case: "which module answers this question" is invisible from the
  // behaviour once both give the same answer. Comments are stripped first —
  // `book-held` appears in prose in both files.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const dir = path.dirname(url.fileURLToPath(import.meta.url))
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(strip('x // book-held.js').includes('book-held'), false, 'comment stripper works')

  for (const f of ['weekend-bank.js', 'naked-position-guard.js']) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'))
    assert.match(src, /from '\.\/book-held\.js'/, `${f} must import the shared rule`)
    assert.ok(!/SELECT\s+(position_id|trade_id)\s+FROM\s+momentum_book/.test(src),
      `${f} still carries its own copy of the book-held query`)
  }
  // And the shared module is the only place the query lives.
  const shared = strip(fs.readFileSync(path.join(dir, 'book-held.js'), 'utf8'))
  assert.match(shared, /SELECT position_id FROM momentum_book/)
  assert.match(shared, /SELECT trade_id FROM momentum_book/)
})

test('NO ACCOUNT, NO EXEMPTION: an absent accountId must not exempt everything', async () => {
  // The old local helper did `String(accountId)`, so an absent id became the
  // string "undefined", matched nothing, and exempted nothing. Handing `null`
  // to the shared rule means "every account" — the opposite default, reached by
  // accident, on the one guard whose job is to CLOSE before a gap.
  const db = bankDb()
  bookRow(db, CREDS.accountId, 1414)
  const closed = []
  const { accountId, ...noAccount } = CREDS
  assert.ok(accountId, 'the fixture does carry one; this test removes it')
  await runWeekendBank(db, noAccount, [POS(1414)], { deps: fakeDeps(closed), now: FRI_2030 })
  assert.deepEqual(closed, [1414], 'sweep normally rather than exempting the whole book')
})
