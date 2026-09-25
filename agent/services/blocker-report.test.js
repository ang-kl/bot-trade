import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { blockerReport, tickEntryEvaluation, validateBlockerRequest, entryDiagnostics, TICK_EVIDENCE_CHECKS } from './blocker-report.js'
import { engineStatusFor, writeEngineStatus } from './entry-mode.js'
import { recordTickEntryWork } from './tick-entry-work.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'

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
    upstream_stop: 2, risk_refusal: 2, post_approval_failure: 2, tick_refusal: 0, approved: 1, placement_receipt: 0, other_stop: 2,
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

test('latest entry blocker remains available when approvals and placement receipts fill the detail page', t => {
  const { risk, stop, read } = fixture(t)
  stop('evidence_gate')
  risk('11', null, 1, '{}', '2026-09-22T11:50:00Z')
  risk('11', null, 1, '{"pending_order_placed":true}', '2026-09-22T11:51:00Z')
  const r = read({ limit: 1 })
  assert.equal(r.records[0].kind, 'placement_receipt')
  assert.equal(r.latestEntryStop.stage, 'evidence_gate')
  assert.equal(r.latestEntryStop.firstBlocker.reason, 'recorded first reason')
  assert.equal(r.latestEntryStop.diagnostics[1].status, 'not_evaluated')
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

// ---------------------------------------------------------------------------
// V3 C4 (SEQUENCE PR-4, WP-C PR-C1): tick sidecar refusals, the per-account
// stage ranking, and whether tick entries were evaluated at all.
// ---------------------------------------------------------------------------
let seq = 0
const ring = (db, { account = '11', kind = 'fire_refused', code = 'no_permit', detail = 'BUY no keeper permit held', at = '2026-09-22 11:30:00', component = 'tick', symbolId = 41, side = 'cpp_exec_demo' } = {}) =>
  db.prepare(`INSERT INTO cpp_decisions (at, side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES (?, ?, 'boot1', ?, 1790000000000, ?, ?, ?, ?, ?, ?)`)
    .run(at, side, ++seq, component, kind, account, symbolId, code, detail)

test('tick sidecar refusals join the population as their own kind, with their own boundary marking and no risk-gate claim', t => {
  const { db, read } = fixture(t)
  ring(db, { code: 'no_permit' })
  ring(db, { code: 'price_bound', detail: 'BUY fill 105 is more than 4 from the signal\'s 100', at: '2026-09-22 11:31:00' })
  ring(db, { code: 'recorder_not_recording', at: '2026-09-22 11:32:00' })
  ring(db, { code: 'fire_stale', detail: 'queued 7000 ms > 5000', at: '2026-09-22 11:33:00' })
  ring(db, { kind: 'fire_reject', code: 'TRADING_BAD_VOLUME', detail: 'intent=x volume', at: '2026-09-22 11:34:00' })
  ring(db, { kind: 'fire_abandoned', code: 'stopped', detail: 'intent=y', at: '2026-09-22 11:35:00' })
  // excluded: not refusals, another account, another component, the window end
  ring(db, { account: null, kind: 'signal', code: 'BUY', detail: 'shadow dir=up' })
  ring(db, { kind: 'fire_result', code: 'ok', detail: 'intent=z' })
  ring(db, { kind: 'fire', code: 'BUY', detail: 'vol=1' })
  ring(db, { account: '22', code: 'no_permit' })
  ring(db, { component: 'engine', kind: 'refused', code: 'no_permit' })
  ring(db, { code: 'no_permit', at: '2026-09-22 12:00:00' })
  const r = read()
  assert.equal(r.summary.tick_refusal.records, 6, 'RED if the arm is missing (0), counts signal/fire/fire_result rows, or the scope or window leaks')
  const tick = r.records.filter(x => x.kind === 'tick_refusal')
  assert.deepEqual(tick.map(x => x.stage).sort(), ['tick_broker_reject', 'tick_fire:fire_stale', 'tick_fire:no_permit', 'tick_fire:price_bound', 'tick_fire:recorder_not_recording', 'tick_fire_abandoned'])
  const at = stage => Object.fromEntries(tick.find(x => x.stage === stage).diagnostics.map(d => [d.stage, d.status]))
  assert.deepEqual(at('tick_fire:no_permit'), { node_permit: 'absent', sidecar_checks: 'not_evaluated', broker: 'not_evaluated' })
  assert.deepEqual(at('tick_fire:price_bound'), { node_permit: 'spent', sidecar_checks: 'stopped', broker: 'not_evaluated' })
  assert.deepEqual(at('tick_fire:recorder_not_recording'), { node_permit: 'not_evaluated', sidecar_checks: 'stopped', broker: 'not_evaluated' })
  assert.deepEqual(at('tick_fire:fire_stale'), { node_permit: 'spent', sidecar_checks: 'passed', broker: 'not_evaluated' })
  assert.deepEqual(at('tick_broker_reject'), { node_permit: 'spent', sidecar_checks: 'passed', broker: 'rejected' })
  assert.deepEqual(at('tick_fire_abandoned'), { node_permit: 'spent', sidecar_checks: 'passed', broker: 'not_evaluated' })
  for (const row of tick) {
    assert.equal(row.diagnostics.some(d => d.stage === 'risk_gate'), false, 'a tick fire is never a risk-gate approval or refusal')
    assert.equal(row.timeframe, 'tick'); assert.equal(row.symbol, 'symbolId 41'); assert.equal(row.accountId, '11')
    assert.equal(row.detail.side, 'cpp_exec_demo'); assert.equal(row.detail.tsMs, 1790000000000)
  }
  assert.equal(tick.find(x => x.stage === 'tick_fire:price_bound').reason, 'price_bound — BUY fill 105 is more than 4 from the signal\'s 100')
  assert.equal(read({ accountId: 'all' }).summary.tick_refusal.records, 7, 'account 22\'s refusal is in the all-accounts population')
})

test('latestEntryStop includes a newer tick refusal; an unattributed tick refusal is counted as unattributed', t => {
  const { db, stop, read } = fixture(t)
  stop('stage_matrix')
  ring(db, { code: 'no_permit', at: '2026-09-22 11:45:00' })
  ring(db, { account: null, code: 'no_permit', at: '2026-09-22 11:46:00' })
  const r = read()
  assert.equal(r.latestEntryStop.kind, 'tick_refusal', 'RED if the latest-stop query excludes tick_refusal')
  assert.equal(r.latestEntryStop.stage, 'tick_fire:no_permit')
  assert.equal(r.unattributedRecordsInWindow, 1)
})

test('byStage ranks each account\'s entry stops by records; lastReason is the newest record\'s; approvals, receipts and other stops are not ranked', t => {
  const { db, risk, read } = fixture(t)
  const log = db.prepare('INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES (?,?,?,?,?)')
  log.run('11', 'stage_matrix', 'skip', 'a', '2026-09-22 11:10:00')
  log.run('11', 'stage_matrix', 'skip', 'c', '2026-09-22 11:50:00')
  log.run('11', 'stage_matrix', 'skip', 'b', '2026-09-22 11:30:00')
  ring(db, { code: 'no_permit', at: '2026-09-22 11:20:00' }); ring(db, { code: 'no_permit', at: '2026-09-22 11:21:00' })
  log.run('11', 'margin_pool', 'skip', 'free margin exhausted', '2026-09-22 11:40:00')
  for (let i = 0; i < 5; i++) risk('11', null, 1)
  risk('11', null, 1, '{"pending_order_placed":true}'); risk('11', null, 1, '{"pending_order_placed":true}')
  for (let i = 0; i < 4; i++) log.run('11', 'fast_monitor', 'skip', 'managed', '2026-09-22 11:15:00')
  log.run('22', 'stage_matrix', 'skip', 'other account', '2026-09-22 11:15:00')
  const r = read()
  assert.deepEqual(r.byStage.map(x => [x.accountId, x.kind, x.stage, x.records, x.lastReason]), [
    ['11', 'upstream_stop', 'stage_matrix', 3, 'c'],
    ['11', 'tick_refusal', 'tick_fire:no_permit', 2, 'no_permit — BUY no keeper permit held'],
    ['11', 'upstream_stop', 'margin_pool', 1, 'free margin exhausted'],
  ])
  assert.equal(r.byStage[0].lastAt, '2026-09-22T11:50:00.000Z')
  const all = read({ accountId: 'all' }).byStage
  assert.deepEqual(all.filter(x => x.accountId === '22').map(x => [x.stage, x.records]), [['stage_matrix', 1]], 'ranked per account')
})

test('tick entry evaluation: a bar-only account is NOT evaluated, whatever its refusal count; admitted but never pushed is not evaluated either', t => {
  const { db } = fixture(t)
  db.prepare('UPDATE accounts SET enabled = 1').run()
  const nowMs = Date.parse('2026-09-22T12:00:00Z')
  let e = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs })
  let a = e.accounts[0]
  assert.equal(a.status, 'not_evaluated'); assert.equal(a.because, 'basis_not_admitted')
  assert.deepEqual(a.sidecarRefusals, {})
  assert.deepEqual(Object.keys(a.readiness.checks).sort(), [...TICK_EVIDENCE_CHECKS].sort(), 'only the four evidence checks, apart from blockedReasons')
  assert.equal(a.readiness.checks.profile_pinned.ok, false)
  for (const check of TICK_EVIDENCE_CHECKS) assert.ok(a.readiness.blockedReasons.includes(check), check)
  assert.match(e.evaluationNote, /not a pass/)
  // admitted (Time + tick, STABLE) but no fresh pushed receipt: admitted_not_pushed
  writeEngineStatus(db, { ...engineStatusFor(db, '11'), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', admittedBases: ['bar', 'tick'], configRevision: 1, updatedAt: new Date(nowMs).toISOString() })
  a = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs }).accounts[0]
  assert.equal(a.status, 'admitted_not_pushed', 'RED if an admitted account reads "evaluated" with nothing pushed to the sidecar')
  assert.equal(a.because, 'no_fresh_feed_receipt')
  const pass = (over = {}, paused = null) => recordTickEntryWork(db, { side: { name: 'cpp_exec_demo' }, creds: { ready: true }, accounts: ['11'], completedAt: nowMs - 30_000,
    result: { pushed: true, carried: ['EURUSD'], work: [{ accountId: '11', permits: paused ? 0 : 2, paused, firstRefusal: null, refused: [] }], ...over } })
  pass({ pushed: false, error: 'sidecar refused the tick permit push' })
  a = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs }).accounts[0]
  assert.equal(a.status, 'admitted_not_pushed'); assert.equal(a.because, 'sidecar refused the tick permit push')
  pass()
  a = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs }).accounts[0]
  assert.equal(a.status, 'evaluated'); assert.equal(a.stoppedAt, null); assert.equal(a.permitFeed.permits, 2)
  pass({}, 'entry_mode_readiness: recorder_recording')
  a = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs }).accounts[0]
  assert.equal(a.status, 'evaluated'); assert.equal(a.stoppedAt, 'node_permit_feed'); assert.equal(a.stoppedReason, 'entry_mode_readiness: recorder_recording')
  // a receipt older than six minutes is not evidence the account was evaluated
  a = tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs + 360_000 }).accounts[0]
  assert.equal(a.status, 'admitted_not_pushed')
  db.prepare("UPDATE accounts SET enabled = 0 WHERE account_id = '11'").run()
  assert.equal(tickEntryEvaluation(db, { accountId: '11', from, to: nowMs, now: nowMs }).accounts[0].because, 'account_disabled')
})

