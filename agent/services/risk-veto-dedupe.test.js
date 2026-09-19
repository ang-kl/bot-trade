// node --test agent/services/risk-veto-dedupe.test.js
//
// PR-C (owner principle 7): a repeated veto on the same opportunity bumps
// its row's repeat_count instead of writing a new row, and every reader that
// counts vetoes sums repeat_count so totals stay comparable — with the row
// count reported beside them as `distinct`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { persistRiskEvent, persistPostApprovalVeto, mergeRepeatVeto, VETO_REPEAT_WINDOW_MS, fxDayOpenMs } from './risk.js'
import { auditDecisions } from './decision-audit.js'
import { vetoBreakdown } from './veto-breakdown.js'
import { buildDailyJournal, journalText, vetoLine } from './journal.js'
import { opportunityFunnel } from './opportunity-funnel.js'
import { pendingRefusals } from './refusal-ledger.js'
import { nextOpportunityKey, DEFAULT_GAP_MS } from './opportunity-identity.js'

const A = '22220001'
const P = (over = {}) => ({ symbol: 'EURUSD', side: 'BUY', strategy: 'vwap_trend', entry: 1.1, sl: 1.097, tp1: 1.11, accountId: A, ...over })

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', A)
  return db
}
const rows = (db) => db.prepare(`SELECT id, approved, veto_reason, repeat_count, last_at, opportunity_key, created_at FROM risk_events ORDER BY id`).all()

test('the migration: risk_events carries repeat_count (default 1) and last_at, additively', () => {
  const db = fresh()
  const cols = new Map(db.prepare(`PRAGMA table_info(risk_events)`).all().map(c => [c.name, c]))
  assert.ok(cols.has('repeat_count'))
  assert.equal(String(cols.get('repeat_count').dflt_value), '1')
  assert.equal(cols.get('repeat_count').notnull, 1)
  assert.ok(cols.has('last_at'))
  // A writer that does not know the column still produces a countable row.
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason) VALUES ('X', 'BUY', 0, 'anything')`).run()
  assert.equal(rows(db)[0].repeat_count, 1)
  assert.equal(rows(db)[0].last_at, null)
})

test('three identical vetoes on one opportunity → ONE row with repeat_count 3, the same id returned each time', () => {
  const db = fresh()
  const ids = [1, 2, 3].map(() => persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open', checks: {} }))
  assert.deepEqual(ids, [ids[0], ids[0], ids[0]])
  const r = rows(db)
  assert.equal(r.length, 1)
  assert.equal(r[0].repeat_count, 3)
  assert.ok(r[0].last_at, 'the newest sighting is stamped')
  assert.ok(r[0].opportunity_key)
})

test('the same guard with different live numbers is the same reason head — it merges', () => {
  const db = fresh()
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'sl_too_tight 0.010%<0.05%' })
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'sl_too_tight 0.012%<0.05%' })
  const r = rows(db)
  assert.equal(r.length, 1)
  assert.equal(r[0].repeat_count, 2)
  assert.match(r[0].veto_reason, /0\.010%/, 'the first sighting keeps its own words')
})

test('a changed reason head starts a second row', () => {
  const db = fresh()
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'bad_rr 1.20<3' })
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'bad_rr 1.20<3' })
  const r = rows(db)
  assert.equal(r.length, 2)
  assert.deepEqual(r.map(x => x.repeat_count), [1, 2])
})

test('an approval never merges — before or after a veto', () => {
  const db = fresh()
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  const ok1 = persistRiskEvent(db, P(), { approved: true, adjusted_volume: 0.1 })
  const ok2 = persistRiskEvent(db, P(), { approved: true, adjusted_volume: 0.1 })
  assert.notEqual(ok1, ok2, 'two approvals are two rows — each is the row a trade links to')
  // A veto after an approval is a new row too: the newest row is not a veto.
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  const r = rows(db)
  assert.equal(r.length, 4)
  assert.ok(r.every(x => x.repeat_count === 1))
})

test('a different opportunity (other account, symbol or side) is its own row', () => {
  const db = fresh()
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P({ accountId: '22220002' }), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P({ symbol: 'GBPUSD' }), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P({ side: 'SELL' }), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  assert.equal(rows(db).length, 4)
})

test('a row older than the window does not absorb a repeat; inside it does', () => {
  const db = fresh()
  const id = persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  const key = rows(db)[0].opportunity_key
  const first = Date.parse(rows(db)[0].created_at)
  assert.equal(mergeRepeatVeto(db, { opportunityKey: key, reason: 'symbol_position_cap 3/3 open', nowMs: first + VETO_REPEAT_WINDOW_MS + 1000 }), null)
  assert.equal(mergeRepeatVeto(db, { opportunityKey: key, reason: 'symbol_position_cap 3/3 open', nowMs: first + 1000 }), id)
  assert.equal(VETO_REPEAT_WINDOW_MS, 6 * 60 * 60 * 1000)
})

test('the opportunity gap rule reads the newest SIGHTING (last_at), so a merged stream keeps one key', () => {
  const db = fresh()
  const twoHoursAgo = new Date(Date.now() - 2 * 3600e3).toISOString()
  const key = `${A}|EURUSD|BUY|VWAP_TREND@${Date.now() - 2 * 3600e3}`
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, opportunity_key, repeat_count, last_at)
              VALUES ('EURUSD', 'BUY', 0, 'max_positions=5/5', ?, ?, ?, 9, ?)`).run(A, twoHoursAgo, key, new Date().toISOString())
  const next = nextOpportunityKey(db, P(), { accountId: A })
  assert.equal(next.isNew, false, `created_at is ${2 * 3600e3 / DEFAULT_GAP_MS}x the gap — only last_at keeps the key`)
  assert.equal(next.key, key)
})

