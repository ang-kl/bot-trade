// node --test agent/services/veto-boundary.test.js
//
// THE VETO BOUNDARY (19-09-2026, owner principle 7): a veto is a refusal of a
// trade the bot would otherwise have taken. risk_events holds only
// per-proposal gate refusals; a cycle-stable, per-account refusal is a
// decision_log SKIP. Measured 18/19-09-2026: 1,235 of 1,235 risk_events
// vetoes in 24 h were the margin pool journaling every exhausted account
// every cycle under symbol 'PORTFOLIO', with nothing refused at the gate —
// and the veto goal read 0.996 for an idle gate.
//
// Every test here is behavioural: rows written, not source matched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  evaluateTrade, persistRiskEvent, DEFAULT_RISK_CONFIG,
  CYCLE_STABLE_REASONS, GATE_REDIRECT_STAGE, reasonHead, latestGateVerdict,
} from './risk.js'
import { pendingRefusals, scoreRefusedOpportunities, refusalCostReport } from './refusal-ledger.js'
import { journalMarginPoolState, resetMarginPoolJournal, MARGIN_POOL_STAGE } from './margin-pool-journal.js'
import { auditDecisions, LEGACY_PORTFOLIO_SYMBOL } from './decision-audit.js'
import { vetoBreakdown } from './veto-breakdown.js'
import { vetoGoal } from './goal-table.js'
import { DEFAULT_GOAL_TARGETS } from './goal-table.js'

const A = '33330001'
const B = '33330002'

function fresh() {
  const db = initDB(':memory:')
  for (const id of [A, B]) {
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
    setState(db, `acct:${id}:account_balance_usd`, '10000')
    setState(db, `acct:${id}:account_leverage`, '100')
  }
  setState(db, 'ctrader_account_id', A)
  resetMarginPoolJournal()
  return db
}
const riskRows = (db) => db.prepare(`SELECT symbol, veto_reason, account_id FROM risk_events ORDER BY id`).all()
const logRows = (db, stage) => db.prepare(`SELECT account_id, symbol, stage, decision, reason, detail_json, loop_id FROM decision_log WHERE stage = ? ORDER BY id`).all(stage)

const proposalFor = (account, over = {}) => ({
  symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0970, tp1: 1.1105,
  requestedVolume: 0.1, strategy: 'vwap_trend', timeframe: '1h', source: 'auto_signal',
  accountId: account, ...over,
})

function openPositionOn(db, account, symbol) {
  const tradeId = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES (?, 'BUY', 100, 0.1, 'open', datetime('now'), ?)
  `).run(symbol, account).lastInsertRowid
  db.prepare(`
    INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
    VALUES (?, ?, 'long', 100, 'active', ?)
  `).run(symbol, tradeId, account)
}
function closedToday(db, account, netPnl, minutesAgo = 5) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, volume, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('GBPUSD', 'BUY', 100, 99, 0.1, 'closed', datetime('now', '-2 hours'), datetime('now', ?), ?, ?)
  `).run(`-${minutesAgo} minutes`, netPnl, account)
}

// ---- (a) the boundary in persistRiskEvent ----------------------------------

test('(a) a cycle-stable head writes a decision_log skip and NO risk_events row; the marker says so', () => {
  const db = fresh()
  const r = persistRiskEvent(db, proposalFor(A), { approved: false, veto_reason: 'max_positions=5/5', checks: { open_positions: 5 } })
  assert.deepEqual(r, { redirected: true, head: 'max_positions' })
  assert.equal(riskRows(db).length, 0, 'a cycle-stable refusal is not a veto row')
  const rows = logRows(db, GATE_REDIRECT_STAGE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].account_id, A)
  assert.equal(rows[0].symbol, 'EURUSD')
  assert.equal(rows[0].decision, 'skip')
  assert.equal(rows[0].reason, 'max_positions')
  const detail = JSON.parse(rows[0].detail_json)
  assert.equal(detail.reason, 'max_positions=5/5', 'the full reason rides in detail')
  assert.equal(detail.checks.open_positions, 5)
})

test('(a) per-proposal heads still write risk_events and return a row id', () => {
  const db = fresh()
  for (const reason of ['bad_rr 1.20<3', 'sl_too_tight 0.010%<0.05%', 'symbol_position_cap 3/3 open', 'overexposed_USD=4', 'correlated_metals=3 cap=2 with=XAUUSD']) {
    const id = persistRiskEvent(db, proposalFor(A, { symbol: reason.slice(0, 6).toUpperCase() }), { approved: false, veto_reason: reason, checks: {} })
    assert.equal(typeof id, 'number', `${reason} → row id`)
  }
  assert.equal(riskRows(db).length, 5)
  assert.equal(logRows(db, GATE_REDIRECT_STAGE).length, 0)
})

