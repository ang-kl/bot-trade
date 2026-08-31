// node --test agent/services/earned-floor.test.js
//
// PR-C (owner "go PR-C", 2026-08-31): a strategy earns a floor below
// HARD_MIN_RR only by MEASURED rolling win rate, demo-only while staged, at
// reduced per-trade risk. The blanket 3.0 keeps governing everything that has
// not earned its way under it — these tests pin both directions, and the
// integration cases run the REAL risk gate end to end so the admit is proven
// where it matters, not on the helper alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { loadEarnedFloor, earnedFloorVerdict, earnedFloorReport, EARNED_FLOOR_DEFAULTS } from './earned-floor.js'
import { evaluateTrade } from './risk.js'

const DEMO = '111'
const LIVE = '222'

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  return db
}

/** n closed trades for a strategy: winRatePct% wins of +$30, rest -$10. */
function seedRecord(db, strategy, n, winRatePct) {
  const wins = Math.round(n * winRatePct / 100)
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at)
     VALUES ('GBPUSD','BUY','closed',?,?,?)`  // not the proposal's symbol — a loss on it would arm the symbol cooldown
  )
  for (let i = 0; i < n; i++) {
    ins.run(strategy, i < wins ? 30 : -10, new Date(Date.now() - (i + 1) * 60_000).toISOString())
  }
}

test('defaults: on, demo-only, half risk, 30-window/15-sample/0.15R — junk degrades to them', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadEarnedFloor(db), { ...EARNED_FLOOR_DEFAULTS })
  setState(db, 'earned_floor_json', '{"riskScale":"junk","window":-4')
  assert.deepEqual(loadEarnedFloor(db), { ...EARNED_FLOOR_DEFAULTS })
  setState(db, 'earned_floor_json', JSON.stringify({ riskScale: 0.25, minSample: 20 }))
  const cfg = loadEarnedFloor(db)
  assert.equal(cfg.riskScale, 0.25)
  assert.equal(cfg.minSample, 20)
  assert.equal(cfg.on, true)
})

test('verdict refuses: off, unlabelled, unknown account, live scope, thin sample, unpaying win rate', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 20, 70) // 70% over 20 — a record that WOULD earn
  const base = { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO }

  assert.equal(earnedFloorVerdict(db, { ...base, strategy: null }).reason, 'unlabelled_proposal')
  assert.equal(earnedFloorVerdict(db, { ...base, accountId: '999' }).reason, 'unattributable_account')
  assert.equal(earnedFloorVerdict(db, { ...base, accountId: null }).reason, 'unattributable_account')
  assert.equal(earnedFloorVerdict(db, { ...base, accountId: LIVE }).reason, 'live_scope')
  assert.match(earnedFloorVerdict(db, { ...base, strategy: 'rsi2_reversion' }).reason, /thin_sample 0<15/)

  // 40% at rr 1.6: E = 0.4×1.6 − 0.6 = 0.04R ≤ 0.15R — measured but unpaying.
  seedRecord(db, 'donchian_breakout', 20, 40)
  assert.match(earnedFloorVerdict(db, { ...base, strategy: 'donchian_breakout' }).reason, /expectancy 0\.04R/)

  setState(db, 'earned_floor_json', JSON.stringify({ on: false }))
  assert.equal(earnedFloorVerdict(db, base).reason, 'off')
})

test('verdict earns: 70% measured over 20 closes at rr 1.6 → E 0.82R, half risk', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 20, 70)
  const v = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO })
  assert.equal(v.ok, true)
  assert.equal(v.winRate, 70)
  assert.equal(v.trades, 20)
  assert.equal(v.e, 0.82)
  assert.equal(v.riskScale, 0.5)
})

// ---------------------------------------------------------------------------
// Integration — the REAL gate. A wiring nothing exercises is failure mode #4.
// ---------------------------------------------------------------------------

// EURUSD long, 30-pip SL, rr 1.6 — below HARD_MIN_RR 3, above the 1.5 floor.
function lowRrProposal(accountId) {
  return {
    symbol: 'EURUSD', side: 'long', entry: 1.1000, sl: 1.0970, tp1: 1.1048,
    requestedVolume: null, strategy: 'vwap_trend', conviction: 8, accountId,
  }
}

function armBalance(db, accountId, usd) {
  setState(db, `acct:${accountId}:account_balance_usd`, String(usd))
}

test('gate admits an earned-floor proposal on demo, stamps checks, halves the size', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 20, 70)
  armBalance(db, DEMO, 10_000)

  const res = evaluateTrade(db, lowRrProposal(DEMO))
  assert.equal(res.approved, true, `expected admit, got: ${res.veto_reason}`)
  assert.equal(res.checks.earned_floor.winRate, 70)
  assert.equal(res.checks.earned_floor.riskScale, 0.5)

  // Same book, riskScale 1 → the admitted size doubles: the scale is real.
  setState(db, 'earned_floor_json', JSON.stringify({ riskScale: 1 }))
  const full = evaluateTrade(db, lowRrProposal(DEMO))
  assert.equal(full.approved, true)
  assert.ok(
    Math.abs(full.checks.risk_based_volume - 2 * res.checks.risk_based_volume) <= 0.011,
    `half-risk sizing: ${res.checks.risk_based_volume} vs full ${full.checks.risk_based_volume}`,
  )
})

test('the checkpoint report measures the ADMITTED cohort via risk-event lineage', () => {
  const db = withAccounts(initDB(':memory:'))
  const empty = earnedFloorReport(db)
  assert.equal(empty.verdict, 'pending 0/30 closes')
  assert.deepEqual(empty.target, { closes: 30, minPf: 1.5 })

  // Two admitted approvals, one closed each way; one NON-cohort close that
  // must not leak in.
  const ev = db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json) VALUES ('EURUSD','BUY',1,?)`)
  const e1 = ev.run(JSON.stringify({ earned_floor: { rr: 1.6 } })).lastInsertRowid
  const e2 = ev.run(JSON.stringify({ earned_floor: { rr: 1.7 } })).lastInsertRowid
  const tr = db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, closed_at, risk_event_id) VALUES ('EURUSD','BUY','closed',?,datetime('now'),?)`)
  tr.run(60, e1)
  tr.run(-20, e2)
  tr.run(500, null) // not the cohort's
  const r = earnedFloorReport(db)
  assert.equal(r.admittedApprovals, 2)
  assert.equal(r.closedCohort.trades, 2)
  assert.equal(r.closedCohort.winRate, 50)
  assert.equal(r.closedCohort.profitFactor, 3)
  assert.equal(r.closedCohort.net, 40)
  assert.equal(r.verdict, 'pending 2/30 closes')
})

test('gate still vetoes: live account, thin record, and below the strategy\'s own floor', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 20, 70)
  armBalance(db, DEMO, 10_000)
  armBalance(db, LIVE, 10_000)

  const live = evaluateTrade(db, lowRrProposal(LIVE))
  assert.equal(live.approved, false)
  assert.match(live.veto_reason, /bad_rr/)
  assert.equal(live.checks.earned_floor_denied, 'live_scope')

  const thin = evaluateTrade(db, { ...lowRrProposal(DEMO), strategy: 'donchian_breakout' })
  assert.equal(thin.approved, false)
  assert.match(thin.veto_reason, /bad_rr/)
  assert.match(thin.checks.earned_floor_denied, /thin_sample/)

  // rr 1.2 is under vwap_trend's own 1.5 floor — the earned floor lowers the
  // blanket 3.0, never a strategy's declared minimum, so no verdict is even
  // consulted (no earned_floor_denied stamp).
  const under = evaluateTrade(db, { ...lowRrProposal(DEMO), tp1: 1.1036 })
  assert.equal(under.approved, false)
  assert.match(under.veto_reason, /bad_rr/)
  assert.equal(under.checks.earned_floor_denied, undefined)
})