test('side counters are the sidecar\'s own since boot; signal outcomes are classified without LIKE wildcards', t => {
  const { db } = fixture(t)
  setState(db, 'cpp_exec_demo_tick_json', JSON.stringify({ at: '2026-09-22T11:59:00.000Z', status: { entry: { fills: 433, accounts: 0, refusedNoPermit: 0 } } }))
  for (const detail of ['shadow dir=up', 'shadow_cost dir=up', 'shadow_busy dir=up', 'shadowXcost dir=up']) ring(db, { account: null, kind: 'signal', code: 'BUY', detail })
  ring(db, { account: null, kind: 'signal', code: 'BUY', detail: 'shadow dir=up', side: 'cpp_exec' })
  const e = tickEntryEvaluation(db, { accountId: 'all', from, to: now, now })
  const demo = e.sides.find(s => s.side === 'cpp_exec_demo'), live = e.sides.find(s => s.side === 'cpp_exec')
  assert.equal(demo.entry.fills, 433); assert.equal(demo.entry.accounts, 0); assert.equal(demo.sinceBoot, true)
  assert.deepEqual(demo.signalsInWindow, { shadow: 1, shadow_cost: 1, shadow_busy: 1, other: 1 }, 'RED if a LIKE \'_\' wildcard reads shadowXcost as shadow_cost')
  assert.deepEqual(live.signalsInWindow, { shadow: 1, shadow_cost: 0, shadow_busy: 0, other: 0 })
  assert.equal(live.entry, null, 'no status recorded is null, never zeros')
})