test('(a) every listed head redirects; an approval never does', () => {
  const db = fresh()
  for (const head of CYCLE_STABLE_REASONS) {
    const r = persistRiskEvent(db, proposalFor(A), { approved: false, veto_reason: `${head} x=1`, checks: {} })
    assert.equal(r?.redirected, true, head)
  }
  assert.equal(riskRows(db).length, 0)
  assert.equal(logRows(db, GATE_REDIRECT_STAGE).length, CYCLE_STABLE_REASONS.length)
  const ok = persistRiskEvent(db, proposalFor(A), { approved: true, adjusted_volume: 0.1, checks: {} })
  assert.equal(typeof ok, 'number')
  assert.ok(Object.isFrozen(CYCLE_STABLE_REASONS))
})

test('(a) reasonHead cuts at space, colon, "=" and "("', () => {
  assert.equal(reasonHead('unknown_daily_pnl (account): 2 closed'), 'unknown_daily_pnl')
  assert.equal(reasonHead('campaign_stop (test): down 12'), 'campaign_stop')
  assert.equal(reasonHead('max_positions=5/5'), 'max_positions')
  assert.equal(reasonHead('global_halt: unreadable'), 'global_halt')
  assert.equal(reasonHead('overexposed_USD=4'), 'overexposed_USD')
  assert.equal(reasonHead(null), '')
})

// ---- (b) the margin pool journals a state CHANGE, not a cycle -------------

const poolEntry = (accountId, exhausted, used = 900, cap = 800) => ({
  accountId, exhausted, status: { usedMargin: used, cap, headroom: cap - used, source: 'estimate' },
})

test('(b) one skip per account per state change: three exhausted cycles → 1 row; a flip → 2', () => {
  const db = fresh()
  for (const loop of [1, 2, 3]) journalMarginPoolState(db, [poolEntry(A, true), poolEntry(B, false)], { loopId: loop })
  let rows = logRows(db, MARGIN_POOL_STAGE)
  assert.equal(rows.length, 1, 'three cycles in the same state write one row')
  assert.equal(rows[0].account_id, A)
  assert.equal(rows[0].symbol, null, 'no symbol: the pool is per account')
  assert.equal(rows[0].decision, 'skip')
  assert.match(rows[0].reason, /^portfolio_margin_exhausted used=900\.00 cap=800\.00 source=estimate$/)
  assert.equal(rows[0].loop_id, 1)
  assert.equal(riskRows(db).length, 0, 'nothing in risk_events')

  // Recovery is the second transition; the not-exhausted account B never
  // transitioned and never wrote.
  journalMarginPoolState(db, [poolEntry(A, false, 100, 800), poolEntry(B, false)], { loopId: 4 })
  journalMarginPoolState(db, [poolEntry(A, false, 100, 800), poolEntry(B, false)], { loopId: 5 })
  rows = logRows(db, MARGIN_POOL_STAGE)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].decision, 'proceed')
  assert.match(rows[1].reason, /^portfolio_margin_recovered/)
  // And back again: a third row.
  journalMarginPoolState(db, [poolEntry(A, true), poolEntry(B, true)], { loopId: 6 })
  rows = logRows(db, MARGIN_POOL_STAGE)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.slice(2).map(r => r.account_id).sort(), [A, B])
})

test('(b) the journal resets on boot: the first exhausted reading after a reset is written once', () => {
  const db = fresh()
  journalMarginPoolState(db, [poolEntry(A, true)], { loopId: 1 })
  journalMarginPoolState(db, [poolEntry(A, true)], { loopId: 2 })
  resetMarginPoolJournal()
  journalMarginPoolState(db, [poolEntry(A, true)], { loopId: 3 })
  journalMarginPoolState(db, [poolEntry(A, true)], { loopId: 4 })
  assert.equal(logRows(db, MARGIN_POOL_STAGE).length, 2)
})

// ---- (c) the audit ignores legacy PORTFOLIO rows --------------------------

