// node --test agent/services/weekend-loss-flag.test.js
//
// Weekend loss flag: the pre-closure LOSS visibility sweep — sibling of
// weekend-bank.js's profit sweep, but never closes anything. Pure decision
// only (the closure-window math it shares with weekend-bank.js, nextCloseInfo,
// is already covered by weekend-bank.test.js).

import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldFlag } from './weekend-loss-flag.js'

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
