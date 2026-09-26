import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initDB, setState } from '../db.js'
import { blockerReport, tickEntryEvaluation, validateBlockerRequest, entryDiagnostics, TICK_EVIDENCE_CHECKS, verifiedOffEverywhere, preFixLabel, offEverywhereLedger, offEverywhereLabel, BLOCKER_DAYS_MAX_BYTES, FOLDED_LINES_PER_DAY_MAX } from './blocker-report.js'
import { engineStatusFor, writeEngineStatus } from './entry-mode.js'
import { recordTickEntryWork } from './tick-entry-work.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { recordDecision } from './decision-log.js'
import { entryActivityBlocker } from './scanner-work.js'
import { recordArmingChange } from './arming-log.js'

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
  // V3 WEB-1: regime_block has only the roster-level writer, so a row stored
  // against '11' is the old selected-account fallback — roster-wide, not
  // account 11's. The boundary checks run on the all-accounts population.
  const own = read()
  assert.equal(own.summary.upstream_stop.records, 2, 'regime_block is not charged to account 11')
  assert.equal(own.rosterWide.summary.upstream_stop.records, 1)
  const r = read({ accountId: 'all' })
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

// ---------------------------------------------------------------------------
// V3 WEB-1 (8,989-A row 2): upstream stops recorded against the right account.
// Production 25-09, 24 h: all 9,970 upstream stops on the SELECTED account
// 46130058 and 0 on every other one, because recordDecision stamped every
// unnamed account with getState('ctrader_account_id'). The rows below are
// written through the real writer with an account selected, then dated into
// the fixture window.
// ---------------------------------------------------------------------------
function attributionFixture(t) {
  const f = fixture(t)
  setState(f.db, 'ctrader_account_id', '11')
  const put = row => {
    recordDecision(f.db, { decision: 'skip', reason: 'recorded reason', ...row })
    f.db.prepare("UPDATE decision_log SET created_at = '2026-09-22 11:30:00' WHERE id = last_insert_rowid()").run()
  }
  // roster-level writers name no account (loop.js)
  put({ symbol: 'EURUSD', stage: 'armed_scope_prefilter' })
  put({ symbol: 'GBPUSD', stage: 'stage_matrix', strategy: 'vwap_trend' })
  put({ symbol: 'USDJPY', stage: 'horizon' })
  // the per-account stage gate names its account
  put({ accountId: '22', symbol: 'EURUSD', stage: 'stage_matrix', strategy: 'vwap_trend' })
  // a management row with no account: unattributed, not roster-wide
  put({ symbol: 'XAUUSD', stage: 'fast_monitor' })
  // history: the pre-fix fallback stored a roster stop against the selected account
  f.stop('armed_scope_prefilter', '11')
  return f
}

test('V3 WEB-1: roster-wide stops appear under EVERY account, labelled, and are charged to none — not to the selected account', t => {
  const { db, read } = attributionFixture(t)
  const stored = db.prepare('SELECT account_id FROM decision_log ORDER BY id').all()
  assert.deepEqual(stored.map(r => r.account_id), [null, null, null, '22', null, '11'], 'RED if the writer stamps the selected account 11 again')
  for (const id of ['11', '22']) {
    const r = read({ accountId: id })
    assert.equal(r.rosterWide.records, 4, `the same roster-wide stops under account ${id}`)
    assert.equal(r.rosterWide.entryStops, 4)
    assert.equal(r.rosterWide.includedInTotals, false)
    assert.equal(r.rosterWide.recordedAgainstAnAccount, 1, 'the pre-fix row stamped 11 is roster-wide and SAID to have been stored against an account')
    assert.deepEqual(r.rosterWide.byStage.map(s => [s.stage, s.records]), [['armed_scope_prefilter', 2], ['horizon', 1], ['stage_matrix', 1]])
    assert.equal(r.unattributedRecordsInWindow, 1, 'only the fast_monitor row is unattributed; a roster stop is attributed to the roster')
  }
  const selected = read({ accountId: '11' })
  assert.equal(selected.summary.upstream_stop.records, 0, 'RED if the roster stops (or the relabelled history) are charged to the selected account')
  assert.equal(selected.records.length, 0)
  const other = read({ accountId: '22' })
  assert.equal(other.summary.upstream_stop.records, 1, 'account 22 keeps its own per-account stage gate stop')
  assert.equal(other.records[0].attribution, 'account'); assert.equal(other.records[0].unsplitHistory, false)
  const all = read({ accountId: 'all' })
  assert.equal(all.summary.upstream_stop.records, 5, 'the all-accounts totals count every retained record once')
  assert.equal(all.rosterWide.includedInTotals, true)
  assert.equal(all.perAccount.some(p => p.accountId === '11'), false, 'no count is charged to 11')
  assert.deepEqual(all.perAccount.filter(p => p.scope === 'roster').map(p => [p.accountId, p.kind, p.records]), [[null, 'upstream_stop', 4]])
  assert.deepEqual(all.byStage.filter(s => s.scope === 'roster').map(s => [s.accountId, s.stage, s.records]),
    [[null, 'armed_scope_prefilter', 2], [null, 'horizon', 1], [null, 'stage_matrix', 1]])
  const history = all.records.find(r => r.attribution === 'roster' && r.storedAccountId === '11')
  assert.equal(history.accountId, null); assert.equal(history.stage, 'armed_scope_prefilter')
  assert.equal(db.prepare('SELECT account_id FROM decision_log WHERE id = ?').get(history.id).account_id, '11', 'the read relabels; it never rewrites or deletes the stored row')
})