test('(c) decision-audit: legacy PORTFOLIO rows are neither vetoed nor reachedGate, and are counted as excluded', () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, repeat_count)
                          VALUES (?, '—', 0, ?, ?, ?, ?)`)
  const now = new Date().toISOString()
  ins.run(LEGACY_PORTFOLIO_SYMBOL, 'portfolio_margin_exhausted used=26266.06 cap=14383.37 source=estimate', A, now, 40)
  ins.run(LEGACY_PORTFOLIO_SYMBOL, 'portfolio_margin_exhausted used=1.00 cap=0.50 source=broker', B, now, 1)
  // One real gate refusal and one approval.
  persistRiskEvent(db, proposalFor(A), { approved: false, veto_reason: 'bad_rr 1.20<3', checks: {} })
  persistRiskEvent(db, proposalFor(A, { symbol: 'GBPUSD' }), { approved: true, adjusted_volume: 0.1, checks: {} })

  const a = auditDecisions(db, {})
  assert.equal(a.vetoed, 1)
  assert.equal(a.vetoedDistinct, 1)
  assert.equal(a.approved, 1)
  assert.equal(a.reachedGate, 2)
  assert.equal(a.legacyPortfolioRows, 41)
  assert.ok(!a.topVetoes.some(v => /portfolio_margin_exhausted/.test(v.key)), 'no legacy row in topVetoes')

  const vb = vetoBreakdown(db, { days: 1 })
  assert.equal(vb.summary.proposalsVetoed, 1)
  assert.equal(vb.summary.approvalRate, 50)
  assert.equal(vb.summary.legacyPortfolioRows, 41)
  const legacy = vb.guards.filter(g => g.source === 'upstream:margin_pool')
  assert.ok(legacy.length, 'legacy rows are shown under the pool\'s upstream stage')
  assert.equal(legacy.reduce((n, g) => n + g.count, 0), 41)
  assert.ok(!vb.guards.some(g => g.source === 'risk_gate' && /portfolio_margin_exhausted/.test(g.guard)))
})

test('(c) the veto goal reads the audit: 41 legacy rows do not make an idle gate read 0.99', async () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, repeat_count)
                          VALUES (?, '—', 0, ?, ?, ?, ?)`)
  ins.run(LEGACY_PORTFOLIO_SYMBOL, 'portfolio_margin_exhausted used=1 cap=0 source=estimate', A, new Date().toISOString(), 1235)
  const g = await vetoGoal(db, DEFAULT_GOAL_TARGETS)
  assert.equal(g.reachedGate, 0)
  assert.equal(g.verdict, 'not_measurable', 'below the vetoMinReachedGate floor: nothing reached the gate')
})

// ---- (d) every cycle-stable guard evaluateTrade can trip is redirected ----
//
// Each fixture trips ONE guard through the real gate, persists the verdict
// through the real writer and asserts the redirect. A new cycle-stable veto
// that reaches risk_events lands here as a failure of the last test.

function tripAndPersist(db, proposal, cfg = DEFAULT_RISK_CONFIG, opts) {
  const r = evaluateTrade(db, proposal, cfg, opts)
  assert.equal(r.approved, false, `expected a veto, got approval (${JSON.stringify(r.checks).slice(0, 200)})`)
  const out = persistRiskEvent(db, proposal, r)
  return { r, out }
}

const tripped = new Set()

