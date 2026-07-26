// node --test agent/services/manual-position-guards.test.js
//
// P2 / gate D11 answered "harden both" (owner, 2026-07-26).
// Audit F-L5-01, F-L5-02, F-L5-03, F-L5-08.
//
// What these routes could do before: place a second market order with
// `allowNaked: true`, write nothing to the DB, apply no cap of any kind, and
// on a reverse leave the account flat with a 502 body as the only record. A
// client retry after a timeout took two of whichever it was.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  loadManualGuards, siblingPositions, checkAddCap, inheritedBracket,
  mirroredBracket, isDuplicateCall, DEFAULT_MANUAL_GUARDS,
} from './manual-position-guards.js'

const BUY = 1, SELL = 2
const posn = (positionId, { symbolId = 1, side = BUY, openPrice = 1.1, sl = 1.09, tp = 1.13, volume = 1000 } = {}) => ({
  positionId,
  stopLoss: sl,
  takeProfit: tp,
  tradeData: { symbolId, tradeSide: side, openPrice, volume },
})

// ---------------------------------------------------------------------------
// The cap — counted from broker truth.
// ---------------------------------------------------------------------------

test('siblings are same symbol AND same side, including the position itself', () => {
  const p = posn(1)
  const book = [p, posn(2), posn(3, { side: SELL }), posn(4, { symbolId: 9 })]
  assert.equal(siblingPositions(book, p).length, 2)
})

test('the default cap allows exactly one add, then refuses', () => {
  const p = posn(1)
  assert.equal(checkAddCap([p], p).ok, true, 'first add is allowed')

  const after = checkAddCap([p, posn(2)], p)
  assert.equal(after.ok, false)
  assert.equal(after.existing, 2)
  assert.match(after.reason, /^add_cap: 2 position\(s\) already open/)
})

test('an add placed BY HAND in the cTrader app counts against the cap', () => {
  // The point of counting broker truth rather than our own ledger: this
  // route wrote nothing, so a ledger-based cap would have counted zero.
  const p = posn(1)
  assert.equal(checkAddCap([p, posn(77)], p).ok, false)
})

