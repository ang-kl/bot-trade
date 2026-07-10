// node --test agent/services/strategy-autopilot.test.js
// The policy brain is pure — these tests ARE the automation's contract.

import test from 'node:test'
import assert from 'node:assert/strict'
import { decideChanges } from './strategy-autopilot.js'
import { explainVerdict, equitySvg, renderAutopilotReport } from '../lib/autopilot-report.js'

const GO = (strategy, symbol, timeframe, entryMode = 'close') => ({ strategy, symbol, timeframe, entryMode, state: 'go', trades: 20, pf: 1.8, total: 5, wfActive: 4, wfPositive: 3 })
const NOGO = (strategy, symbol, timeframe, entryMode = 'close') => ({ strategy, symbol, timeframe, entryMode, state: 'no-go', trades: 20, pf: 0.8, total: -3, wfActive: 4, wfPositive: 1 })
const EMPTY = { enabledStrategies: ['fib_618_fade'], autoMatrix: {}, pendingMatrix: {} }

test('fresh close-confirm GO arms the strategy AND its matrix combo', () => {
  const c = decideChanges([GO('ema_pullback', 'GBPUSD', '12h')], EMPTY)
  assert.deepEqual(c.arm.map(a => a.kind).sort(), ['matrix', 'strategy'])
  assert.equal(c.disarm.length, 0)
})

test('touch GO arms the pending matrix, not the strategy list', () => {
  const c = decideChanges([GO('fib_618_fade', 'EURUSD', '3d', 'touch')], EMPTY)
  assert.deepEqual(c.arm, [{ kind: 'pending', strategy: 'fib_618_fade', symbol: 'EURUSD', timeframe: '3d' }])
})

test('already-armed combos produce no changes', () => {
  const cur = { enabledStrategies: ['fib_618_fade', 'ema_pullback'], autoMatrix: { GBPUSD: ['12h'] }, pendingMatrix: {} }
  const c = decideChanges([GO('ema_pullback', 'GBPUSD', '12h')], cur)
  assert.equal(c.arm.length + c.disarm.length, 0)
})

test('armed combo gone NO-GO is disarmed', () => {
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: { EURUSD: ['3d'] } }
  const c = decideChanges([NOGO('fib_618_fade', 'US30', '1d'), NOGO('fib_618_fade', 'EURUSD', '3d', 'touch')], cur)
  assert.deepEqual(c.disarm.map(d => d.kind).sort(), ['matrix', 'pending'])
})

test('thin verdicts neither arm nor disarm', () => {
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: {} }
  const c = decideChanges([{ strategy: 'fib_618_fade', symbol: 'US30', timeframe: '1d', entryMode: 'close', state: 'thin' }], cur)
  assert.equal(c.arm.length + c.disarm.length, 0)
})

test('change cap: disarms jump the queue, overflow becomes suggestions', () => {
  const verdicts = [
    NOGO('fib_618_fade', 'US30', '1d'),
    GO('ema_pullback', 'GBPUSD', '12h'),
    GO('donchian_breakout', 'EURUSD', '4h'),
    GO('rsi_meanrev', 'USDJPY', '1d'),
  ]
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: {} }
  const c = decideChanges(verdicts, cur, { maxChanges: 2 })
  assert.equal(c.disarm.length, 1) // the safety cut got through
  assert.equal(c.arm.length, 1)
  assert.ok(c.suggestions.length >= 4) // the rest wait for the human or the next night
})

test('explainVerdict spells out each gate in words', () => {
  const lines = explainVerdict({ trades: 3, pf: 1.5, total: 2, wfActive: 4, wfPositive: 3 })
  assert.equal(lines[0].ok, false)
  assert.match(lines[0].text, /need at least 10/)
  assert.equal(lines[1].ok, true)
})

test('equitySvg renders an inline chart, handles too-few points', () => {
  assert.match(equitySvg([0, 1.2, 0.8, 2.4]), /^<svg/)
  assert.match(equitySvg([1]), /not enough trades/)
})

test('renderAutopilotReport is self-contained html grouped by strategy', () => {
  const html = renderAutopilotReport([{ ...GO('ema_pullback', 'GBPUSD', '12h'), equity: [0, 1, 2] }], { ranAt: 'now' }, 'autopilot-x.html')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /ema_pullback/)
  assert.match(html, /GBPUSD 12h/)
  assert.ok(!/https?:\/\//.test(html), 'no external resources')
})