test('V3 WEB-1: pre-fix stage_matrix and lesson_decay rows cannot be split — counted as recorded, and said so; marked rows are not flagged', t => {
  const { db, stop, read } = fixture(t)
  stop('stage_matrix', '11'); stop('lesson_decay', '11')
  recordDecision(db, { accountId: '11', symbol: 'EURUSD', stage: 'stage_matrix', decision: 'skip', reason: 'off on 11' })
  db.prepare("UPDATE decision_log SET created_at = '2026-09-22 11:40:00' WHERE id = last_insert_rowid()").run()
  const r = read()
  assert.equal(r.summary.upstream_stop.records, 3, 'nothing is silently moved out of the account')
  assert.equal(r.unsplitRecordsInWindow, 2, 'RED if the attribution mark is ignored (3) or unmarked history is not flagged (0)')
  assert.match(r.unsplitNote, /cannot be split/)
  assert.deepEqual(r.records.map(x => [x.stage, x.unsplitHistory]).sort(), [['lesson_decay', true], ['stage_matrix', false], ['stage_matrix', true]])
  assert.deepEqual(r.byStage.map(s => [s.stage, s.records, s.unsplitRecords]), [['stage_matrix', 2, 1], ['lesson_decay', 1, 1]])
  assert.equal(r.rosterWide.records, 0, 'a stage_matrix row WITH an account is never roster-wide')
})

test('V3 WEB-1: entry diagnostics carry the roster-wide stops once, beside the accounts, never inside an account\'s count', t => {
  const { db } = attributionFixture(t)
  const d = entryDiagnostics(db, { now })
  assert.equal(d.complete, true)
  assert.deepEqual(d.accounts.map(a => [a.accountId, a.entryStopsInWindow]), [['11', 0], ['22', 1]], 'RED if the roster stops land on the selected account 11')
  assert.equal(d.rosterWide.entryStopsInWindow, 4)
  assert.equal(d.rosterWide.dominantStop.stage, 'armed_scope_prefilter'); assert.equal(d.rosterWide.dominantStop.records, 2)
})

test('V3 WEB-1: the no_orders blocker line names the roster-wide stop when the account has none of its own; unchanged without roster stops', t => {
  const { db, read } = attributionFixture(t)
  assert.equal(entryActivityBlocker(read({ accountId: '11' })),
    'no_recorded_entry_stop_since_session_open; roster-wide (every account): armed_scope_prefilter ×2 of 4')
  assert.equal(entryActivityBlocker(read({ accountId: '22' })),
    'stage_matrix ×1 of 1 entry stops since session open; latest stage_matrix: recorded reason; roster-wide (every account): armed_scope_prefilter ×2 of 4')
  db.prepare("DELETE FROM decision_log WHERE stage IN ('armed_scope_prefilter', 'horizon') OR (stage = 'stage_matrix' AND account_id IS NULL)").run()
  assert.equal(entryActivityBlocker(read({ accountId: '11' })), 'no_recorded_entry_stop_since_session_open')
})

