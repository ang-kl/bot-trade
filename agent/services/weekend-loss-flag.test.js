// node --test agent/services/weekend-loss-flag.test.js
//
// Weekend loss flag: the pre-closure LOSS visibility sweep — sibling of
// weekend-bank.js's profit sweep, but never closes anything. Pure decision
// only (the closure-window math it shares with weekend-bank.js, nextCloseInfo,
// is already covered by weekend-bank.test.js).

import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldFlag, parseWeekendFlags } from './weekend-loss-flag.js'

const H = 3600

test('shouldFlag: loss inside the window before a long closure → true', () => {
  const base = { open: true, closesInSec: 30 * 60, closureSec: 49 * H, side: 'BUY', entry: 2.905, price: 2.87 }
  assert.equal(shouldFlag(base), true)
  // SELL in loss (price above entry)
  assert.equal(shouldFlag({ ...base, side: 'SELL', entry: 2.87, price: 2.905 }), true)
})

test('shouldFlag: ignores winners, short closures, early hours, missing data', () => {
  const base = { open: true, closesInSec: 30 * 60, closureSec: 49 * H, side: 'BUY', entry: 2.905, price: 2.87 }
  assert.equal(shouldFlag({ ...base, price: 2.95 }), false, 'winning position is not flagged')
  assert.equal(shouldFlag({ ...base, closureSec: 2 * H }), false, 'overnight break is not a weekend')
  assert.equal(shouldFlag({ ...base, closesInSec: 5 * H }), false, 'hours before the close — too early')
  assert.equal(shouldFlag({ ...base, open: false }), false)
  assert.equal(shouldFlag({ ...base, price: null }), false)
  assert.equal(shouldFlag({ ...base, closureSec: null }), false, 'unknown schedule never flags')
})

test('parseWeekendFlags: keeps unexpired enriched markers, drops the rest', () => {
  const now = 1_000_000
  const rows = [
    // live enriched marker → kept, positionId stripped from the key
    { key: 'wl_flagged_123', value: JSON.stringify({ until: now + 60_000, symbol: 'EURUSD', side: 'BUY', entry: 1.10, price: 1.09, movePct: -0.91, closureHrs: 49, flaggedAt: '2026-07-23T15:00:00Z' }) },
    // expired marker → dropped
    { key: 'wl_flagged_124', value: JSON.stringify({ until: now - 1, symbol: 'NATGAS', side: 'SELL', movePct: -2 }) },
    // pre-enrichment marker (no symbol) → dropped harmlessly
    { key: 'wl_flagged_125', value: JSON.stringify({ until: now + 60_000 }) },
    // unreadable marker → dropped without throwing
    { key: 'wl_flagged_126', value: 'not-json' },
  ]
  const flags = parseWeekendFlags(rows, now)
  assert.equal(flags.length, 1)
  assert.equal(flags[0].positionId, '123')
  assert.equal(flags[0].symbol, 'EURUSD')
  assert.equal(flags[0].movePct, -0.91)
  assert.equal(flags[0].closureHrs, 49)
})

test('parseWeekendFlags: empty/absent input → empty list', () => {
  assert.deepEqual(parseWeekendFlags([]), [])
  assert.deepEqual(parseWeekendFlags(null), [])
})
