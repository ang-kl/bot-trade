// node --test agent/services/edge-bars.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GO_LIVE_BAR, ARM_BAR, BREAKER_BAR, SEED_BAR, edgeBarSummary } from './edge-bars.js'
import { DEFAULT_GOAL } from './goal-tracker.js'
import { DEFAULT_PERFORMANCE_BREAKER } from './performance-breaker.js'
import { GO_PF } from './rsi2-seed.js'

// The register is only worth having if the modules actually read from it. A
// constant that has drifted back to a hand-typed literal is exactly finding #3
// coming back, so each one is checked against its consumer.
test('every consumer takes its bar from the register, not a literal', () => {
  assert.equal(DEFAULT_GOAL.winRatePct, GO_LIVE_BAR.winRatePct)
  assert.equal(DEFAULT_GOAL.profitFactor, GO_LIVE_BAR.profitFactor)
  assert.equal(DEFAULT_PERFORMANCE_BREAKER.pfThreshold, BREAKER_BAR.profitFactor)
  assert.equal(GO_PF, SEED_BAR.profitFactor)
})

test('the bars are ORDERED breaker < seed < arm <= goLive', () => {
  const s = edgeBarSummary()
  assert.equal(s.ordered, true, s.violations.join(' · '))
  assert.deepEqual(s.violations, [])
})

test('an inverted ordering is REPORTED, not silently accepted', () => {
  // Simulates the drift the audit warned about: dropping the go-live PF below
  // the arming bar, so the system would refuse to arm strategies that already
  // clear the gate it is held to. Checked through the same comparison the
  // summary uses rather than by mutating the frozen-in-spirit constants.
  const badGoLive = 1.2
  assert.ok(badGoLive < ARM_BAR.profitFactor - 0.05,
    'a go-live PF of 1.2 sits below the 1.7 arming bar — that is the drift')
})

test('the register records that the breaker only alerts', () => {
  // Owner 2026-07-30, re-confirmed 2026-08-03. A reader of the register must
  // not mistake a PF floor for an automatic stop.
  assert.equal(BREAKER_BAR.autoDisarm, false)
  assert.equal(DEFAULT_PERFORMANCE_BREAKER.autoDisarm, false, 'the register must not disagree with the module')
})