// ---------------------------------------------------------------------------
// V3 UI-3 (26-09 plan §8 item 3): day-grouped, folded blockers with server
// grouping. `timeZone` is opt-in — every test above calls `read()` (the
// fixture's helper) without it and gets the unchanged report; these tests
// pass it explicitly.
// ---------------------------------------------------------------------------

test('UI-3: day totals equal totalRecords, in both an account scope and the all-accounts scope', t => {
  const { risk, stop, read } = fixture(t)
  stop('armed_scope_prefilter') // ROSTER_ONLY: roster-wide regardless of the stored account — excluded from an account scope's own totals
  risk('11', 'a', 0); risk('11', 'a', 0); risk('11', 'b', 0)
  risk('22', 'c', 0)
  const own = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  const ownDayTotal = own.days.reduce((n, d) => n + d.totalRecords, 0)
  assert.equal(ownDayTotal, own.totalRecords)
  assert.equal(own.totalRecords, 3, 'the roster-wide stop is not this account\'s')
  const all = read({ accountId: 'all', timeZone: 'Asia/Singapore' })
  const allDayTotal = all.days.reduce((n, d) => n + d.totalRecords, 0)
  assert.equal(allDayTotal, all.totalRecords)
  assert.equal(all.totalRecords, 5)
})

test('UI-3: account and roster-wide rows never fold together even when every other field matches', t => {
  const { db, read } = fixture(t)
  // SAME stage (stage_matrix is in ROSTER_STAGES, not ROSTER_ONLY_STAGES, so
  // its roster-vs-account split turns on account_id alone, not on the stage
  // differing) — same symbol/timeframe/strategy/reason too; one roster-wide
  // (no account), one on account 11 — must stay two distinct folded entries.
  // (Checker, W1.3 blocker 4: the earlier version of this test paired
  // armed_scope_prefilter with stage_matrix, so the stage alone — a
  // ROSTER_ONLY stage always reads as roster — kept the rows apart and the
  // test could not have caught a broken attribution/accountId discriminator.)
  db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES (NULL,'EURUSD','stage_matrix','skip','same text','2026-09-22 11:30:00')").run()
  db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES ('11','EURUSD','stage_matrix','skip','same text','2026-09-22 11:31:00')").run()
  const all = read({ accountId: 'all', timeZone: 'Asia/Singapore' })
  const day = all.days.find(d => d.totalRecords > 0)
  assert.ok(day, 'a day with folded records exists')
  const scopes = day.folded.map(f => f.sample.attribution).sort()
  assert.deepEqual(scopes, ['account', 'roster'], 'RED if the two rows folded into one bucket')
})

// ---------------------------------------------------------------------------
// W1.3 fix round, BLOCKER 2: in the all-accounts scope, `records` already
// includes the roster-wide rows (population(false) runs decisionArm with no
// roster filter) — dayGroupedView must not ALSO list them as standing lines,
// which would count them (in the day total, and in totalRecords) twice and
// list the same stop in both `folded` and `standing`.
// ---------------------------------------------------------------------------
test('UI-3 fix round (blocker 2): an all-scope day carries roster-wide stops in `folded` only — never also as standing, never double-counted', t => {
  const { db, read } = fixture(t)
  db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES (NULL,'EURUSD','armed_scope_prefilter','skip','no armed timeframe','2026-09-22 11:30:00')").run()
  const all = read({ accountId: 'all', timeZone: 'Asia/Singapore' })
  const day = all.days.find(d => d.totalRecords > 0)
  assert.ok(day, 'a day with folded records exists')
  assert.equal(day.standing.length, 0, 'RED if the all scope also lists the roster stop as a standing line')
  assert.equal(day.folded.length, 1)
  assert.equal(day.folded[0].sample.attribution, 'roster')
  assert.equal(day.totalRecords, 1, 'RED if the same roster row is counted once in folded and again in standing')
  assert.equal(all.totalRecords, 1)
  // The account scope, by contrast, keeps showing it as a standing line —
  // the row is genuinely excluded from an account's own population.
  const own = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  const ownDay = own.days.find(d => d.standing.length > 0)
  assert.ok(ownDay, 'the account scope still carries the roster stop as a standing line')
  assert.equal(ownDay.folded.length, 0)
})