test('(d) max_positions → redirected', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxOpenPositions; i++) openPositionOn(db, A, `SYM${i}`)
  const { r, out } = tripAndPersist(db, proposalFor(A))
  assert.match(r.veto_reason, /^max_positions=/)
  assert.deepEqual(out, { redirected: true, head: 'max_positions' })
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) daily_loss_limit_hit → redirected', () => {
  const db = fresh()
  closedToday(db, A, -500)
  const { r, out } = tripAndPersist(db, proposalFor(A))
  assert.match(r.veto_reason, /^daily_loss_limit_hit/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) loss_streak_cooldown → redirected', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxConsecutiveLosses; i++) closedToday(db, A, -10)
  const { r, out } = tripAndPersist(db, proposalFor(A))
  assert.match(r.veto_reason, /^loss_streak_cooldown/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) balance_not_account_scoped → redirected', () => {
  const db = fresh()
  const C = '33330003'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(C, C)
  setState(db, 'account_balance_usd', '5000')
  const { r, out } = tripAndPersist(db, proposalFor(C))
  assert.match(r.veto_reason, /^balance_not_account_scoped/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) campaign_stop → redirected', () => {
  const db = fresh()
  closedToday(db, A, -50)
  const cfg = { ...DEFAULT_RISK_CONFIG, campaign: { maxDrawdownPct: 0.001, startEquity: 10000, startAt: '2020-01-01T00:00:00Z', label: 'test' } }
  const { r, out } = tripAndPersist(db, proposalFor(A), cfg)
  assert.match(r.veto_reason, /^campaign_stop/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) unknown_daily_pnl → redirected', () => {
  const db = fresh()
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, volume, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('GBPUSD', 'BUY', 100, 99, 0.1, 'closed', datetime('now', '-3 hours'), datetime('now', '-2 hours'), NULL, ?)
  `).run(A)
  const cfg = { ...DEFAULT_RISK_CONFIG, unknownPnl: { block: true, graceMin: 1, maxAgeMin: 100000, minAttempts: 1000 } }
  const { r, out } = tripAndPersist(db, proposalFor(A), cfg)
  assert.match(r.veto_reason, /^unknown_daily_pnl \(account\)/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) global_halt → redirected', () => {
  const db = fresh()
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))
  const { r, out } = tripAndPersist(db, proposalFor(A))
  assert.match(r.veto_reason, /^global_halt/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) portfolio_daily_loss → redirected', () => {
  const db = fresh()
  closedToday(db, A, -500)
  setState(db, 'global_guards_json', JSON.stringify({ portfolioDailyLossUsd: 100 }))
  const { r, out } = tripAndPersist(db, proposalFor(A))
  assert.match(r.veto_reason, /^portfolio_daily_loss/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) portfolio_position_cap → redirected', () => {
  const db = fresh()
  openPositionOn(db, A, 'AAA')
  openPositionOn(db, B, 'BBB')
  setState(db, 'global_guards_json', JSON.stringify({ maxTotalOpenPositions: 2 }))
  const { r, out } = tripAndPersist(db, proposalFor(A, { symbol: 'CCC' }))
  assert.match(r.veto_reason, /^portfolio_position_cap/)
  assert.equal(out.redirected, true)
  assert.equal(riskRows(db).length, 0)
  tripped.add(out.head)
})

test('(d) the per-proposal backstops are NOT redirected: overexposed and correlated depend on the proposal', () => {
  const db = fresh()
  // Four same-direction EUR legs already held; a fifth EURUSD long trips the
  // currency-exposure cap (maxCurrencyExposure default), which is a function
  // of THIS proposal's legs.
  const cfg = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 50, maxCurrencyExposure: 1 }
  openPositionOn(db, A, 'EURGBP')
  openPositionOn(db, A, 'EURJPY')
  const { r, out } = tripAndPersist(db, proposalFor(A, { symbol: 'EURCHF' }), cfg)
  assert.match(r.veto_reason, /^overexposed_/)
  assert.equal(typeof out, 'number', 'a per-proposal veto is a risk_events row')
  assert.equal(riskRows(db).length, 1)
})

test('(d) the list is exactly the guards the fixtures above trip, plus the margin pool (journaled by the loop, not the gate)', () => {
  const fromGate = [...tripped].sort()
  const expected = CYCLE_STABLE_REASONS.filter(h => h !== 'portfolio_margin_exhausted').sort()
  assert.deepEqual(fromGate, expected, 'every cycle-stable head evaluateTrade can emit has a fixture that proves the redirect')
})

// ---- checker round (19-09-2026): the ledger, the validation-fill read, PORTFOLIO clog

test('ledger: a redirected max_positions refusal with full levels is pending after its horizon and scored for forgone R', async () => {
  const db = fresh()
  // Three loops re-proposing the same setup; the pre-filter is not in this
  // path (pending-orders, closed-market limits and the manual routes call the
  // gate directly), so the gate's redirect is the only record.
  for (let i = 0; i < 3; i++) persistRiskEvent(db, proposalFor(A), { approved: false, veto_reason: 'max_positions=5/5', checks: {} })
  assert.equal(riskRows(db).length, 0)
  const now = Date.now()
  assert.equal(pendingRefusals(db, { nowMs: now }).filter(p => !p.unscorable).length, 0, 'the 1h horizon (2 days) has not elapsed')
  const far = now + 30 * 86_400_000
  const pend = pendingRefusals(db, { nowMs: far })
  assert.equal(pend.length, 1, 'three re-proposals are one opportunity')
  assert.equal(pend[0].symbol, 'EURUSD')
  assert.equal(pend[0].refusals, 3)
  assert.equal(pend[0].reasonKey, 'max_positions=<n>/5', 'scored under the FULL reason, keyed like the pre-boundary history')
  assert.equal(pend[0].unscorable, undefined, `levels carried: ${JSON.stringify(pend[0])}`)
  assert.deepEqual([pend[0].entry, pend[0].sl, pend[0].tp], [1.1, 1.097, 1.1105])
  // Bars after the refusal reach the target: +3.5R forgone.
  const H = 3600_000
  const fetchBars = async () => [[pend[0].firstMs + H, 1.1, 1.105, 1.099, 1.104, 0], [pend[0].firstMs + 2 * H, 1.104, 1.111, 1.103, 1.11, 0]]
  const r = await scoreRefusedOpportunities(db, fetchBars, { nowMs: far, maxPerCycle: 10 })
  assert.equal(r.scored, 1)
  const row = db.prepare(`SELECT * FROM refusal_scores`).get()
  assert.equal(row.outcome, 'target')
  assert.equal(row.reason_key, 'max_positions=<n>/5')
  assert.ok(row.r_reached > 3, `r_reached ${row.r_reached}`)
})

test('validation-fill read: after a redirected refusal the newest verdict is the refusal, not the older approval', () => {
  const db = fresh()
  const okId = persistRiskEvent(db, proposalFor(A, { symbol: 'XAUUSD' }), { approved: true, adjusted_volume: 0.1, checks: {} })
  assert.equal(typeof okId, 'number')
  // The raw read the route used to make: it returns the approval.
  assert.equal(db.prepare(`SELECT approved FROM risk_events WHERE symbol = ? ORDER BY id DESC LIMIT 1`).get('XAUUSD').approved, 1)
  // Make the redirect strictly newer than the approval's ISO stamp.
  db.prepare(`UPDATE risk_events SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), okId)
  persistRiskEvent(db, proposalFor(A, { symbol: 'XAUUSD' }), { approved: false, veto_reason: 'daily_loss_limit_hit pnl=-500.00 limit=400.00', checks: {} })
  const v = latestGateVerdict(db, { symbol: 'XAUUSD', accountId: A })
  assert.equal(v.source, GATE_REDIRECT_STAGE)
  assert.equal(v.approved, 0)
  assert.equal(v.veto_reason, 'daily_loss_limit_hit pnl=-500.00 limit=400.00', 'the full reason, not the head')
  // A per-proposal veto later is a risk_events row and wins by recency.
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-30 seconds')`).run()
  persistRiskEvent(db, proposalFor(A, { symbol: 'XAUUSD' }), { approved: false, veto_reason: 'bad_rr 1.20<3', checks: {} })
  const v2 = latestGateVerdict(db, { symbol: 'XAUUSD', accountId: A })
  assert.equal(v2.source, 'risk_events')
  assert.equal(v2.veto_reason, 'bad_rr 1.20<3')
  assert.equal(latestGateVerdict(db, { symbol: 'NOSUCH' }), null)
})

