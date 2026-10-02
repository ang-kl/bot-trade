// node --test agent/lib/stop-loss-grader.test.js
//
// The live acceptance grader's verdicts (02-10-2026, PR-3). Each check must be
// able to FAIL (a grader that cannot go red is decoration) and must say NOT
// VERIFIABLE, not PASS, when the evidence has not arrived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gradeStopLoss, targetSnapshot, PASS, FAIL, NOT_VERIFIABLE } from './stop-loss-grader.js'

const pos = (id, o = {}) => ({ positionId: id, stopLoss: 95, takeProfit: 110, stopLossTriggerMethod: 2, trailingStopLoss: false, ...o })
const acct = (id, positions, o = {}) => ({ accountId: id, ok: true, stale: false, missingSl: 0, missingTp: 0, policyDrift: [], positions, ...o })
const hb = (...accounts) => ({ runtime: { accounts } })
const policy = (o = {}) => ({ policy: { enabled: true, triggerMethod: 'OPPOSITE', trailing: 'on_lock' }, counts: { amends: 3, applied: 1, unchanged: 2, refused: 0, readback: { mismatch: 0 } },
  controller: { holdUntil: null, last: { at: 1, considered: 3, stamped: 1, compliant: 2, refused: 0, failed: 0, mismatch: 0, errors: [] } }, ...o })
const mae = (o = {}) => ({ summary: { positions: 2, adjustable: 1, receiptsSent: 1, receiptsConfirmed: 1, receiptsUnchanged: 0 }, receipts: [{ sent: true, confirmed: true, policy: { refused: false } }], ...o })
const verdictOf = (r, id) => r.checks.find(c => c.id === id).verdict
const good = () => ({ policy: policy(), maeChandelier: mae(), heartbeats: hb(acct('4001', [pos('1'), pos('2')])) })

test('a healthy read passes every check it can decide, and the baseline check says it has no baseline', () => {
  const r = gradeStopLoss(good())
  for (const id of ['policy_on', 'verifier_reads', 'stops_opposite', 'protection_complete', 'policy_drift', 'controller', 'amend_outcomes', 'chandelier_receipts']) assert.equal(verdictOf(r, id), PASS, id)
  assert.equal(verdictOf(r, 'target_unchanged'), NOT_VERIFIABLE)
  assert.equal(r.verdict, NOT_VERIFIABLE)
})

test('each check can fail', () => {
  const g = good()
  assert.equal(verdictOf(gradeStopLoss({ ...g, policy: policy({ policy: { enabled: false, triggerMethod: 'OPPOSITE' } }) }), 'policy_on'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, heartbeats: hb(acct('4001', [pos('1')], { ok: false })) }), 'verifier_reads'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, heartbeats: hb(acct('4001', [pos('1', { stopLossTriggerMethod: 1 })])) }), 'stops_opposite'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, heartbeats: hb(acct('4001', [pos('1')], { missingTp: 1 })) }), 'protection_complete'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, heartbeats: hb(acct('4001', [pos('1')], { policyDrift: [{ positionId: '1' }] })) }), 'policy_drift'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, policy: policy({ controller: { holdUntil: 5, last: { at: 1 } } }) }), 'controller'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, policy: policy({ counts: { amends: 3, refused: 1, readback: {} } }) }), 'amend_outcomes'), FAIL)
  assert.equal(verdictOf(gradeStopLoss({ ...g, maeChandelier: mae({ receipts: [{ sent: true, confirmed: false }] }) }), 'chandelier_receipts'), FAIL)
})

test('missing evidence is NOT VERIFIABLE, never a pass', () => {
  assert.equal(verdictOf(gradeStopLoss({ ...good(), heartbeats: hb(acct('4001', [pos('1', { stopLossTriggerMethod: undefined })])) }), 'stops_opposite'), NOT_VERIFIABLE)
  assert.equal(verdictOf(gradeStopLoss({ ...good(), policy: policy({ counts: { amends: 0, readback: {} } }) }), 'amend_outcomes'), NOT_VERIFIABLE)
  assert.equal(verdictOf(gradeStopLoss({ ...good(), maeChandelier: { summary: { positions: 3, adjustable: 0, receiptsSent: 0, receiptsUnchanged: 0 }, receipts: [] } }), 'chandelier_receipts'), NOT_VERIFIABLE)
  assert.equal(verdictOf(gradeStopLoss({}), 'policy_on'), NOT_VERIFIABLE)
})

test('target baseline: identical passes, a lost target fails, accounts are named by their last four digits', () => {
  const heartbeats = hb(acct('46130058', [pos('1')]))
  const base = targetSnapshot(heartbeats)
  assert.deepEqual(Object.keys(base), ['…0058:1'])
  assert.equal(verdictOf(gradeStopLoss({ ...good(), heartbeats, baselineTp: base }), 'target_unchanged'), PASS)
  assert.equal(verdictOf(gradeStopLoss({ ...good(), heartbeats: hb(acct('46130058', [pos('1', { takeProfit: null })])), baselineTp: base }), 'target_unchanged'), FAIL)
  assert.ok(!JSON.stringify(gradeStopLoss({ ...good(), heartbeats })).includes('46130058'), 'no full account id in the output')
})