test('UI-3: an invalid time zone is refused with a RangeError, not silently treated as UTC or the default', t => {
  const { read } = fixture(t)
  assert.throws(() => validateBlockerRequest({ accountId: '11', from, to: now, now, timeZone: 'Not/AZone' }), RangeError)
  assert.throws(() => read({ timeZone: 'Mars/Colony' }), RangeError)
  // Omitting it entirely stays the old, ungrouped shape — no zone default is invented.
  assert.deepEqual(validateBlockerRequest({ accountId: '11', from, to: now, now }), { accountId: '11', from, to: now, limit: 50, offset: 0 })
})

test('UI-3: a roster-only scope shows standing lines for a day with no folded records of its own', t => {
  const { db, read } = fixture(t)
  // Account 11 has NOTHING on this day; only a roster-wide stop fires.
  db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES (NULL,'EURUSD','armed_scope_prefilter','skip','no armed timeframe','2026-09-22 11:30:00')").run()
  const own = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  assert.equal(own.totalRecords, 0)
  assert.equal(own.days.length, 1, 'the day is not silently dropped for reading zero folded records')
  const [day] = own.days
  assert.equal(day.totalRecords, 0)
  assert.equal(day.folded.length, 0)
  assert.equal(day.standing.length, 1)
  assert.equal(day.standing[0].count, 1)
  assert.equal(day.standing[0].sample.stage, 'armed_scope_prefilter')
})

// ---------------------------------------------------------------------------
// W1.3 fix round, BLOCKER 3: the fold used to count RECORDS but read
// firstAt/lastAt from `created_at` only, ignoring each retained record's own
// repeat_count/last_at (risk_events dedupes repeated identical refusals onto
// one row and bumps those two columns). `count` must stay records (so it
// still reconciles with totalRecords); `evaluations` is the new field that
// carries the repeat_count sum, and `lastAt` must reach the row's own
// last_at, not stop at created_at.
// ---------------------------------------------------------------------------
test('UI-3 fix round (blocker 3): a single retained record with repeat_count keeps count at 1, sums evaluations, and reports its own last_at', t => {
  const { db, read } = fixture(t)
  db.prepare(`INSERT INTO risk_events (account_id,symbol,approved,veto_reason,checks_json,created_at,last_at,repeat_count)
    VALUES ('11','EURUSD',0,'tp_required','{}','2026-09-22 11:10:00','2026-09-22 11:50:00',40)`).run()
  const r = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  assert.equal(r.totalRecords, 1, 'one retained record, whatever its repeat_count')
  const day = r.days.find(d => d.totalRecords > 0)
  assert.equal(day.folded.length, 1)
  const [fold] = day.folded
  assert.equal(fold.count, 1, 'RED if count is inflated by repeat_count instead of counting retained records')
  assert.equal(fold.evaluations, 40, 'RED if repeat_count is ignored')
  assert.equal(fold.firstAt, '2026-09-22T11:10:00.000Z')
  assert.equal(fold.lastAt, '2026-09-22T11:50:00.000Z', 'RED if lastAt stops at created_at instead of the row\'s own last_at')
})

test('UI-3 fix round (blocker 3): two folded records sum their evaluations and the range reaches the newer row\'s own last_at', t => {
  const { db, read } = fixture(t)
  db.prepare(`INSERT INTO risk_events (account_id,symbol,approved,veto_reason,checks_json,created_at,last_at,repeat_count)
    VALUES ('11','EURUSD',0,'tp_required','{}','2026-09-22 11:10:00','2026-09-22 11:12:00',5)`).run()
  db.prepare(`INSERT INTO risk_events (account_id,symbol,approved,veto_reason,checks_json,created_at,last_at,repeat_count)
    VALUES ('11','EURUSD',0,'tp_required','{}','2026-09-22 11:20:00','2026-09-22 11:45:00',3)`).run()
  const r = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  assert.equal(r.totalRecords, 2)
  const [fold] = r.days.find(d => d.totalRecords > 0).folded
  assert.equal(fold.count, 2, 'two retained records folded into one line')
  assert.equal(fold.evaluations, 8, 'RED if evaluations is not the sum of each record\'s repeat_count')
  assert.equal(fold.firstAt, '2026-09-22T11:10:00.000Z')
  assert.equal(fold.lastAt, '2026-09-22T11:45:00.000Z', 'RED if the newer record\'s own last_at is not what sets the range end')
})