test('ledger: legacy PORTFOLIO rows are neither waiting nor scored; a real refusal still is', async () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, account_id, created_at, opportunity_key, proposal_json)
                          VALUES (?, '—', 0, 'portfolio_margin_exhausted used=1 cap=0 source=estimate', ?, ?, ?, ?)`)
  for (let i = 0; i < 20; i++) ins.run(LEGACY_PORTFOLIO_SYMBOL, A, new Date(Date.now() - i * 60_000).toISOString(), `${A}|PORTFOLIO|—|@${i}`, JSON.stringify({ symbol: 'PORTFOLIO', side: '—', accountId: A }))
  persistRiskEvent(db, proposalFor(A), { approved: false, veto_reason: 'bad_rr 1.20<3', checks: {} })
  assert.equal(refusalCostReport(db).waiting, 1, '20 legacy rows + 1 real refusal → 1 waiting')
  const far = Date.now() + 30 * 86_400_000
  assert.deepEqual(pendingRefusals(db, { nowMs: far }).map(p => p.symbol), ['EURUSD'])
  const r = await scoreRefusedOpportunities(db, async () => [], { nowMs: far, maxPerCycle: 50 })
  assert.equal(r.unscorable, 0, 'no unscorable rows written for legacy PORTFOLIO keys')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM refusal_scores WHERE symbol = ?`).get(LEGACY_PORTFOLIO_SYMBOL).n, 0)
  assert.equal(r.waiting, 0)
})
