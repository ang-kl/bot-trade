// node --test agent/amend-preserves-tp.test.js
//
// cTrader's AMEND_POSITION_SLTP_REQ REPLACES a position's protection. A
// payload carrying stopLoss and no takeProfit does not mean "leave the target
// alone" — it means "this position has no target". So every SL-only amend
// silently DELETED the take profit at the broker.
//
// Measured 17-08-2026: the 4 Aug protection audit found 8 of 12 positions with
// no take profit; the two on 42993489 that had been trailed (be_moved=1) both
// read tp=None while their trade rows carried one; and the NatGas breakout was
// placed with a target of 2.595 and held none minutes later. One cause, not
// several — and not the guard bypass it looked like, because placeOrder's
// validateOrderBracket does fire and relativePoints cannot return zero.
//
// These are SOURCE assertions. executeBrokerAction reaches the broker through
// a module-level import with no injection point, so exercising the real call
// would need a socket. The rule being protected is "the payload includes the
// existing takeProfit", which is visible in the source and invisible to every
// other test — and a refactor would drop it silently. Same reasoning as the
// loop-wiring pin in broker-history-import.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const loop = readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
const ws = readFileSync(new URL('./lib/ctrader-ws.js', import.meta.url), 'utf8')

/**
 * The MOVE_SL branch, WITH COMMENTS STRIPPED.
 *
 * The first version of this test matched the raw slice and passed against a
 * build with the takeProfit line deleted — because the explanatory comment
 * above it contains the words "takeProfit" and "pos.current_tp". It was
 * asserting on prose. A test that passes when the code is removed is worth
 * exactly nothing, which is the whole lesson of this file.
 */
function moveSlBranch() {
  const start = loop.indexOf("if (action === 'MOVE_SL')")
  assert.ok(start > 0, 'MOVE_SL branch not found — this test needs re-anchoring')
  const end = loop.indexOf("return { summary: `SL →", start)
  assert.ok(end > start, 'MOVE_SL branch end not found')
  return loop.slice(start, end)
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')
}

test('MOVE_SL re-sends the existing take profit', () => {
  const branch = moveSlBranch()
  assert.match(branch, /takeProfit/,
    'a stop-only amend deletes the target at the broker — MOVE_SL must carry it')
  assert.match(branch, /pos\.current_tp/,
    'the target re-sent must be the position\'s own recorded one')
})

test('MOVE_SL does not invent a target where none existed', () => {
  // The guard has to be conditional. Unconditionally sending pos.current_tp
  // would send null/0 for a position that legitimately has no target, and
  // "amend to a zero take profit" is a different broker instruction again.
  const branch = moveSlBranch()
  assert.match(branch, /Number\(pos\.current_tp\) > 0/,
    'only a real, positive target may be re-sent')
  assert.match(branch, /undefined/,
    'no target means the payload is left exactly as it was')
})

test('the clearing semantics are recorded where the payload is built', () => {
  // The next person to add an amend caller reads ctrader-ws.js, not loop.js.
  // If the note lives only at the call site the trap is re-armed for them.
  // This one IS about the prose, deliberately — the note is the deliverable.
  // But the warning must also be live code, so assert the console.warn exists
  // outside a comment.
  assert.match(ws, /REPLACES/, 'wsAmendPosition must state that amend replaces rather than patches')
  const wsCode = ws.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(wsCode, /console\.warn\([^)]*CLEARS any take profit/,
    'the stop-only clear must WARN at runtime, not only in a comment')
})