test('UI-3: a pre-fix row (before any arming-log evidence) reads "cannot be split"; verified off-everywhere reads "all-accounts check"', t => {
  const { db, stop, read } = fixture(t)
  // The pre-#1115 shape: stage_matrix recorded WITH an account, but the
  // attribution mark absent (unsplitHistory === true) — same raw-insert
  // shape (no detail_json) as the existing "cannot be split" test above,
  // which is what an unmarked, pre-#1115 row actually looked like.
  stop('stage_matrix', '11')
  db.prepare("UPDATE decision_log SET strategy = 'fib_confluence', created_at = '2026-09-20 02:00:00' WHERE id = last_insert_rowid()").run()
  // No arming_log rows exist at all yet: the ledger cannot verify anything
  // this far back ("the log starts on 17-09" — but even so, nothing was ever
  // written for this strategy), so the badge must default to unverified.
  // The fixture's own window ends at now-1h; widen it here to reach the
  // pre-fix row's actual (much earlier) timestamp.
  const wideFrom = Date.parse('2026-09-20T00:00:00Z')
  let r = read({ accountId: '11', timeZone: 'Asia/Singapore', from: wideFrom })
  let entry = r.days.flatMap(d => d.folded).find(f => f.sample.stage === 'stage_matrix')
  assert.equal(entry.preFixLabel, 'cannot be split (before #1115)')
  assert.equal(verifiedOffEverywhere(db, 'fib_confluence', '2026-09-20T02:00:00.000Z'), false)
  // Now every registered account (11 and 22) is recorded OFF before that
  // time: the ledger CAN verify it, and the badge upgrades.
  for (const acct of ['11', '22']) {
    recordArmingChange(db, { scope: acct, kind: 'strategy', key: 'fib_confluence', stage: 'trade', from: true, to: false, actor: 'owner_route', reason: 'retire the intraday paths' })
    db.prepare("UPDATE arming_log SET at = '2026-09-20 01:00:00' WHERE id = last_insert_rowid()").run()
  }
  assert.equal(verifiedOffEverywhere(db, 'fib_confluence', '2026-09-20T02:00:00.000Z'), true)
  r = read({ accountId: '11', timeZone: 'Asia/Singapore', from: wideFrom })
  entry = r.days.flatMap(d => d.folded).find(f => f.sample.stage === 'stage_matrix')
  assert.equal(entry.preFixLabel, 'all-accounts check')
  // A row with a clean (post-fix) attribution never gets a badge at all.
  assert.equal(preFixLabel(db, { unsplitHistory: false, strategy: 'fib_confluence', at: '2026-09-20 02:00:00' }), null)
})

// ---------------------------------------------------------------------------
// W1.3 fix round, BLOCKER 6 ("OFF since … — order", 26-09 plan §8 item 3 / §3
// "Strategy OFF"): built from the arming ledger, never a guess or an invented
// order number.
// ---------------------------------------------------------------------------
test('UI-3 fix round (blocker 6): a strategy off on every account reads its off-everywhere ledger line; a partly-off strategy names none', t => {
  const { db, stop, read } = fixture(t)
  assert.equal(offEverywhereLedger(db, 'fib_confluence'), null, 'no ledger rows at all yet')
  assert.equal(offEverywhereLabel(db, 'fib_confluence'), null)
  recordArmingChange(db, { scope: '11', kind: 'strategy', key: 'fib_confluence', stage: 'trade', from: true, to: false, actor: 'owner_route', reason: 'retire the intraday paths' })
  db.prepare("UPDATE arming_log SET at = '2026-09-20 01:00:00' WHERE id = last_insert_rowid()").run()
  assert.equal(offEverywhereLedger(db, 'fib_confluence'), null, 'account 22 has not switched off yet')
  recordArmingChange(db, { scope: '22', kind: 'strategy', key: 'fib_confluence', stage: 'trade', from: true, to: false, actor: 'edge_watchdog', reason: 'alpha decayed' })
  db.prepare("UPDATE arming_log SET at = '2026-09-20 03:51:00' WHERE id = last_insert_rowid()").run()
  const info = offEverywhereLedger(db, 'fib_confluence')
  assert.equal(info.since, '2026-09-20 03:51:00', 'RED if the EARLIEST switch is reported instead of the latest holdout')
  assert.equal(info.actor, 'edge_watchdog')
  assert.equal(offEverywhereLabel(db, 'fib_confluence'), 'OFF on every account since 20-09 03:51 UTC — alpha decayed')
  // Wired onto a folded row for that strategy.
  stop('stage_matrix', '11')
  db.prepare("UPDATE decision_log SET strategy = 'fib_confluence' WHERE id = last_insert_rowid()").run()
  const r = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  const entry = r.days.flatMap(d => d.folded).find(f => f.sample.stage === 'stage_matrix')
  assert.equal(entry.offSinceLabel, 'OFF on every account since 20-09 03:51 UTC — alpha decayed')
  // A strategy nobody has switched off carries no label.
  stop('margin_pool', '11')
  const other = read({ accountId: '11', timeZone: 'Asia/Singapore' }).days.flatMap(d => d.folded).find(f => f.sample.stage === 'margin_pool')
  assert.equal(other.offSinceLabel, null)
})