test('the blocker report, the tick evaluation and the entry diagnostics never write; request validation runs no SQL', t => {
  const { db, stop } = fixture(t)
  stop('stage_matrix'); ring(db)
  const before = db.prepare('SELECT total_changes() n').get().n
  blockerReport(db, { accountId: 'all', from, to: now, now })
  tickEntryEvaluation(db, { accountId: 'all', from, to: now, now })
  entryDiagnostics(db, { now })
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  const prepare = db.prepare
  db.prepare = () => { throw new Error('validation touched SQL') }
  try {
    assert.deepEqual(validateBlockerRequest({ accountId: '999', from, to: now, now }), { accountId: '999', from, to: now, limit: 50, offset: 0 }, 'registration is the worker\'s SQL read, not validation\'s')
    assert.throws(() => validateBlockerRequest({ accountId: undefined, from, to: now, now }), RangeError)
    assert.throws(() => validateBlockerRequest({ accountId: '11', from: now, to: now, now }), RangeError)
  } finally { db.prepare = prepare }
})

test('entry diagnostics: one bounded block per registry account, Node records only', t => {
  const { db, stop } = fixture(t)
  stop('stage_matrix')
  const d = entryDiagnostics(db, { now })
  assert.equal(d.complete, true, 'RED if a thrown readiness call (e.g. a number where a Date is needed) leaves it permanently unavailable')
  assert.equal(d.source, 'node_records')
  assert.deepEqual(d.accounts.map(a => a.accountId), ['11', '22'])
  const [a] = d.accounts
  assert.deepEqual(a.bases, ['bar']); assert.equal(a.tick.status, 'not_evaluated'); assert.equal(a.tick.checks.profile_pinned.ok, false)
  assert.deepEqual(a.dominantRefusal && [a.dominantRefusal.stage, a.dominantRefusal.records], ['stage_matrix', 1])
  assert.equal(a.entryStopsInWindow, 1)
  assert.equal(d.accounts[1].dominantRefusal, null)
})
