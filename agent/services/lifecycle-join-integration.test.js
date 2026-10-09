// Codex · №12,808 · 2026-10-10; codex-footprint: lifecycle-approval-index.
// Synthetic populations only. Actual report builder, worker and file SQLite;
// the pre-index predicate is the semantic oracle, not a second indexed lookup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { RULES, JUDGE_HELPERS, CONTEXT_LIMIT, buildOrderLifecycle } from './order-lifecycle.js'
import { readOrderLifecycle } from './performance-populations.js'

const NOW = Date.parse('2026-10-10T00:00:00Z')
const AT = '2026-10-09T23:00:00.000Z'
const OLD = '2026-10-09T22:00:00.000Z'
const OPTIONS = { account: 'all', nowMs: NOW }
const pre03 = () => RULES.find(r => r.id === 'PRE-03')
const { blank, tsMs, acctOf, upper, dirOf } = JUDGE_HELPERS

// Exact PRE-03@1 predicate retained independently of the new index machinery.
function previousJudge(r, ctx) {
  const missing = []
  if (blank(r.symbol)) missing.push('symbol')
  if (r.volume == null) missing.push('volume')
  if (blank(r.order_type)) missing.push('order_type')
  if (r.basis === 'bar' && r.risk_event_id == null) {
    const at = tsMs(r.created_at)
    const found = !blank(r.symbol) && at != null && ctx.approvals.some(a => acctOf(a.account_id) === acctOf(r.account_id)
      && upper(a.symbol) === upper(r.symbol) && dirOf(a.side) === dirOf(r.side)
      && (tsMs(a.created_at) ?? -Infinity) <= at && (tsMs(a.created_at) ?? -Infinity) >= at - 5 * 60_000)
    if (!found) missing.push('risk_event_id')
  }
  return missing.length ? { missing, detail: `${r.id} ${r.producer_id ?? '?'} symbol_id=${r.symbol_id ?? 'NULL'} ${r.side ?? ''}` } : null
}

function fixture(t) {
  const db = initDB(join(tempDir('lifecycle-join-'), 'fixture.db'))
  t.after(() => db.close())
  return db
}

function insert(db, table, row) {
  const keys = Object.keys(row)
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
}

function approval(db, fields = {}) {
  return insert(db, 'risk_events', { account_id: '99001', symbol: 'SYNTHETIC', side: 'BUY', approved: 1,
    disposition: 'ordered', created_at: AT,
    proposal_json: JSON.stringify({ strategy: 'synthetic', direction_reason: 'fixture', entry: 100, sl: 99 }), ...fields })
}

function intent(db, id, fields = {}) {
  insert(db, 'entry_intents', { id, account_id: '99001', environment: 'demo', symbol: 'SYNTHETIC', symbol_id: 1,
    side: 'BUY', order_type: 'MARKET', volume: 1, producer_id: 'synthetic', basis: 'bar', mode_epoch: 0,
    permit_id: `permit-${id}`, permit_expires_at: AT, state: 'EXPIRED', created_at: AT, updated_at: AT, ...fields })
}

function oldReport(db, options) {
  const rule = pre03(), saved = rule.judge
  rule.judge = previousJudge
  try { return buildOrderLifecycle(db, options) } finally { rule.judge = saved }
}

function boundaryFixture(db) {
  const cases = [
    { id: 'at-intent', approvalAt: AT, expected: false },
    { id: 'at-five-min', approvalAt: '2026-10-09T22:55:00.000Z', expected: false },
    { id: 'too-old', approvalAt: '2026-10-09T22:54:59.999Z', expected: true },
    { id: 'future', approvalAt: '2026-10-09T23:00:00.001Z', expected: true },
    { id: 'invalid-approval', approvalAt: 'not-a-date', expected: true },
    { id: 'case-and-spaces', approvalAt: AT, approval: { account_id: ' 99001 ', symbol: '  mixed  ', side: 'long' }, intent: { symbol: 'MiXeD', side: '1' }, expected: false },
    { id: 'short-alias', approvalAt: AT, approval: { side: 'SHORT' }, intent: { side: '-1' }, expected: false },
    { id: 'unknown-directions', approvalAt: AT, approval: { side: null }, intent: { side: 'unknown' }, expected: false },
    { id: 'null-accounts', approvalAt: AT, approval: { account_id: null }, intent: { account_id: ' ' }, expected: false },
    { id: 'foreign-account', approvalAt: AT, approval: { account_id: '99002' }, expected: true },
    { id: 'foreign-side', approvalAt: AT, approval: { side: 'SELL' }, expected: true },
    { id: 'foreign-symbol', approvalAt: AT, approval: { symbol: 'OTHER' }, expected: true },
    { id: 'not-approved', approvalAt: AT, approval: { approved: 0 }, expected: true },
    { id: 'wrong-disposition', approvalAt: AT, approval: { disposition: 'vetoed' }, expected: true },
    { id: 'null-disposition', approvalAt: AT, approval: { disposition: null }, expected: false },
    { id: 'explicit-link', approvalAt: OLD, intent: { risk_event_id: 1 }, expected: false },
    { id: 'other-basis', approvalAt: OLD, intent: { basis: 'tick' }, expected: false },
    { id: 'blank-symbol', approvalAt: AT, intent: { symbol: ' ' }, expected: true },
    { id: 'missing-fields', approvalAt: AT, intent: { volume: null, order_type: null }, expected: true },
    { id: 'invalid-intent', approvalAt: AT, intent: { created_at: 'not-a-date' }, expected: null },
    { id: 'space-timestamp', approvalAt: '2026-10-09 22:58:00', expected: false },
    { id: 'offset-timestamp', approvalAt: '2026-10-09T23:58:00+01:00', expected: false },
  ]
  db.transaction(() => {
    for (const c of cases) {
      const symbol = c.id.toUpperCase()
      approval(db, { symbol, created_at: c.approvalAt, ...c.approval })
      intent(db, c.id, { symbol, ...c.intent })
    }
    // Ties and input order cannot hide the one matching timestamp.
    for (const at of [AT, OLD, AT, '2026-10-09T23:00:00.001Z']) approval(db, { symbol: 'TIES', created_at: at })
    intent(db, 'ties', { symbol: 'TIES' })
  })()
  return cases
}