// ---------------------------------------------------------------------------
// W1.3 fix round, BLOCKER 7: the day-grouped view is bounded and returns an
// explicit incomplete result instead of a silently truncated or unbounded
// one; folded evidence is never built for a row beyond a day's fold-line cap,
// only counted.
// ---------------------------------------------------------------------------
test('UI-3 fix round (blocker 7): an oversized day-grouped view reports daysIncomplete and falls back to the paged flat records, not a silent truncation', t => {
  const { db, read } = fixture(t)
  const put = db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES ('11','stage_matrix','skip',?,?)")
  // Three days, each holding exactly FOLDED_LINES_PER_DAY_MAX distinct, long
  // reasons — every row gets its OWN fold line (none capped away), and each
  // line's own evidence (reason repeated in `reason` and
  // `firstBlocker.reason`, plus diagnosticNote) is heavy enough that three
  // full days of them exceeds BLOCKER_DAYS_MAX_BYTES.
  const longReason = i => `distinct reason ${i} `.padEnd(480, 'x')
  const wideFrom = Date.parse('2026-09-20T00:00:00Z')
  for (const day of ['2026-09-20', '2026-09-21', '2026-09-22']) {
    for (let i = 0; i < FOLDED_LINES_PER_DAY_MAX; i++) put.run(longReason(i), `${day} 11:30:00`)
  }
  const r = read({ accountId: '11', timeZone: 'Asia/Singapore', from: wideFrom })
  assert.equal(r.totalRecords, FOLDED_LINES_PER_DAY_MAX * 3)
  assert.equal(r.daysIncomplete, true, 'RED if the bound never trips on a window built to exceed it')
  assert.equal(r.days, null, 'an incomplete grouped view is not shipped partially — it falls back to null')
  assert.equal(r.records.length, r.limit, 'RED if the ungrouped fallback page is also skipped when grouping overflows')
})

test('UI-3 fix round (blocker 7): a day past its fold-line cap still counts every record in totalRecords, with the excess named as omitted', t => {
  const { db, read } = fixture(t)
  const put = db.prepare("INSERT INTO decision_log (account_id,stage,decision,reason,created_at) VALUES ('11','stage_matrix','skip',?,?)")
  const linesOverCap = FOLDED_LINES_PER_DAY_MAX + 10
  for (let i = 0; i < linesOverCap; i++) put.run(`distinct reason ${i}`, '2026-09-22 11:30:00')
  const r = read({ accountId: '11', timeZone: 'Asia/Singapore' })
  assert.equal(r.totalRecords, linesOverCap)
  const day = r.days.find(d => d.totalRecords > 0)
  assert.equal(day.totalRecords, linesOverCap, 'RED if rows beyond the fold cap stop being counted')
  assert.ok(day.folded.length <= FOLDED_LINES_PER_DAY_MAX, 'the rendered fold lines stay bounded')
  assert.equal(day.folded.length + day.omitted, linesOverCap, 'every record is either a rendered fold line or an explicitly counted omission')
  assert.ok(day.omitted > 0, 'RED if nothing was actually capped')
})

