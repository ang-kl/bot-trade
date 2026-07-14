// node --test agent/services/trade-guard.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { decideGuardActions, roundToDigits } from './trade-guard.js'

const PIP = 0.0001

test('break-even: fires once trigger pips reached, SL to entry + offset (long)', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0950, price: 1.1015, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.ok(Math.abs(out.moveSlTo - 1.1003) < 1e-9, `got ${out.moveSlTo}`)
  assert.equal(out.beMoved, true)
})

test('break-even: does not fire below trigger', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0950, price: 1.1014, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.equal(out.moveSlTo, null)
})

test('break-even: never re-fires after be_moved', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.1003, price: 1.1050, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: true,
  })
  assert.equal(out.moveSlTo, null)
})

test('break-even short: SL to entry MINUS offset', () => {
  const out = decideGuardActions({
    side: 'short', entryPrice: 1.1000, currentSl: 1.1050, price: 1.0985, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.ok(Math.abs(out.moveSlTo - 1.0997) < 1e-9, `got ${out.moveSlTo}`)
})

test('break-even: skipped when current SL is already tighter', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.1010, price: 1.1020, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 } }, beMoved: false,
  })
  assert.equal(out.moveSlTo, null)
})

test('trailing: SL follows price at distance, tighten only (long)', () => {
  const guard = { trailing: { on: true, distancePips: 10 } }
  const up = decideGuardActions({ side: 'long', entryPrice: 1.1000, currentSl: 1.0990, price: 1.1050, pipSize: PIP, guard, beMoved: false })
  assert.ok(Math.abs(up.moveSlTo - 1.1040) < 1e-9, `got ${up.moveSlTo}`)
  // Price falls back — target SL would be LOOSER than current: no move.
  const down = decideGuardActions({ side: 'long', entryPrice: 1.1000, currentSl: 1.1040, price: 1.1030, pipSize: PIP, guard, beMoved: false })
  assert.equal(down.moveSlTo, null)
})

test('trailing short: tighten means SL moves DOWN', () => {
  const guard = { trailing: { on: true, distancePips: 10 } }
  const out = decideGuardActions({ side: 'SELL', entryPrice: 1.1000, currentSl: 1.1020, price: 1.0950, pipSize: PIP, guard, beMoved: false })
  assert.ok(Math.abs(out.moveSlTo - 1.0960) < 1e-9, `got ${out.moveSlTo}`)
})

test('trailing beats break-even when it is tighter', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: 1.0990, price: 1.1060, pipSize: PIP,
    guard: { breakEven: { on: true, triggerPips: 15, offsetPips: 3 }, trailing: { on: true, distancePips: 10 } },
    beMoved: false,
  })
  // BE target 1.1003, trailing target 1.1050 — trailing wins, still counts as BE done
  assert.ok(Math.abs(out.moveSlTo - 1.1050) < 1e-9, `got ${out.moveSlTo}`)
  assert.equal(out.beMoved, true)
})

test('partial take-profits: crossed levels close their lots, done levels skipped', () => {
  const out = decideGuardActions({
    side: 'long', entryPrice: 1.1000, currentSl: null, price: 1.1080, pipSize: PIP,
    guard: { takeProfits: [
      { price: 1.1050, lots: 0.3, done: false },
      { price: 1.1070, lots: 0.3, done: true },   // already executed
      { price: 1.1100, lots: 0.4, done: false },  // not reached
    ] },
    beMoved: false,
  })
  assert.deepEqual(out.closes, [{ index: 0, lots: 0.3, price: 1.1050 }])
})

test('partial take-profits short: crossed means price AT OR BELOW level', () => {
  const out = decideGuardActions({
    side: 'short', entryPrice: 2.90, currentSl: null, price: 2.79, pipSize: 0.001,
    guard: { takeProfits: [{ price: 2.793, lots: 0.5, done: false }] }, beMoved: false,
  })
  assert.equal(out.closes.length, 1)
})

test('no guard / missing inputs → no actions', () => {
  assert.deepEqual(decideGuardActions({ side: 'long', entryPrice: 1.1, currentSl: null, price: 1.2, pipSize: PIP, guard: null, beMoved: false }),
    { moveSlTo: null, beMoved: false, closes: [] })
  assert.deepEqual(decideGuardActions({ side: 'long', entryPrice: 1.1, currentSl: null, price: null, pipSize: PIP, guard: { trailing: { on: true, distancePips: 5 } }, beMoved: false }).moveSlTo, null)
})

test('roundToDigits clamps to symbol precision', () => {
  assert.equal(roundToDigits(1.234567, 5), 1.23457)
  assert.equal(roundToDigits(2.8795001, 3), 2.88)
})
