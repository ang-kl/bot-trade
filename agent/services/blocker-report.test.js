import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { blockerReport } from './blocker-report.js'

const now = Date.parse('2026-09-22T12:00:00Z'), from = now - 3600_000
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,0)').run(id)
  const risk = (account = '11', reason = 'tp_required', approved = 0, checks = '{}', at = '2026-09-22T11:30:00.000Z') =>
    db.prepare('INSERT INTO risk_events (account_id,symbol,approved,veto_reason,checks_json,created_at,repeat_count) VALUES (?,\'EURUSD\',?,?,?,?,7)').run(account, approved, reason, checks, at)
  const stop = (stage, account = '11', decision = 'skip') => db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES (?,?,?,'recorded first reason','2026-09-22 11:30:00')").run(account, stage, decision)
  return { db, risk, stop, read: extra => blockerReport(db, { accountId: '11', from, to: now, now, ...extra }) }
}

test('complete populations survive paging; account scope excludes null and other accounts; reads never mutate evidence', t => {
  const { db, risk, stop, read } = fixture(t)
  db.transaction(() => { for (let i = 0; i < 301; i++) risk() })()
  risk('22'); risk(null); stop('margin_pool', null)
  risk('11', 'old', 0, '{}', '2026-09-22T10:59:59.999Z')
  risk('11', 'end excluded', 0, '{}', '2026-09-22T12:00:00.000Z')
  const before = db.prepare('SELECT total_changes() n').get().n
  const first = read({ limit: 2 }), last = read({ limit: 2, offset: 300 })
  assert.equal(first.totalRecords, 301); assert.equal(first.summary.risk_refusal.records, 301)
  assert.equal(first.summary.risk_refusal.recordedEvaluations, 2107)
  assert.equal(first.records.length, 2); assert.equal(last.records.length, 1)
  assert.equal(last.hasMore, false); assert.equal(first.unattributedRecordsInWindow, 2)
  assert.equal(read({ accountId: 'all' }).totalRecords, 304)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  assert.match(first.countBasis, /not distinct opportunities or orders/)
})

test('recorded first reason and short-circuit evidence remain distinct from unknown phases and approval', t => {
  const { risk, stop, read } = fixture(t)
  stop('margin_pool'); stop('gate_redirect'); stop('submission_dedupe'); stop('fast_monitor')
  stop('unknown_future_stage'); stop('account_pregate:daily_loss'); stop('dispatch', '11', 'proceed')
  risk('11', 'broker_rejected', 0, '{"post_approval":1}')
  risk('11', null, 1); risk('11', 'broken checks', 0, '{oops')
  const r = read(), records = r.records
  assert.deepEqual(Object.fromEntries(Object.entries(r.summary).map(([k,v]) => [k, v.records])), {
    upstream_stop: 2, risk_refusal: 2, post_approval_failure: 2, approved: 1, placement_receipt: 0, other_stop: 2,
  })
  const stage = s => records.find(r => r.stage === s)
  assert.equal(stage('margin_pool').firstBlocker.reason, 'recorded first reason')
  assert.equal(stage('margin_pool').diagnostics[1].status, 'not_evaluated')
  assert.equal(stage('gate_redirect').diagnostics[1].status, 'stopped')
  assert.equal(stage('submission_dedupe').diagnostics[1].status, 'approved')
  assert.equal(stage('fast_monitor').diagnostics[1].status, 'not_recorded')
  assert.equal(records.find(r => r.kind === 'approved').firstBlocker, null)
  assert.equal(records.find(r => r.reason === 'broken checks').recordedChecksStatus, 'unavailable')
})

test('explicit identity and bounded reporting windows are required', t => {
  const { read } = fixture(t)
  for (const options of [{ accountId: undefined }, { accountId: '999' }, { from: NaN }, { from: now }, { limit: 201 }, { offset: -1 }, { to: now + 120_000 }]) assert.throws(() => read(options), RangeError)
})

test('placement receipts retain evidence without inflating approvals or fabricating a new risk evaluation', t => {
  const { risk, read } = fixture(t)
  risk('11', null, 1, '{"volume":true}')
  for (const key of ['pending_order_placed', 'closed_market_limit_placed', 'htf_limit_placed']) {
    risk('11', null, 1, JSON.stringify({ [key]: true, orderId: 'fixture-order' }, null, 2))
  }
  for (const checks of ['{"pending_order_placed":false}', '{"pending_order_placed":"true"}', '{"pending_order_placed":1}', '{"nested":{"pending_order_placed":true}}', '{broken']) {
    risk('11', null, 1, checks)
  }
  risk('22', null, 1, '{"pending_order_placed":true}')
  risk(null, null, 1, '{"pending_order_placed":true}')
  const r = read({ limit: 2 })
  assert.equal(r.totalRecords, 9)
  assert.equal(r.summary.approved.records, 6)
  assert.equal(r.summary.placement_receipt.records, 3)
  assert.equal(r.summary.placement_receipt.recordedEvaluations, 3)
  assert.equal(r.unattributedRecordsInWindow, 1)
  assert.equal(read({ accountId: 'all' }).summary.placement_receipt.records, 5)
  const receipts = read().records.filter(row => row.kind === 'placement_receipt')
  assert.equal(receipts.length, 3)
  for (const row of receipts) {
    assert.equal(row.stage, 'submission_receipt')
    assert.equal(row.firstBlocker, null)
    assert.equal(row.disposition, 'placed')
    assert.equal(row.diagnostics[1].status, 'not_recorded')
    assert.equal(row.diagnostics[2].status, 'placed')
    assert.equal(row.recordedChecks.orderId, 'fixture-order')
  }
})

test('known upstream fences and submission-boundary caps preserve the actual gate boundary', t => {
  const { risk, stop, read } = fixture(t)
  for (const stage of ['regime_block', 'evidence_gate', 'producer_retired']) stop(stage)
  stop('symbol_position_cap', '11', 'veto')
  risk('11', 'symbol cap rejected', 0, '{"post_approval":true}')
  const r = read()
  assert.equal(r.summary.upstream_stop.records, 3)
  assert.equal(r.summary.post_approval_failure.records, 2)
  assert.equal(r.summary.other_stop.records, 0)
  for (const row of r.records) {
    if (row.kind === 'upstream_stop') assert.equal(row.diagnostics[1].status, 'not_evaluated')
    else {
      assert.equal(row.kind, 'post_approval_failure')
      assert.equal(row.diagnostics[1].status, 'approved')
      assert.equal(row.diagnostics[2].status, 'stopped')
    }
    assert.ok(row.firstBlocker.reason)
  }
})
