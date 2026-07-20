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