test('maxAddsPerPosition 0 disables adding entirely', () => {
  const p = posn(1)
  const v = checkAddCap([p], p, { ...DEFAULT_MANUAL_GUARDS, maxAddsPerPosition: 0 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /cap is 1/)
})

test('a higher cap allows more, and still stops', () => {
  const p = posn(1)
  const g = { ...DEFAULT_MANUAL_GUARDS, maxAddsPerPosition: 2 }
  assert.equal(checkAddCap([p, posn(2)], p, g).ok, true)
  assert.equal(checkAddCap([p, posn(2), posn(3)], p, g).ok, false)
})

// ---------------------------------------------------------------------------
// The bracket — never naked.
// ---------------------------------------------------------------------------

test('an add inherits the parent stop PRICE, and its target when there is one', () => {
  const b = inheritedBracket(posn(1, { sl: 1.0850, tp: 1.1300 }))
  assert.equal(b.ok, true)
  assert.equal(b.stopLoss, 1.0850)
  assert.equal(b.takeProfit, 1.1300)
})

test('a parent with NO stop refuses the add rather than sending it naked', () => {
  const b = inheritedBracket(posn(1, { sl: 0 }))
  assert.equal(b.ok, false)
  assert.match(b.reason, /^no_parent_stop:/)
})

test('requireParentStop:false is the only way to get the old naked behaviour', () => {
  const b = inheritedBracket(posn(1, { sl: 0 }), { ...DEFAULT_MANUAL_GUARDS, requireParentStop: false })
  assert.equal(b.ok, true)
  assert.equal(b.stopLoss, null)
})

test('a reverse mirrors the parent DISTANCES, not its prices', () => {
  // Long from 1.1000 with a stop at 1.0900 and target 1.1300 → the short leg
  // gets the same 100-pip risk and 300-pip target, measured from its own fill.
  const m = mirroredBracket(posn(1, { openPrice: 1.1000, sl: 1.0900, tp: 1.1300 }))
  assert.equal(m.ok, true)
  assert.ok(Math.abs(m.slDistance - 0.0100) < 1e-9)
  assert.ok(Math.abs(m.tpDistance - 0.0300) < 1e-9)
})

test('a reverse with no parent stop is refused, same rule as an add', () => {
  const m = mirroredBracket(posn(1, { sl: 0 }))
  assert.equal(m.ok, false)
  assert.match(m.reason, /^no_parent_stop:/)
})

test('a reverse with no parent entry cannot mirror anything', () => {
  const m = mirroredBracket({ stopLoss: 1.09, tradeData: {} })
  assert.equal(m.ok, false)
  assert.match(m.reason, /^no_entry_price:/)
})

test('a parent with a stop but no target mirrors the stop alone', () => {
  const m = mirroredBracket(posn(1, { openPrice: 1.1, sl: 1.09, tp: 0 }))
  assert.equal(m.ok, true)
  assert.ok(m.slDistance > 0)
  assert.equal(m.tpDistance, null)
})

// ---------------------------------------------------------------------------
// The dedup window — the retry-after-timeout case.
// ---------------------------------------------------------------------------

const call = (route, positionId, at) => ({ route, positionId: String(positionId), at, sending: true })

test('the same call seconds later is refused', () => {
  const now = 1_000_000
  const v = isDuplicateCall([call('position-double', 5, now - 3000)], { route: 'position-double', positionId: 5 }, now)
  assert.equal(v.duplicate, true)
  assert.match(v.reason, /^duplicate_manual_call: position-double on position 5 was performed 3s ago/)
})

test('past the window it is intent, not an echo', () => {
  const now = 1_000_000
  assert.equal(
    isDuplicateCall([call('position-double', 5, now - 31_000)], { route: 'position-double', positionId: 5 }, now).duplicate,
    false,
  )
})

test('the window is per route and per position', () => {
  const now = 1_000_000
  const recent = [call('position-double', 5, now - 1000)]
  assert.equal(isDuplicateCall(recent, { route: 'position-reverse', positionId: 5 }, now).duplicate, false, 'a reverse is not a double')
  assert.equal(isDuplicateCall(recent, { route: 'position-double', positionId: 6 }, now).duplicate, false, 'another position is not this one')
})

test('dedupeSeconds 0 disables the window', () => {
  const now = 1_000_000
  const v = isDuplicateCall([call('position-double', 5, now - 100)], { route: 'position-double', positionId: 5 }, now,
    { ...DEFAULT_MANUAL_GUARDS, dedupeSeconds: 0 })
  assert.equal(v.duplicate, false)
})

test('an empty or missing history is not a duplicate', () => {
  assert.equal(isDuplicateCall([], { route: 'position-double', positionId: 5 }).duplicate, false)
  assert.equal(isDuplicateCall(undefined, { route: 'position-double', positionId: 5 }).duplicate, false)
})

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

test('defaults are the strict end, and a partial config keeps them', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadManualGuards(db), { ...DEFAULT_MANUAL_GUARDS })

  setState(db, 'manual_guards_json', JSON.stringify({ maxAddsPerPosition: 3 }))
  const g = loadManualGuards(db)
  assert.equal(g.maxAddsPerPosition, 3)
  assert.equal(g.requireParentStop, true, 'the stop requirement survives a partial config')
  assert.equal(g.dedupeSeconds, DEFAULT_MANUAL_GUARDS.dedupeSeconds)
})

test('an unreadable config falls back to the strict defaults', () => {
  const db = initDB(':memory:')
  setState(db, 'manual_guards_json', '{not json')
  assert.deepEqual(loadManualGuards(db), { ...DEFAULT_MANUAL_GUARDS })
})