test('the audit: vetoed is the SUM of repeats and vetoedDistinct the row count; reachedGate uses the sum', () => {
  const db = fresh()
  for (let i = 0; i < 4; i++) persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P({ symbol: 'GBPUSD' }), { approved: false, veto_reason: 'bad_rr 1.20<3' })
  persistRiskEvent(db, P({ symbol: 'XAUUSD' }), { approved: true, adjusted_volume: 0.1 })
  const a = auditDecisions(db, { accountId: A })
  assert.equal(a.vetoed, 5)
  assert.equal(a.vetoedDistinct, 2)
  assert.equal(a.approved, 1)
  assert.equal(a.reachedGate, 6)
  assert.equal(a.topVetoes[0].key, 'symbol_position_cap 3/3 open')
  assert.equal(a.topVetoes[0].n, 4)
})

test('veto-breakdown, the journal, the funnel and the refusal ledger all count repeats, and say how many rows', () => {
  const db = fresh()
  for (let i = 0; i < 3; i++) persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  persistRiskEvent(db, P({ symbol: 'GBPUSD' }), { approved: true, adjusted_volume: 0.1 })

  const vb = vetoBreakdown(db, { days: 1 })
  assert.equal(vb.summary.proposalsVetoed, 3)
  assert.equal(vb.summary.proposalsVetoedDistinct, 1)
  assert.equal(vb.guards[0].count, 3)
  assert.equal(vb.guards[0].distinct, 1)

  const day = new Date().toISOString().slice(0, 10)
  const j = buildDailyJournal(db, day)
  assert.equal(j.vetoed, 3)
  assert.equal(j.vetoedDistinct, 1)
  assert.equal(j.vetoRate, 75)
  assert.equal(j.topVetoes[0].count, 3)
  assert.equal(vetoLine(j), 'vetoes: 3 (1 distinct, rate 75%)')
  assert.match(journalText(j), /Gate: 1 approved · vetoes: 3 \(1 distinct, rate 75%\)/)

  const f = opportunityFunnel(db, { days: 1 })
  assert.equal(f.funnel.opportunities, 2)
  assert.equal(f.evaluations, 4, '3 merged vetoes + 1 approval')

  const pr = pendingRefusals(db, { nowMs: Date.now() + 30 * 86_400_000 })
  assert.equal(pr.length, 1)
  assert.equal(pr[0].refusals, 3)
})

test('never across the FX day open: a repeat after 17:00 NY starts a new row even inside the window', () => {
  const db = fresh()
  const dayOpen = fxDayOpenMs(Date.now())
  const nowMs = dayOpen + 3 * 3600e3
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, opportunity_key) VALUES ('EURUSD','BUY',0,'max_positions=5/5',?,?,?)`)
  ins.run(A, new Date(dayOpen - 60_000).toISOString(), 'k-before')
  ins.run(A, new Date(dayOpen + 60_000).toISOString(), 'k-after')
  assert.equal(mergeRepeatVeto(db, { opportunityKey: 'k-before', reason: 'max_positions=5/5', nowMs }), null, 'first sighted before the day opened')
  assert.equal(typeof mergeRepeatVeto(db, { opportunityKey: 'k-after', reason: 'max_positions=5/5', nowMs }), 'number', 'same day, inside the window — merges')
})

test('a post-approval refusal never absorbs a gate veto (it resolves an approval; accountedFor must not inflate)', () => {
  const db = fresh()
  persistRiskEvent(db, P(), { approved: true, adjusted_volume: 0.1 })
  // The SAME reason string both times, so only the post_approval flag stands between them.
  persistPostApprovalVeto(db, P(), 'symbol_position_cap 3/3 open')
  persistRiskEvent(db, P(), { approved: false, veto_reason: 'symbol_position_cap 3/3 open' })
  const r = rows(db)
  assert.equal(r.length, 3)
  assert.ok(r.every(x => x.repeat_count === 1))
  const a = auditDecisions(db, { accountId: A })
  assert.equal(a.resolutions, 1)
  assert.equal(a.vetoed, 2)
})

test('max_positions merges on the FULL reason: 6/5 is an overrun and must not hide under the 5/5 row', () => {
  // THE VETO BOUNDARY (19-09-2026): max_positions is a cycle-stable head, so
  // persistRiskEvent redirects it to decision_log and never inserts it here
  // (veto-boundary.test.js). The overrun guard in mergeRepeatVeto still
  // protects any row that already exists, so it is exercised directly.
  const db = fresh()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, opportunity_key) VALUES ('EURUSD','BUY',0,?,?,?,?)`)
  const nowMs = fxDayOpenMs(Date.now()) + 3 * 3600e3
  ins.run('max_positions=5/5', A, new Date(nowMs - 60_000).toISOString(), 'k')
  assert.equal(typeof mergeRepeatVeto(db, { opportunityKey: 'k', reason: 'max_positions=5/5', nowMs }), 'number', 'same full reason merges')
  assert.equal(mergeRepeatVeto(db, { opportunityKey: 'k', reason: 'max_positions=6/5', nowMs }), null, 'an overrun never folds into the 5/5 row')
  assert.equal(rows(db)[0].repeat_count, 2)
})

test('the boundary: a cycle-stable head handed to persistRiskEvent is a decision_log skip, not a merged veto row', () => {
  const db = fresh()
  for (let i = 0; i < 3; i++) persistRiskEvent(db, P(), { approved: false, veto_reason: 'max_positions=5/5' })
  assert.equal(rows(db).length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decision_log WHERE stage = 'gate_redirect' AND reason = 'max_positions'`).get().n, 3)
})