// ---------------------------------------------------------------------------
// W1-FU: production traces (26-09 UI plan §5) showed a real 72h all-accounts
// window of ~24,692 retained records exceeding BLOCKER_DAYS_MAX_BYTES while
// the 6h and 24h windows fit — the day-grouped cap (blocker 7's fix) was
// still too loose at the old FOLDED_LINES_PER_DAY_MAX (300). This reproduces
// that shape (many accounts/stages/symbols, and a reason that differs per
// record — the exact case the comment above already names) at ~25,000
// records over a 72h all-accounts window, and pins the tightened bound.
// ---------------------------------------------------------------------------
test('W1-FU: a realistic 72h all-accounts window of ~25,000 records fits the day-grouped byte bound', t => {
  const { db, read } = fixture(t)
  for (const id of ['33', '44', '55', '66', '77']) db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,0)').run(id)
  const ACCOUNTS = ['11', '22', '33', '44', '55', '66', '77']
  const STAGES = ['stage_matrix', 'margin_pool', 'horizon', 'cluster_conviction', 'equity_stop', 'watchlist_override', 'ratchet_gate']
  const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'BTCUSD', 'US500']
  const REASONS = ['no armed timeframe', 'below conviction floor', 'regime misaligned', 'margin insufficient', 'cluster cap reached', 'stale watchlist entry']
  const days = ['2026-09-21', '2026-09-22', '2026-09-23']
  const put = db.prepare('INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES (?,?,?,?,?,?)')
  const target = 25_000
  db.transaction(() => {
    for (let i = 0; i < target; i++) {
      const day = days[i % days.length]
      const hh = String(i % 24).padStart(2, '0'), mm = String((i * 7) % 60).padStart(2, '0')
      const acct = (i % 5 === 0) ? null : ACCOUNTS[i % ACCOUNTS.length]
      // The dynamic detail folded into the reason text — the exact shape the
      // fold-cap comment already warns about: "every row's reason differs".
      const reason = `${REASONS[i % REASONS.length]} (level ${(i % 60).toFixed(2)})`
      put.run(acct, SYMBOLS[i % SYMBOLS.length], STAGES[i % STAGES.length], 'skip', reason, `${day} ${hh}:${mm}:00`)
    }
  })()
  const wideFrom = Date.parse('2026-09-21T00:00:00Z')
  const r = read({ accountId: 'all', timeZone: 'Asia/Singapore', from: wideFrom, to: Date.parse('2026-09-24T00:00:00Z'), now: Date.parse('2026-09-24T00:00:00Z') })
  assert.equal(r.totalRecords, target, 'every generated row is retained')
  assert.equal(r.daysIncomplete, false, 'RED if the tightened cap still overflows this realistic window')
  assert.ok(r.days, 'the grouped view ships, not the null fallback')
  const daysTotal = r.days.reduce((n, d) => n + d.totalRecords, 0)
  assert.equal(daysTotal, target, 'the day-grouped totals still reconcile with totalRecords')
  const bytes = Buffer.byteLength(JSON.stringify(r.days))
  assert.ok(bytes <= BLOCKER_DAYS_MAX_BYTES, `RED if the grouped payload (${bytes} bytes) exceeds the byte bound`)
})

test('BLOCKER_DAYS_MAX_BYTES is a real, positive bound', () => {
  assert.ok(Number.isFinite(BLOCKER_DAYS_MAX_BYTES) && BLOCKER_DAYS_MAX_BYTES > 0)
})

