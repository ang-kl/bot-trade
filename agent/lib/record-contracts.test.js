// node --test agent/lib/record-contracts.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { utcMs, planContractClass, directionReasonContractClass, RECORD_CONTRACTS, UNPRICEABLE_VERDICTS } from './record-contracts.js'
import { VERDICTS } from '../services/position-lifecycle-evidence.js'

test('utcMs reads every ledger spelling as UTC and never invents a time', () => {
  const t = Date.parse('2026-09-08T07:48:28Z')
  assert.equal(utcMs('2026-09-08 07:48:28'), t, 'SQLite datetime() is UTC')
  assert.equal(utcMs('2026-09-08T07:48:28'), t, 'an ISO time with no zone is UTC, not local')
  assert.equal(utcMs('2026-09-08T07:48:28.000Z'), t)
  assert.equal(utcMs('2026-09-08T15:48:28+08:00'), t)
  assert.equal(utcMs(t), t)
  assert.equal(utcMs('2026-09-08'), Date.parse('2026-09-08T00:00:00Z'))
  for (const v of [null, undefined, '', '   ', 'not a date', NaN]) assert.equal(utcMs(v), null, String(v))
})

test('the contract classes turn at the exact second, and an unknown entry time is never classed', () => {
  const plan = Date.parse(RECORD_CONTRACTS.plan.since)
  assert.equal(planContractClass(plan - 1), 'pre_contract')
  assert.equal(planContractClass(plan), 'post_contract')
  assert.equal(planContractClass(null), null)
  const dr = RECORD_CONTRACTS.direction_reason
  assert.equal(directionReasonContractClass(Date.parse(dr.since) - 1), 'pre_contract')
  assert.equal(directionReasonContractClass(Date.parse(dr.since)), 'post_contract_pre_fix')
  assert.equal(directionReasonContractClass(Date.parse(dr.fixedAt) - 1), 'post_contract_pre_fix')
  assert.equal(directionReasonContractClass(Date.parse(dr.fixedAt)), 'post_contract')
  assert.equal(directionReasonContractClass(undefined), null)
})

test('every unpriceable verdict is a FINAL verdict of the lifecycle evidence reader', () => {
  for (const v of UNPRICEABLE_VERDICTS) {
    assert.ok(VERDICTS[v], `${v} is a verdict position-lifecycle-evidence.js writes`)
    assert.equal(VERDICTS[v].final, true, `${v} is final — a non-final verdict can still change`)
  }
  assert.ok(!UNPRICEABLE_VERDICTS.includes('unreadable'), 'unreadable says nothing is known')
})
