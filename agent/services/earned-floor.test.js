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
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { loadEarnedFloor, earnedFloorVerdict, earnedFloorReport, EARNED_FLOOR_DEFAULTS, EARNED_FLOOR_RR_BAND } from './earned-floor.js'
import { evaluateTrade, HARD_MIN_RR, persistRiskEvent } from './risk.js'

const DEMO = '111'
const LIVE = '222'
const DEMO2 = '333'

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO2}','3',0,1,'active')`).run()
  return db
}

/**
 * n closed trades for a strategy: winRatePct% wins of +$30, rest -$10.
 * Per-account, sub-floor band (02-09-2026): the record is stamped with the
 * account it belongs to and a PLANNED bracket under HARD_MIN_RR (entry 100,
 * sl 99, tp 101.6 → 1.6R) — the population the verdict admits. `rr` and
 * `accountId` let a test seed the OTHER populations that must NOT count.
 */
function seedRecord(db, strategy, n, winRatePct, { accountId = DEMO, rr = 1.6 } = {}) {
  const wins = Math.round(n * winRatePct / 100)
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id, entry_price, sl_price, tp_price)
     VALUES ('GBPUSD','BUY','closed',?,?,?,?,100,99,?)`  // not the proposal's symbol — a loss on it would arm the symbol cooldown
  )
  for (let i = 0; i < n; i++) {
    ins.run(strategy, i < wins ? 30 : -10, new Date(Date.now() - (i + 1) * 60_000).toISOString(), accountId, 100 + rr)
  }
}

test('the measured band is HARD_MIN_RR itself — pinned, since risk.js cannot be imported here without a cycle', () => {
  assert.equal(EARNED_FLOOR_RR_BAND, HARD_MIN_RR)
})

test('the record is PER ACCOUNT: another demo account\'s closes cannot earn this one\'s floor (02-09-2026)', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 20, 70, { accountId: DEMO2 }) // a record that WOULD earn — on the other account
  const other = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO })
  assert.equal(other.ok, false)
  assert.match(other.reason, /thin_sample 0<15/)
  // The account that owns the record earns on it; unscoped legacy rows
  // (account_id NULL) count for every account.
  assert.equal(earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO2 }).ok, true)
  seedRecord(db, 'ema_pullback', 20, 70, { accountId: null })
  assert.equal(earnedFloorVerdict(db, { strategy: 'ema_pullback', rr: 1.6, accountId: DEMO }).ok, true)
})

test('W is measured over the ADMITTED band only: closes planned at ≥3R do not count, nor closes with no bracket', () => {
  const db = withAccounts(initDB(':memory:'))
  // 20 wins at 3.5R — the pre-existing measurement, taken under the blanket
  // floor, that used to justify sub-3R entries. Not the band.
  seedRecord(db, 'vwap_trend', 20, 100, { rr: 3.5 })
  const above = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO })
  assert.equal(above.ok, false)
  assert.match(above.reason, /thin_sample 0<15/)
  // Exactly 3.0R is NOT below the floor either.
  seedRecord(db, 'vwap_trend', 5, 100, { rr: 3.0 })
  assert.match(earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO }).reason, /thin_sample 0<15/)
  // Rows with no planned bracket are unknowable, hence outside the band.
  db.prepare(`INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id) VALUES ('GBPUSD','BUY','closed','vwap_trend',30,datetime('now'),?)`).run(DEMO)
  assert.match(earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO }).reason, /thin_sample 0<15/)
  // 15 sub-floor closes at 40% W: measured (not thin) and, at rr 1.6, unpaying
  // — the 20 richer wins above are not blended in to rescue it.
  seedRecord(db, 'vwap_trend', 15, 40, { rr: 1.6 })
  const banded = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.6, accountId: DEMO })
  assert.equal(banded.trades, 15)
  assert.equal(banded.winRate, 40)
  assert.match(banded.reason, /expectancy 0\.04R/)
})

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

// ---------------------------------------------------------------------------
// Stage 2 (owner "go PR-C stage 2", 31-08 evening): live scope + full risk +
// relaxed thresholds, all via config the new route writes. The behavioural
// pin is the exact delta the order bought: a LIVE account with a measured
// record admits under the stage-2 config and is refused under stage-1
// defaults; unknown accounts fail closed under BOTH scopes (existing test
// pins the demoOnly side of that).
// ---------------------------------------------------------------------------
test('stage-2 config: a measured LIVE account admits at full risk; stage-1 defaults refuse it', () => {
  const db = withAccounts(initDB(':memory:'))
  seedRecord(db, 'vwap_trend', 12, 60, { accountId: LIVE }) // 12 closes at 60% W on the LIVE account — under stage-1's 15 sample
  armBalance(db, LIVE, 10_000)

  // Stage-1 defaults: refused twice over (live scope, thin sample).
  const s1 = evaluateTrade(db, lowRrProposal(LIVE))
  assert.equal(s1.approved, false)
  assert.equal(s1.checks.earned_floor_denied, 'live_scope')

  // Stage-2 config: demoOnly off, sample 10, minE 0.10, full risk.
  setState(db, 'earned_floor_json', JSON.stringify({ demoOnly: false, riskScale: 1.0, minSample: 10, minE: 0.10 }))
  const s2 = evaluateTrade(db, lowRrProposal(LIVE))
  // 60% W at rr 1.6 → E = 0.96 − 0.40 = 0.56R > 0.10R → admitted.
  assert.equal(s2.approved, true, `expected stage-2 admit, got: ${s2.veto_reason}`)
  assert.equal(s2.checks.earned_floor.riskScale, 1.0, 'full risk on admits')

  // Unknown account STILL fails closed with demoOnly off (the registry check
  // is unconditional — the scope widening must not widen it to nobody-knows).
  const ghost = evaluateTrade(db, { ...lowRrProposal('999'), accountId: '999' })
  assert.equal(ghost.approved, false)
  assert.equal(ghost.checks.earned_floor_denied, 'unattributable_account')
})

test('wiring pin: the owner has a route to the earned-floor dials', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.ok(src.includes("router.post('/earned-floor'"), 'POST /actions/earned-floor route missing')
  assert.ok(src.includes("setState(db, 'earned_floor_json'"), 'route must write earned_floor_json')
})

test('admittedApprovals counts DISTINCT opportunities; admitEvents keeps the raw approval count', () => {
  // Measured 01-09-2026 evening: the spread gate's retry loop re-approved
  // the same XPTUSD/NAS100 setups every cycle and a raw COUNT(*) climbed
  // 23 → 39 while the distinct setups barely moved. opportunity_key is the
  // dedupe primitive persistRiskEvent already stamps.
  const db = withAccounts(initDB(':memory:'))
  const ev = db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, opportunity_key) VALUES ('XPTUSD','BUY',1,?,?)`)
  const stamp = JSON.stringify({ earned_floor: { rr: 1.4 } })
  ev.run(stamp, 'A|XPTUSD|BUY|DONCHIAN@1')   // one setup, re-approved three times
  ev.run(stamp, 'A|XPTUSD|BUY|DONCHIAN@1')
  ev.run(stamp, 'A|XPTUSD|BUY|DONCHIAN@1')
  ev.run(stamp, 'A|XPTUSD|BUY|DONCHIAN@2')   // a second, distinct opportunity
  ev.run(stamp, null)                          // unkeyed (pre-migration) row counts one-per-row
  // A non-admit approval must not count in either unit.
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, opportunity_key) VALUES ('EURUSD','BUY',1,'{}','B|EURUSD|BUY|X@1')`).run()
  const r = earnedFloorReport(db)
  assert.equal(r.admitEvents, 5, 'raw approval events')
  assert.equal(r.admittedApprovals, 3, 'distinct opportunities: shared-key group + distinct key + unkeyed row')
})

// ---------------------------------------------------------------------------
// The PRIOR REPORT (owner order, 02-09-2026: "build the earned floor prior as
// report"). Report only: the gate's verdict must not move because of it.
// ---------------------------------------------------------------------------
import { earnedFloorPriorReport, EARNED_FLOOR_PRIOR_TRADES } from './earned-floor.js'
import { SHRINK_PRIOR_TRADES } from './strategy-autopilot.js'

test('prior report: live sub-floor W shrunk toward the sweep backtest W with k phantom trades, expectancy per rr, would-admit flags', () => {
  const db = withAccounts(initDB(':memory:'))
  // Sweep: rsi2_reversion at 60% over 30+10 trades (two combos, trade-weighted
  // 60), fib at 50% over 20; a verdict with no trades must not count.
  setState(db, 'autopilot_last_verdicts_json', JSON.stringify([
    { strategy: 'rsi2_reversion', symbol: 'EURUSD', timeframe: '1h', winRate: 60, trades: 30, pf: 1.6 },
    { strategy: 'rsi2_reversion', symbol: 'GBPUSD', timeframe: '4h', winRate: 60, trades: 10, pf: 1.4 },
    { strategy: 'fib_618_fade', symbol: 'EURUSD', timeframe: '1h', winRate: 50, trades: 20, pf: 1.2 },
    { strategy: 'fib_618_fade', symbol: 'XAUUSD', timeframe: '1d', winRate: 99, trades: 0, pf: null },
  ]))
  setState(db, 'autopilot_last_run_ms', String(Date.parse('2026-09-02T04:23:19Z')))
  // Live: 7 sub-floor closes on DEMO, 2 wins (28.6%) — the production shape.
  seedRecord(db, 'rsi2_reversion', 7, 28.6)
  const p = earnedFloorPriorReport(db)
  assert.equal(p.reportOnly, true)
  assert.equal(p.k, 20)
  assert.equal(p.sweepAt, '2026-09-02T04:23:19.000Z')
  assert.equal(p.source, 'autopilot_last_verdicts_json', 'no aggregate key yet → the verdict list is the fallback')
  assert.equal(p.strategiesWithPrior, 2)
  assert.deepEqual(p.accounts, [DEMO, DEMO2], 'demoOnly: live accounts are out of scope')
  const r = p.strategies.rsi2_reversion
  assert.deepEqual(r.backtest, { winRatePct: 60, trades: 40, combos: 2 })
  assert.equal(r.pooled.live.trades, 7)
  assert.equal(r.pooled.live.winRatePct, 29, "the rolling edge rounds W, and the gate reads that same rounded figure")
  // (7·29 + 20·60) / 27 = 51.96
  assert.equal(r.pooled.shrunkWinRatePct, 52)
  assert.equal(r.pooled.expectancyR[2], 0.559)
  assert.equal(r.pooled.wouldAdmit[2], true)
  assert.equal(r.pooled.wouldAdmit[1.5], true)
  assert.equal(r.byAccount[DEMO].live.trades, 7)
  // The other demo account has no record of its own, so its live side is
  // the POOLED record (owner, 02-09-2026 21:30 SGT) — the same 7 closes,
  // and the report says which scope it read.
  assert.equal(r.byAccount[DEMO].live.scope, 'account')
  assert.equal(r.byAccount[DEMO2].live.trades, 7, 'no record of its own → the pooled record')
  assert.equal(r.byAccount[DEMO2].live.scope, 'pooled')
  assert.equal(r.byAccount[DEMO2].shrunkWinRatePct, 52)
  // fib: prior only, 50% → E(2) = 0.5, E(1.5) = 0.25 > minE 0.15
  const f = p.strategies.fib_618_fade
  assert.deepEqual(f.backtest, { winRatePct: 50, trades: 20, combos: 1 })
  assert.equal(f.pooled.expectancyR[2], 0.5)
  assert.equal(f.pooled.wouldAdmit[1.5], true)
})

test('prior report: a strategy with live closes but no sweep verdict has no prior, and the GATE is unchanged by the report', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_last_verdicts_json', JSON.stringify([
    { strategy: 'rsi2_reversion', symbol: 'EURUSD', timeframe: '1h', winRate: 60, trades: 40, pf: 1.6 },
  ]))
  seedRecord(db, 'vwap_trend', 5, 60)
  seedRecord(db, 'rsi2_reversion', 7, 28.6)
  const p = earnedFloorPriorReport(db)
  assert.equal(p.strategies.vwap_trend.backtest, null)
  assert.equal(p.strategies.vwap_trend.pooled.shrunkWinRatePct, null)
  assert.deepEqual(p.strategies.vwap_trend.pooled.wouldAdmit, { 1.5: null, 2: null, 2.5: null })
  // The report says rsi2 would admit at 2R; the gate still says thin sample.
  assert.equal(p.strategies.rsi2_reversion.pooled.wouldAdmit[2], true)
  const v = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO })
  assert.equal(v.ok, false)
  assert.match(v.reason, /^thin_sample 7</)
  // And the checkpoint report carries the prior without changing its own fields.
  const rep = earnedFloorReport(db)
  assert.equal(rep.verdict, 'pending 0/30 closes')
  assert.equal(rep.prior.strategies.rsi2_reversion.pooled.shrunkWinRatePct, 52)
  // Junk verdict state never breaks the report.
  setState(db, 'autopilot_last_verdicts_json', '{not json')
  assert.equal(earnedFloorPriorReport(db).strategiesWithPrior, 0)
})

test('prior report: k is the autopilot sweep prior, one number in two modules', () => {
  assert.equal(EARNED_FLOOR_PRIOR_TRADES, SHRINK_PRIOR_TRADES)
})

test('prior report: reads the sweep\'s per-strategy aggregate first — the verdict list is stored truncated and does not parse (02-09-2026 12:49)', () => {
  const db = withAccounts(initDB(':memory:'))
  // What production held: a 1,872-verdict list cut at 200,000 chars → broken JSON.
  const big = JSON.stringify(Array.from({ length: 1900 }, (_, i) => ({ strategy: 'rsi2_reversion', symbol: `S${i}`, timeframe: '1h', winRate: 60, trades: 25, pf: 1.5, state: 'go', entryMode: 'close' })))
  assert.ok(big.length > 200_000)
  setState(db, 'autopilot_last_verdicts_json', big.slice(0, 200_000))
  assert.equal(earnedFloorPriorReport(db).strategiesWithPrior, 0, 'the truncated list alone yields no prior — the defect')
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ rsi2_reversion: { winRatePct: 60, trades: 47500, combos: 1900 } }))
  const p = earnedFloorPriorReport(db)
  assert.equal(p.source, 'autopilot_strategy_prior_json')
  assert.deepEqual(p.strategies.rsi2_reversion.backtest, { winRatePct: 60, trades: 47500, combos: 1900 })
  assert.equal(p.strategies.rsi2_reversion.pooled.shrunkWinRatePct, 60)
})

// ---------------------------------------------------------------------------
// THE PRIOR AS AN ACTUATOR (owner order 02-09-2026 18:50 SGT: "let the prior
// admit on demo at half risk"). Thin live sample + sweep prior → admitted on
// a demo account at half risk, stamped via:'prior'. Never on live, never over
// a measured sample, never without a prior.
// ---------------------------------------------------------------------------
const PRIOR_60 = JSON.stringify({ rsi2_reversion: { winRatePct: 60, trades: 2690, combos: 72 } })

test('prior admit: 7 live closes at 29% shrunk toward a 60% backtest reads 52%, +0.56R at 2R → admitted on demo at half risk', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', PRIOR_60)
  seedRecord(db, 'rsi2_reversion', 7, 28.6)
  const v = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO })
  assert.equal(v.ok, true)
  assert.equal(v.via, 'prior')
  assert.equal(v.winRate, 52)
  assert.equal(v.trades, 7)
  assert.equal(v.e, 0.559)
  assert.equal(v.riskScale, 0.5, 'half risk, whatever riskScale the measured path uses')
  assert.deepEqual(v.prior, { winRatePct: 60, trades: 2690, k: 20, liveWinRatePct: 29, liveTrades: 7, liveScope: 'account' })
  // No live record of its own: the pooled record stands in (the same 7
  // closes here), and the stamp says so.
  const bare = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO2 })
  assert.equal(bare.ok, true); assert.equal(bare.winRate, 52); assert.equal(bare.trades, 7)
  assert.equal(bare.prior.liveScope, 'pooled')
  // riskScale never exceeds the measured path's own scale.
  setState(db, 'earned_floor_json', JSON.stringify({ riskScale: 0.25, demoOnly: false }))
  assert.equal(earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO }).riskScale, 0.25)
})

test('prior admit: never on a live account (even with demoOnly off), never without a prior, never over a measured sample, switchable off', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', PRIOR_60)
  setState(db, 'earned_floor_json', JSON.stringify({ demoOnly: false, riskScale: 1 }))
  seedRecord(db, 'rsi2_reversion', 7, 28.6, { accountId: LIVE })
  const live = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: LIVE })
  assert.equal(live.ok, false)
  assert.match(live.reason, /^thin_sample 7</, 'live stays on the measured path')
  const noPrior = earnedFloorVerdict(db, { strategy: 'donchian_breakout', rr: 2, accountId: DEMO })
  assert.match(noPrior.reason, /^thin_sample/)
  // A measured sample at minSample is judged as before — the prior does not override it.
  seedRecord(db, 'rsi2_reversion', 15, 20)
  const measured = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO })
  assert.equal(measured.ok, false)
  assert.match(measured.reason, /^expectancy .* at measured 20%/)
  assert.equal(measured.via, undefined)
  // Switch.
  setState(db, 'earned_floor_json', JSON.stringify({ priorAdmit: false }))
  assert.match(earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO2 }).reason, /^thin_sample/)
})

test('prior admit: a weak backtest is refused with the prior figures in the reason', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ donchian_breakout: { winRatePct: 24.4, trades: 2556, combos: 144 } }))
  seedRecord(db, 'donchian_breakout', 8, 25)
  const v = earnedFloorVerdict(db, { strategy: 'donchian_breakout', rr: 2, accountId: DEMO })
  assert.equal(v.ok, false)
  assert.match(v.reason, /^prior expectancy -0\.26\dR at shrunk 24\.\d% \(8 account live closes toward backtest 24\.4%\)/)
  assert.equal(v.via, 'prior')
})

test('prior admit: a FRESH scope shrinks from the pooled record until it has a close of its own (owner, 02-09-2026 21:30 SGT)', () => {
  // The ACCT-DEMO-3 mechanism (21:14 SGT): vwap's backtest alone is 33%,
  // E(2) = −0.01 ≤ minE, so a fresh account can never earn the closes that
  // would lift it. The book's pooled record (other demo accounts' sub-floor
  // closes) is what the fresh scope reads until it has its own.
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ vwap_trend: { winRatePct: 33, trades: 7000, combos: 200 } }))
  // Nobody has a record yet: the prior alone, refused, and the reason says pooled (0 closes).
  let v = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 2, accountId: DEMO2 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /\(0 account live closes toward backtest 33%\)/, 'no pooled record either → the account scope, 0 closes')
  // DEMO earns 12 sub-floor closes at 58%: pooled W = 58, shrunk (12·58 + 20·33)/32 = 42.4 → E(2) = 0.27
  seedRecord(db, 'vwap_trend', 12, 58.3, { accountId: DEMO })
  v = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 2, accountId: DEMO2 })
  assert.equal(v.ok, true, 'the fresh scope admits on the pooled record')
  assert.equal(v.via, 'prior')
  assert.equal(v.trades, 12)
  assert.equal(v.prior.liveScope, 'pooled')
  assert.equal(v.riskScale, 0.5)
  // The moment DEMO2 has ONE close of its own, its own record is the live side — even when that is worse.
  seedRecord(db, 'vwap_trend', 1, 0, { accountId: DEMO2 })
  v = earnedFloorVerdict(db, { strategy: 'vwap_trend', rr: 2, accountId: DEMO2 })
  assert.equal(v.prior.liveScope, 'account')
  assert.equal(v.trades, 1)
  assert.equal(v.prior.liveWinRatePct, 0)
  // (1·0 + 20·33)/21 = 31.4 → E(2) = −0.06: refused on its own record
  assert.equal(v.ok, false)
  assert.match(v.reason, /\(1 account live closes/)
  // The report reads the same rule.
  const rep = earnedFloorPriorReport(db).strategies.vwap_trend
  assert.equal(rep.byAccount[DEMO2].live.scope, 'account')
  assert.equal(rep.byAccount[DEMO].live.scope, 'account')
  assert.equal(rep.pooled.live.trades, 13)
})

test('gate: a prior admit approves a sub-3R demo proposal at half risk and stamps via:prior; the report splits it out', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ vwap_trend: { winRatePct: 60, trades: 5855, combos: 144 } }))
  armBalance(db, DEMO, 10_000)
  armBalance(db, LIVE, 10_000)
  const demo = evaluateTrade(db, lowRrProposal(DEMO))
  persistRiskEvent(db, lowRrProposal(DEMO), demo) // the gate's caller persists; the report reads the ledger
  assert.equal(demo.approved, true, demo.veto_reason)
  assert.equal(demo.checks.earned_floor.via, 'prior')
  assert.equal(demo.checks.earned_floor.riskScale, 0.5)
  assert.equal(demo.checks.earned_floor.prior.winRatePct, 60)
  const live = evaluateTrade(db, lowRrProposal(LIVE))
  assert.equal(live.approved, false)
  assert.match(live.checks.earned_floor_denied, /live_scope|thin_sample/)
  const rep = earnedFloorReport(db)
  assert.equal(rep.viaPrior.admittedApprovals, 1)
  assert.equal(rep.admittedApprovals, 1, 'prior admits are part of the pre-registered cohort')
})

// ---------------------------------------------------------------------------
// Prior cohort watch (02-09-2026 plan, part 1): the route reaches the prior
// switch, the report splits the prior population and the accounts.
// ---------------------------------------------------------------------------
test('POST /actions/earned-floor reaches priorAdmit and priorRiskScale (source pin) and loadEarnedFloor clamps them', () => {
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const route = src.slice(src.indexOf("router.post('/earned-floor'"), src.indexOf("router.post('/earned-floor'") + 2200)
  assert.match(route, /priorAdmit: req\.body\.priorAdmit/)
  assert.match(route, /priorRiskScale: Number\(req\.body\.priorRiskScale\)/)
  assert.match(route, /priorAdmit=\$\{clamped\.priorAdmit\}/)
  const db = initDB(':memory:')
  setState(db, 'earned_floor_json', JSON.stringify({ priorAdmit: false, priorRiskScale: 7 }))
  const cfg = loadEarnedFloor(db)
  assert.equal(cfg.priorAdmit, false)
  assert.equal(cfg.priorRiskScale, 1, 'clamped to the same range as riskScale')
})

test('earnedFloorReport splits the prior population (with PF) and the accounts, keeping legacy rows as unscoped', () => {
  const db = withAccounts(initDB(':memory:'))
  const ev = db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, account_id) VALUES ('EURUSD','BUY',1,?,?)`)
  const tr = db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, closed_at, risk_event_id, account_id) VALUES ('EURUSD','BUY','closed',?,datetime('now'),?,?)`)
  const measured = (acct) => ev.run(JSON.stringify({ earned_floor: { rr: 1.6, via: 'measured' } }), acct).lastInsertRowid
  const prior = (acct) => ev.run(JSON.stringify({ earned_floor: { rr: 2, via: 'prior' } }), acct).lastInsertRowid
  tr.run(60, measured(DEMO), DEMO)
  tr.run(-20, measured(DEMO), DEMO)
  tr.run(30, prior(DEMO), DEMO)
  tr.run(-10, prior(DEMO2), DEMO2)
  tr.run(15, measured(null), null) // legacy: no account on either side
  const r = earnedFloorReport(db)
  assert.equal(r.closedCohort.trades, 5, 'the pooled, pre-registered cohort is unchanged in meaning')
  assert.deepEqual(r.viaPrior, { admittedApprovals: 2, closed: 2, wins: 1, winRate: 50, profitFactor: 3, net: 20 })
  assert.deepEqual(Object.keys(r.byAccount).sort(), [DEMO, DEMO2, 'unscoped'].sort())
  assert.equal(r.byAccount[DEMO].closed, 3)
  assert.equal(r.byAccount[DEMO].profitFactor, 4.5)
  assert.deepEqual(r.byAccount[DEMO].viaPrior, { closed: 1, wins: 1, winRate: 100, profitFactor: null, net: 30 })
  assert.deepEqual(r.byAccount[DEMO2].viaPrior, { closed: 1, wins: 0, winRate: 0, profitFactor: 0, net: -10 })
  assert.equal(r.byAccount.unscoped.closed, 1, 'legacy rows are counted, never dropped')
  assert.equal(r.byAccount.unscoped.viaPrior.closed, 0)
})

// ---------------------------------------------------------------------------
// TARGET STRETCH (owner order 09-09-2026 11:05 SGT, §7,522·B: "R:R should be
// dynamic. i don't like opportunities to be thrown away"). A known win rate
// that does not pay at the proposed ratio no longer vetoes the setup: the
// gate moves the target to the ratio that clears minE, under a cap, and the
// order paths carry that target. No record, live scope while staged, or a
// ratio the win rate cannot pay under the cap → the veto exactly as before.
// ---------------------------------------------------------------------------
import { earnedFloorWinRate, earnedFloorStretch, rrNeededFor } from './earned-floor.js'

test('rrNeededFor: the ratio E clears minE at, rounded up so the rounded figure still clears', () => {
  // W 48%, minE 0.15 → (0.52 + 0.15) / 0.48 = 1.3958… → 1.40 (E = 0.152)
  assert.equal(rrNeededFor(0.48, 0.15), 1.4)
  assert.ok(0.48 * 1.4 - 0.52 > 0.15)
  // W 52.5% → 1.1905 → 1.20 (E = 0.155, strictly above the bar)
  assert.equal(rrNeededFor(0.525, 0.15), 1.2)
  // W 50% → exactly 1.30 would give E 0.15, not strictly above → 1.31
  assert.equal(rrNeededFor(0.5, 0.15), 1.31)
  // W 30% → 2.8333 → 2.84
  assert.equal(rrNeededFor(0.3, 0.15), 2.84)
  assert.equal(rrNeededFor(0, 0.15), null)
  assert.equal(rrNeededFor(1, 0.15), null)
})

test('earnedFloorWinRate is the verdict\'s own win-rate side: same refusals, same measured and prior readings', () => {
  const db = withAccounts(initDB(':memory:'))
  assert.equal(earnedFloorWinRate(db, { strategy: null, accountId: DEMO }).reason, 'unlabelled_proposal')
  assert.equal(earnedFloorWinRate(db, { strategy: 'vwap_trend', accountId: '999' }).reason, 'unattributable_account')
  assert.equal(earnedFloorWinRate(db, { strategy: 'vwap_trend', accountId: LIVE }).reason, 'live_scope')
  assert.match(earnedFloorWinRate(db, { strategy: 'vwap_trend', accountId: DEMO }).reason, /thin_sample/)
  seedRecord(db, 'vwap_trend', 20, 70)
  const m = earnedFloorWinRate(db, { strategy: 'vwap_trend', accountId: DEMO })
  assert.equal(m.ok, true); assert.equal(m.via, 'measured'); assert.equal(m.winRate, 70); assert.equal(m.W, 0.7); assert.equal(m.trades, 20)
  setState(db, 'autopilot_strategy_prior_json', PRIOR_60)
  seedRecord(db, 'rsi2_reversion', 7, 28.6)
  const p = earnedFloorWinRate(db, { strategy: 'rsi2_reversion', accountId: DEMO })
  assert.equal(p.ok, true); assert.equal(p.via, 'prior'); assert.equal(p.winRate, 52); assert.equal(p.prior.liveTrades, 7)
  // The verdict built on it reads exactly as before.
  const v = earnedFloorVerdict(db, { strategy: 'rsi2_reversion', rr: 2, accountId: DEMO })
  assert.equal(v.ok, true); assert.equal(v.e, 0.559); assert.equal(v.winRate, 52); assert.equal(v.trades, 7)
})

test('stretch: 48% prior at a 1.2R proposal → target moved to 1.40R (E 0.152) at half risk; a paying ratio is not_needed; the cap refuses', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ rsi2_reversion: { winRatePct: 48, trades: 900, combos: 40 } }))
  const st = earnedFloorStretch(db, { strategy: 'rsi2_reversion', rr: 1.2, accountId: DEMO })
  assert.equal(st.ok, true, st.reason)
  assert.equal(st.from, 1.2); assert.equal(st.to, 1.4); assert.equal(st.e, 0.152)
  assert.equal(st.via, 'prior'); assert.equal(st.winRate, 48); assert.equal(st.riskScale, 0.5)
  // A ratio the win rate already pays at needs no stretch.
  const nn = earnedFloorStretch(db, { strategy: 'rsi2_reversion', rr: 1.6, accountId: DEMO })
  assert.equal(nn.ok, false); assert.equal(nn.reason, 'not_needed'); assert.equal(nn.to, 1.4)
  // 30% win needs 2.84R — over the 2.0 cap: refused, with the figures.
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ ema_pullback: { winRatePct: 30, trades: 900, combos: 40 } }))
  const cap = earnedFloorStretch(db, { strategy: 'ema_pullback', rr: 2, accountId: DEMO })
  assert.equal(cap.ok, false); assert.match(cap.reason, /stretch_over_cap: 30% win needs 2\.84R for 0\.15R, cap 2R/)
  // Raise the cap and the same setup stretches.
  setState(db, 'earned_floor_json', JSON.stringify({ maxStretchRr: 2.9 }))
  assert.equal(earnedFloorStretch(db, { strategy: 'ema_pullback', rr: 2, accountId: DEMO }).to, 2.84)
  // Switched off → nothing stretches; the cap is clamped to the 3.0 band.
  setState(db, 'earned_floor_json', JSON.stringify({ stretch: false, maxStretchRr: 9 }))
  assert.equal(earnedFloorStretch(db, { strategy: 'rsi2_reversion', rr: 1.2, accountId: DEMO }).reason, 'stretch_off')
  assert.equal(loadEarnedFloor(db).maxStretchRr, EARNED_FLOOR_RR_BAND)
  assert.equal(loadEarnedFloor(db).stretch, false)
  // No record at all, or a live scope: the win-rate side's refusal, never a stretch.
  setState(db, 'earned_floor_json', JSON.stringify({}))
  assert.match(earnedFloorStretch(db, { strategy: 'vwap_trend', rr: 1.2, accountId: DEMO }).reason, /thin_sample/)
  assert.equal(earnedFloorStretch(db, { strategy: 'rsi2_reversion', rr: 1.2, accountId: LIVE }).reason, 'live_scope')
})

test('gate: a 1.2R rsi2 proposal on demo with a 48% prior is ADMITTED at a 1.40R target — target_override carries the new tp1, checks say stretchedFrom', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ rsi2_reversion: { winRatePct: 48, trades: 900, combos: 40 } }))
  armBalance(db, DEMO, 10_000)
  // long: entry 1.1000, sl 1.0970 (30 pips), tp1 1.1036 (1.2R)
  const prop = { symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.097, tp1: 1.1036, requestedVolume: null, strategy: 'rsi2_reversion', conviction: 8, accountId: DEMO }
  const res = evaluateTrade(db, prop)
  assert.equal(res.approved, true, `expected a stretched admit, got: ${res.veto_reason}`)
  assert.deepEqual(res.target_override, { tp1: 1.1042, rr: 1.4, from: 1.2 })
  assert.equal(res.checks.earned_floor.stretchedFrom, 1.2)
  assert.equal(res.checks.earned_floor.rr, 1.4)
  assert.equal(res.checks.earned_floor.tp1, 1.1042)
  assert.equal(res.checks.earned_floor.via, 'prior')
  assert.equal(res.checks.earned_floor.riskScale, 0.5)
  assert.equal(res.checks.earned_floor_denied, undefined, 'the denial is withdrawn once the stretch admits')
  // short mirrors: entry 1.1000, sl 1.1030, tp1 1.0964 → target 1.0958
  const short = evaluateTrade(db, { ...prop, side: 'short', sl: 1.103, tp1: 1.0964 })
  assert.equal(short.approved, true, short.veto_reason)
  assert.equal(short.target_override.tp1, 1.0958)
  // A ratio the prior already pays at (1.6R) admits WITHOUT a stretch: no override.
  const paying = evaluateTrade(db, { ...prop, tp1: 1.1048 })
  assert.equal(paying.approved, true, paying.veto_reason)
  assert.equal(paying.target_override, undefined)
  assert.equal(paying.checks.earned_floor.stretchedFrom, undefined)
  // The report splits the stretched population out of the cohort.
  persistRiskEvent(db, prop, res)
  persistRiskEvent(db, { ...prop, tp1: 1.1048 }, paying)
  const rep = earnedFloorReport(db)
  assert.equal(rep.stretched.admittedApprovals, 1)
  // Same symbol, side and strategy → one distinct opportunity, two approval events.
  assert.equal(rep.admittedApprovals, 1, 'stretched admits are part of the pre-registered cohort')
  assert.equal(rep.admitEvents, 2)
})

test('gate: the stretch is a door only for a known win rate — no record, live scope, over the cap, or stretch off all veto bad_rr as before', () => {
  const db = withAccounts(initDB(':memory:'))
  armBalance(db, DEMO, 10_000); armBalance(db, LIVE, 10_000)
  const prop = { symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.097, tp1: 1.1036, requestedVolume: null, strategy: 'rsi2_reversion', conviction: 8, accountId: DEMO }
  // No prior, no closes → thin sample → bad_rr, and the stretch denial names it.
  const none = evaluateTrade(db, prop)
  assert.equal(none.approved, false); assert.match(none.veto_reason, /^bad_rr 1\.20<3/)
  assert.match(none.checks.earned_floor_stretch_denied, /thin_sample/)
  assert.equal(none.target_override, undefined)
  // Prior present, live account → live_scope.
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ rsi2_reversion: { winRatePct: 48, trades: 900, combos: 40 }, ema_pullback: { winRatePct: 30, trades: 900, combos: 40 } }))
  const live = evaluateTrade(db, { ...prop, accountId: LIVE })
  assert.equal(live.approved, false); assert.match(live.veto_reason, /^bad_rr/)
  // 30% needs 2.84R > the 2.0 cap → bad_rr, denial says why.
  const capped = evaluateTrade(db, { ...prop, strategy: 'ema_pullback', tp1: 1.106 })
  assert.equal(capped.approved, false); assert.match(capped.veto_reason, /^bad_rr 2\.00<3/)
  assert.match(capped.checks.earned_floor_stretch_denied, /stretch_over_cap/)
  // Stretch off → the pre-§7,522 behaviour: bad_rr, no stretch key at all.
  setState(db, 'earned_floor_json', JSON.stringify({ stretch: false }))
  const off = evaluateTrade(db, prop)
  assert.equal(off.approved, false); assert.match(off.veto_reason, /^bad_rr 1\.20<3/)
  assert.equal(off.checks.earned_floor_stretch_denied, undefined)
  assert.match(off.checks.earned_floor_denied, /prior expectancy/)
})

test('wiring pins: the three order paths apply target_override to the target they send', () => {
  const strip = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip('../loop.js')
  const at = loop.slice(loop.indexOf('export async function autoTrade('))
  assert.match(at, /riskResult\.target_override\?\.tp1 != null[\s\S]{0,400}?synth = \{ \.\.\.synth, tp1: riskResult\.target_override\.tp1/, 'autoTrade rewrites synth.tp1 from the override')
  const cml = strip('./closed-market-limits.js')
  assert.match(cml, /riskResult\.target_override\?\.tp1 != null[\s\S]{0,200}?synth = \{ \.\.\.synth, tp1: riskResult\.target_override\.tp1 \}/, 'closed-market limit carries the override')
  const po = strip('./pending-orders.js')
  assert.match(po, /riskResult\.target_override\?\.tp1 != null[\s\S]{0,200}?signal = \{ \.\.\.signal, tp1: riskResult\.target_override\.tp1 \}/, 'pending order carries the override')
  assert.match(po, /let signal = setupSignal/, 'signal is reassignable — a const from the for-of destructure would throw at the first stretch')
  // The gate returns the override only on a stretch.
  const risk = strip('./risk.js')
  assert.match(risk, /earnedFloor\?\.stretchedFrom != null[\s\S]{0,200}?target_override: \{ tp1: earnedFloor\.tp1, rr: earnedFloor\.rr, from: earnedFloor\.stretchedFrom \}/)
})