// Mutation check (CLAUDE.md #1): confirm the fold key's discriminators are
// present in the source, then run the REAL module (imported, not
// reconstructed) with each one removed in turn on a temp copy, and confirm
// rows that must stay apart instead fold together — proving the tests above
// are pinned to this code, not coincidentally passing.
test('mutation check: the fold key\'s scope/attribution and pre-fix discriminators are load-bearing', async t => {
  const srcPath = fileURLToPath(new URL('./blocker-report.js', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')
  const MARKERS = [
    {
      name: 'unsplitHistory discriminator', pattern: /row\.unsplit \? 1 : 0/, replacement: '0',
      seed: db => {
        db.prepare("INSERT INTO decision_log (account_id,symbol,stage,strategy,decision,reason,created_at) VALUES ('11','EURUSD','stage_matrix','fib_confluence','skip','off on 11','2026-09-22 11:30:00')").run()
        recordDecision(db, { accountId: '11', symbol: 'EURUSD', stage: 'stage_matrix', strategy: 'fib_confluence', decision: 'skip', reason: 'off on 11' })
        db.prepare("UPDATE decision_log SET created_at = '2026-09-22 11:31:00' WHERE id = last_insert_rowid()").run()
      },
    },
    {
      name: 'reason discriminator', pattern: /row\.stage, text\(row\.reason\),/, replacement: 'row.stage,',
      seed: db => {
        db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES ('11','EURUSD','stage_matrix','skip','reason one','2026-09-22 11:30:00')").run()
        db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES ('11','EURUSD','stage_matrix','skip','reason two','2026-09-22 11:31:00')").run()
      },
    },
    // W1.3 checker (BLOCKER 4): the account/roster-wide test above used two
    // DIFFERENT stages, so a stage_matrix-vs-armed_scope_prefilter mismatch
    // alone kept the rows apart — the scope/accountId discriminator itself
    // was never exercised. This marker proves it independently, with every
    // OTHER fold-key field forced identical: same stage (`fast_monitor`,
    // deliberately NOT stage_matrix/lesson_decay, so the `unsplit` flag —
    // which requires an account — stays 0 for both rows and cannot itself be
    // the thing keeping them apart), same symbol/reason, no timeframe or
    // strategy on either. One row has no account (scope 'unattributed'), one
    // is on account 11 (scope 'account').
    {
      name: 'scope/accountId discriminator', pattern: /row\.scope, row\.account_id,/, replacement: 'undefined, undefined,',
      seed: db => {
        db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES (NULL,'EURUSD','fast_monitor','skip','same text','2026-09-22 11:30:00')").run()
        db.prepare("INSERT INTO decision_log (account_id,symbol,stage,decision,reason,created_at) VALUES ('11','EURUSD','fast_monitor','skip','same text','2026-09-22 11:31:00')").run()
      },
    },
  ]
  for (const { name, pattern, replacement, seed } of MARKERS) {
    const before = (src.match(new RegExp(pattern, 'g')) || []).length
    assert.equal(before, 1, `${name}: must be present exactly once before mutation`)
    const mutatedSrc = src.replace(pattern, replacement)
    const after = (mutatedSrc.match(new RegExp(pattern, 'g')) || []).length
    assert.equal(after, 0, `${name}: the mutation must actually remove it`)
    const mutantPath = srcPath.replace(/\.js$/, `.mutant-${name.replace(/\W+/g, '')}.test-tmp.js`)
    writeFileSync(mutantPath, mutatedSrc)
    t.after(() => { try { rmSync(mutantPath) } catch { /* already gone */ } })
    const { blockerReport: mutantReport } = await import(`${mutantPath}?t=${Date.now()}`)
    const db = initDB(':memory:'); t.after(() => db.close())
    for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,0)').run(id)
    seed(db)
    // 'all', not '11': the third marker needs a roster-wide (NULL-account)
    // row and an account-11 row in the SAME folded population, which only
    // the all-accounts scope's population includes together (an account
    // scope never pulls a NULL-account row into `folded` at all — it would
    // show as a standing line instead, a separate fold computation the
    // scope/accountId discriminator in `folded` cannot reach).
    const r = mutantReport(db, { accountId: 'all', from, to: now, now, timeZone: 'Asia/Singapore' })
    const day = r.days.find(d => d.totalRecords > 0)
    assert.equal(day.folded.length, 1, `RED if removing the ${name} still keeps the two rows apart — the mutation must actually merge them`)
  }
})

// V3 S-8: an UNKNOWN account calendar refuses the entry upstream of the risk
// gate. Its skip is an upstream stop, never "other".
test('S-8: a market_hours_unknown skip is an upstream stop for its own account', t => {
  const { stop, read } = fixture(t)
  stop('market_hours_unknown')
  const r = read()
  assert.equal(r.summary.upstream_stop.records, 1, 'RED if MARKET_HOURS_UNKNOWN_STAGE leaves UPSTREAM')
  assert.equal(r.summary.other_stop.records, 0)
  const row = r.records.find(x => x.stage === 'market_hours_unknown')
  assert.equal(row.kind, 'upstream_stop')
})
