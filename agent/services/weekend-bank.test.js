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
