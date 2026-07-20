// node --test agent/services/pnl-watch.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepOf, shouldAlertStep } from './pnl-watch.js'

test('stepOf: signed step of balance percent', () => {
  assert.equal(stepOf(500, 50_000, 1), 1)     // +1.0%
  assert.equal(stepOf(499, 50_000, 1), 0)     // +0.998% — inside first step
  assert.equal(stepOf(-1600, 50_000, 1), -3)  // −3.2%
  assert.equal(stepOf(500, 0, 1), 0)          // no balance → never alert
  assert.equal(stepOf(NaN, 50_000, 1), 0)
})

test('shouldAlertStep: deeper-only in one direction, re-arms across zero', () => {
  assert.equal(shouldAlertStep(1, 0), true, 'first crossing alerts')
  assert.equal(shouldAlertStep(1, 1), false, 'same step stays quiet')
  assert.equal(shouldAlertStep(2, 1), true, 'next full step alerts')
  assert.equal(shouldAlertStep(1, 2), false, 'pulling back is not news')
  assert.equal(shouldAlertStep(-1, 2), true, 'flipping sign alerts')
  assert.equal(shouldAlertStep(-2, -1), true)
  assert.equal(shouldAlertStep(0, 2), false, 'inside the first step never alerts')
})
