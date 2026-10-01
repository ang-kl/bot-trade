import test from 'node:test'
import assert from 'node:assert/strict'
import { partialExitSummary } from './loop.js'

test('the partial-exit line reports the executed volume, not the requested fraction (COST.US, 01-10-2026)', () => {
  // 0.3 lots, 50% asked, step 0.1 lot → 0.1 closed, 0.2 left: one third, not half.
  const line = partialExitSummary({ fraction: 0.5, closeUnits: 10, totalUnits: 30, lotSize: 100 })
  assert.equal(line, 'closed 0.10L of 0.30L = 33% (asked 50%, floored to the volume step) · runner 0.20L')
  assert.doesNotMatch(line, /closed 50%/)
})

test('when the step does not bite, the line carries no request note', () => {
  assert.equal(
    partialExitSummary({ fraction: 0.5, closeUnits: 20, totalUnits: 40, lotSize: 100 }),
    'closed 0.20L of 0.40L = 50% · runner 0.20L',
  )
})
