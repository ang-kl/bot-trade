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
import { roundAmendPayload } from './loop.js'

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
  // Ends where the next action's helper begins: the branch's return grew a
  // conditional summary (stop policy rail, 02-10-2026), so the old anchor on
  // its first template literal no longer marks the end.
  const end = loop.indexOf('const volumeMeta', start)
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
  assert.match(branch, /const keepTp = Number\(pos\.current_tp\) > 0 \? Number\(pos\.current_tp\) : undefined/,
    'no target means keepTp is undefined, never a made-up number')
  // 02-10-2026: the payload used to OMIT the key when there was no target.
  // assertAmendIntent (17-09) rejects an omitted takeProfit on a stop amend —
  // "pass the value to keep, or null if the position has none" — so a
  // TP-less row's stop move THREW. The explicit null is that contract's
  // spelling of "I looked, there is none"; the exec layer deletes it before
  // the wire, so the broker still receives no target instruction (the
  // behaviour test below proves both halves).
  assert.match(branch, /takeProfit: sendTp \?\? null/,
    'no target is passed as an explicit null — the exec layer strips it; omitting the key throws')
  assert.doesNotMatch(branch, /\.\.\.\(sendTp !== undefined/, 'the old omit-the-key spelling must not return')
})

test('behaviour: a stop amend with no target needs the explicit null, and the null never reaches the wire', async () => {
  const { assertAmendIntent } = await import('./lib/exec-engine.js')
  assert.throws(() => assertAmendIntent({ positionId: 1, stopLoss: 5 }), /CLEARS the take profit/,
    'omitting takeProfit is rejected — the old MOVE_SL payload for a TP-less row')
  const ok = assertAmendIntent({ positionId: 1, stopLoss: 5, takeProfit: null })
  assert.equal('takeProfit' in ok, false, 'null is stripped: the broker gets no target instruction')
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

/**
 * Just the object literal handed to execAmendPosition in a branch.
 *
 * The raw-stop assertions below must look HERE and not at the whole branch:
 * `roundAmendPayload({ stopLoss: eval_.newSL, … })` mentions the raw value on
 * purpose — it is the input being rounded. What must never appear is the raw
 * value in the PAYLOAD, which is the thing the broker receives.
 */
function amendPayload(branch) {
  const start = branch.indexOf('execAmendPosition(')
  assert.ok(start > 0, 'no execAmendPosition call in this branch — re-anchor')
  const from = branch.indexOf('{', branch.indexOf('},', start))
  const end = branch.indexOf('})', from)
  assert.ok(from > 0 && end > from, 'amend payload not found — re-anchor')
  return branch.slice(from, end)
}

test('MOVE_SL rounds the prices it sends to the symbol digits', () => {
  // Production 2026-08-26, every pass for ~43 minutes of log: `PM US2000:
  // MOVE_SL FAILED — Order price = 3101.801785714286 has more digits than
  // allowed (INVALID_REQUEST)`. The trail computes newSL as raw arithmetic;
  // the keeper and loss-guardian round via roundToDigits but this executor
  // sent the raw value — so the stop never moved at all, silently, forever.
  const branch = moveSlBranch()
  assert.match(branch, /roundAmendPayload\(/,
    'the executor must round SL/TP to the symbol digits before the amend')
  assert.match(branch, /stopLoss: sendSL/,
    'the amend payload must carry the ROUNDED stop, not the raw eval value')
  assert.doesNotMatch(amendPayload(branch), /eval_\.newSL/,
    'the raw unrounded stop must no longer reach the payload')
})

// ---------------------------------------------------------------------------
// PR-J / checker M3: the PARTIAL_EXIT branch amends the RUNNER leg with the
// same kind of raw price arithmetic and did not round. It was unreachable on
// managed accounts before PR-J (partialTriggerR Infinity); the +1R bank take
// routes through it now, sending `peak − 1.5 × initial_risk` — the exact shape
// that failed on 2026-08-26. Half banked, amend rejected, remainder left on its
// pre-partial stop is a worse outcome than either rule alone.
// ---------------------------------------------------------------------------

function partialBranch() {
  const start = loop.indexOf("if (action === 'PARTIAL_EXIT')")
  assert.ok(start > 0, 'PARTIAL_EXIT branch not found — this test needs re-anchoring')
  const end = loop.indexOf('return { summary: partialExitSummary(', start)
  assert.ok(end > start, 'PARTIAL_EXIT branch end not found')
  return loop.slice(start, end).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
}

test('PARTIAL_EXIT rounds the runner leg it amends, and carries its target', () => {
  const branch = partialBranch()
  assert.match(branch, /roundAmendPayload\(/, 'the runner amend must round to the symbol digits')
  assert.match(branch, /stopLoss: runnerSend\.stopLoss/, 'the payload carries the ROUNDED stop')
  assert.doesNotMatch(amendPayload(branch), /eval_\.newSL/, 'the raw unrounded stop must not reach the payload')
  assert.match(branch, /takeProfit: runnerSend\.takeProfit/, 'the runner keeps its target, rounded too')
  // What the broker HOLDS: the sent, rounded stop — unless the sidecar's
  // read-back says it already held a tighter one (heldStop).
  assert.match(branch, /updatePositionSl\.run\(heldStop\(amendRes, runnerSend\.stopLoss\)/, 'the DB records what the broker holds')
  assert.match(branch, /\.\.\.stopAmendExtras\(db, pos, ctx, accountId\)/, 'the runner amend carries the stop policy context and the never-loosen rail')
})

test('roundAmendPayload: behaviour, not source — digits applied, absent digits pass through', () => {
  // The production value from the 2026-08-26 log, at a 2-digit symbol.
  assert.deepEqual(roundAmendPayload({ stopLoss: 3101.801785714286, takeProfit: 3150.123456, digits: 2 }),
    { stopLoss: 3101.8, takeProfit: 3150.12 })
  assert.deepEqual(roundAmendPayload({ stopLoss: 1.234567891, takeProfit: undefined, digits: 5 }),
    { stopLoss: 1.23457, takeProfit: undefined })
  // A failed digit lookup sends the values through unrounded rather than
  // inventing a precision — a possible rejection beats a wrong price.
  assert.deepEqual(roundAmendPayload({ stopLoss: 1.234567891, takeProfit: 2.5, digits: null }),
    { stopLoss: 1.234567891, takeProfit: 2.5 })
  assert.deepEqual(roundAmendPayload({ stopLoss: null, takeProfit: null, digits: 3 }),
    { stopLoss: null, takeProfit: null })
})

test('MOVE_SL records the value it sent, not the unrounded intent', () => {
  // The DB row is read back as "the stop the broker holds" (protection audit,
  // keeper trail-vs-current comparisons). Recording the unrounded intent
  // while the broker holds the rounded price re-opens a permanent tiny
  // disagreement between the two readings.
  const start = loop.indexOf("if (action === 'MOVE_SL')")
  const end = loop.indexOf('const volumeMeta', start)
  const wide = loop.slice(start, end).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  // `held` is the sent (rounded) stop unless the sidecar's live read found the
  // broker already tighter (broker-side trailing) — then THAT is what the
  // broker holds and nothing was sent.
  assert.match(wide, /const held = heldStop\(res, sendSL\)/,
    'the stored stop is derived from the sent, rounded value and the broker read-back')
  assert.match(wide, /updatePositionSl\.run\(held/,
    'the DB must store what the broker holds')
  assert.match(wide, /toValue: sendSL/,
    'the position event must record what was sent to the broker')
})