test('indexed approval join preserves full reports, boundary verdicts, scopes, display filters and population caps', t => {
  const db = fixture(t), cases = boundaryFixture(db)
  const report = buildOrderLifecycle(db, { ...OPTIONS, rule: 'PRE-03', limit: 200 })
  const row = report.stages.pre_order.find(r => r.id === 'PRE-03')
  const defects = new Set(row.sample.map(r => r.subject.replace('intent:', '')))
  for (const c of cases) {
    if (c.expected != null) assert.equal(defects.has(c.id), c.expected, c.id)
  }
  assert.equal(defects.has('ties'), false)
  assert.equal(row.undated, 1)
  for (const extra of [{}, { account: '99001' }, { account: '99002' }, { rule: 'PRE-03', limit: 200 }, { populationLimit: 3 }]) {
    const options = { ...OPTIONS, ...extra }
    assert.deepEqual(buildOrderLifecycle(db, options), oldReport(db, options), JSON.stringify(extra))
  }
})

test('actual readonly report worker returns the same full report without management SQL', async t => {
  const db = fixture(t)
  boundaryFixture(db)
  const expected = oldReport(db, OPTIONS), prepare = db.prepare
  let calls = 0
  db.prepare = () => { calls++; throw Error('report SQL on management connection') }
  let actual
  try { actual = await readOrderLifecycle(db, OPTIONS) } finally { db.prepare = prepare }
  assert.equal(calls, 0)
  assert.deepEqual(actual, expected)
})

test('approval join work scales with retained approvals rather than approvals times missing links', t => {
  const db = fixture(t), approvals = 2_000, intents = 100
  db.transaction(() => {
    for (let i = 0; i < approvals; i++) approval(db, { created_at: OLD })
    for (let i = 0; i < intents; i++) intent(db, `scale-${i}`)
  })()
  const parse = Date.parse
  let approvalParses = 0, report
  Date.parse = function(value) { if (value === OLD) approvalParses++; return parse(value) }
  try { report = buildOrderLifecycle(db, OPTIONS) } finally { Date.parse = parse }
  assert.equal(report.rules.find(r => r.id === 'PRE-03').violations, intents)
  assert.ok(approvalParses <= approvals * 4, `approval timestamp parses ${approvalParses} exceed linear bound ${approvals * 4}`)
  t.diagnostic(`synthetic approvals=${approvals}, missing-links=${intents}, approval timestamp parses=${approvalParses}`)
})

test('the approval context cap still excludes a matching record beyond the retained prefix', t => {
  const db = fixture(t)
  db.transaction(() => {
    const statement = db.prepare(`INSERT INTO risk_events (account_id,symbol,side,approved,disposition,created_at,proposal_json)
      VALUES ('99001','CAP','BUY',1,'ordered',?,'{"strategy":"synthetic","direction_reason":"fixture"}')`)
    for (let i = 0; i < CONTEXT_LIMIT; i++) statement.run(OLD)
    statement.run(AT)
    intent(db, 'beyond-context', { symbol: 'CAP' })
  })()
  const options = { ...OPTIONS, rule: 'PRE-03', populationLimit: 1 }
  const actual = buildOrderLifecycle(db, options)
  const r = actual.rules.find(r => r.id === 'PRE-03')
  assert.equal(r.violations, 1)
  assert.equal(r.truncated, true)
  assert.deepEqual(actual, oldReport(db, options))
})

test('optional phase observer names every actual context/rule boundary and cannot change a report', t => {
  const db = fixture(t)
  boundaryFixture(db)
  const expected = buildOrderLifecycle(db, OPTIONS), events = []
  const observed = buildOrderLifecycle(db, OPTIONS, { onPhase(event) { events.push(event); throw Error('observer failure') } })
  assert.deepEqual(observed, expected)
  assert.deepEqual(events.slice(0, 2), [{ phase: 'context', edge: 'start' }, { phase: 'context', edge: 'end', ok: true }])
  const order = [...RULES.filter(r => r.id !== 'STK-07'), RULES.find(r => r.id === 'STK-07')]
  assert.deepEqual(events.slice(2), order.flatMap(r => [
    { phase: 'rule', ruleId: r.id, ruleVersion: r.version, edge: 'start' },
    { phase: 'rule', ruleId: r.id, ruleVersion: r.version, edge: 'end', ok: true },
  ]))
  assert.equal(events.length, 2 + RULES.length * 2)
})

test('phase observation preserves original context failures and rule unreadability', t => {
  const db = fixture(t), events = []
  const hooks = { onPhase(event) { events.push(event); throw Error('observer failure') } }
  db.exec('DROP TABLE refusal_scores')
  const report = buildOrderLifecycle(db, OPTIONS, hooks)
  assert.equal(report.rules.find(r => r.id === 'PRE-02').measurable, false)
  assert.match(report.stages.pre_order.find(r => r.id === 'PRE-02').error, /no such table/)
  db.exec('DROP TABLE trade_plans')
  events.length = 0
  assert.throws(() => buildOrderLifecycle(db, OPTIONS, hooks), /no such table: trade_plans/)
  assert.deepEqual(events, [{ phase: 'context', edge: 'start' }, { phase: 'context', edge: 'end', ok: false }])
})
