// node --test agent/services/target-review.test.js
//
// The strategy target review (02-09-2026 plan, part 3). What these pin, in
// order of what would hurt most if it drifted: that the module cannot change
// anything (read-only, and it imports no strategy module or manager); that
// the proposal median really is the gate's own rounded rr for the two fixed
// targets; that the prior arithmetic is the formula the earned floor uses;
// and that the realised block agrees with exit-counterfactual on the same
// trades — one population, one summariser, two readers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { evaluateTrade, persistRiskEvent, persistPostApprovalVeto, HARD_MIN_RR } from './risk.js'
import { STRATEGY_REGISTRY, minRrFor, STRATEGY_PREFILTER_RR } from './strategies.js'
import { exitCounterfactual, MIN_SAMPLE } from './exit-counterfactual.js'
import {
  targetReview, proposalsByStrategy, priorArithmetic, quantile,
  DECLARED_TARGETS, TARGET_REVIEW_GATES,
} from './target-review.js'

const DEMO = '111'
const DEMO2 = '333'

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO2}','3',0,1,'active')`).run()
  return db
}

/** A gate-shaped proposal; the bracket sets the rr the gate records. */
const proposal = (strategy, { entry = 100, sl = 99, tp1 = 101.2, symbol = 'EURUSD', accountId = DEMO, key = null } = {}) => ({
  symbol, side: 'BUY', bias: 'long', entry, sl, tp1, strategy, timeframe: 'M15', accountId,
  conviction: 0.7, ...(key ? { opportunity_key: key } : {}),
})

/** Insert one gate decision directly, the way persistRiskEvent stores it. */
function seedEvent(db, { strategy, rr = 1.2, approved = 0, veto = null, key = null, checks = {}, accountId = DEMO, ageMin = 5 }) {
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at, opportunity_key)
     VALUES ('EURUSD','BUY',?,?,?,?,?,?,?)`
  ).run(approved, veto, JSON.stringify({ ...(rr == null ? {} : { rr }), ...checks }), JSON.stringify({ strategy }),
    accountId, new Date(Date.now() - ageMin * 60_000).toISOString(), key)
}

const MIN = 60_000
const t0 = Date.now() - 3 * 3_600_000
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]
const STOPPED = [bar(0, 100, 100.2, 98.9, 99)]
const WON = [bar(0, 100, 100.5, 99.9, 100.4), bar(30, 100.4, 101.3, 100.3, 101.25)]

function seedClose(db, { strategy, actualR, bars = STOPPED, accountId = DEMO, n = 1 }) {
  for (let i = 0; i < n; i++) {
    const info = db.prepare(
      `INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, opened_at, closed_at, net_pnl, origin, account_id, label_strategy)
       VALUES ('JPN225','long','closed',100,99,101.2,?,?,?,'bot_market_dispatch',?,?)`
    ).run(new Date(t0).toISOString(), new Date(t0 + 30 * MIN).toISOString(), actualR * 100, accountId, strategy)
    db.prepare(
      `INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json)
       VALUES (?, 'JPN225', 'long', 100, 99, ?, 'x', ?)`
    ).run(info.lastInsertRowid, actualR, JSON.stringify(bars))
  }
}

const fresh = () => withAccounts(initDB(':memory:'))

test('the declared table names every registry key, and the two fixed targets match what the gate records', () => {
  for (const s of STRATEGY_REGISTRY) assert.ok(DECLARED_TARGETS[s.key], `${s.key} missing from DECLARED_TARGETS`)
  const db = fresh()
  // rsi2 at its own construction (1.2 × stop) and ema at its 2R — through the
  // REAL gate, so the rr the review reads is the rr the gate rounded and
  // stored, not a number this test typed into checks_json.
  for (let i = 0; i < TARGET_REVIEW_GATES.minProposals; i++) {
    const r = evaluateTrade(db, proposal('rsi2_reversion', { tp1: 101.2, symbol: `S${i}` }))
    persistRiskEvent(db, proposal('rsi2_reversion', { tp1: 101.2, symbol: `S${i}` }), r)
    const e = evaluateTrade(db, proposal('ema_pullback', { tp1: 102, symbol: `E${i}` }))
    persistRiskEvent(db, proposal('ema_pullback', { tp1: 102, symbol: `E${i}` }), e)
  }
  const rv = targetReview(db)
  assert.equal(rv.strategies.rsi2_reversion.proposals.medianRr, 1.2)
  assert.equal(rv.strategies.rsi2_reversion.proposals.medianRr, DECLARED_TARGETS.rsi2_reversion.rr)
  assert.equal(rv.strategies.ema_pullback.proposals.medianRr, 2)
  assert.equal(rv.strategies.ema_pullback.proposals.medianRr, DECLARED_TARGETS.ema_pullback.rr)
  // Both are below the 3.0 hard floor by construction, and the review says so
  // with the gate's own constants rather than literals of its own.
  assert.equal(rv.hardMinRr, HARD_MIN_RR)
  assert.equal(rv.prefilterRr, STRATEGY_PREFILTER_RR)
  assert.equal(rv.strategies.rsi2_reversion.proposals.shareBelowHard, 1)
  assert.equal(rv.strategies.rsi2_reversion.ownFloor, minRrFor('rsi2_reversion', STRATEGY_PREFILTER_RR))
  assert.equal(rv.strategies.rsi2_reversion.proposals.shareBelowOwnFloor, 0)
  assert.ok(rv.strategies.rsi2_reversion.proposals.badRrVetoes >= 1, 'a sub-floor proposal with no earned floor is a bad_rr veto')
})

test('proposals are counted per distinct opportunity (latest decision wins) and post-approval refusals are excluded', () => {
  const db = fresh()
  seedEvent(db, { strategy: 'vwap_trend', rr: 1.5, approved: 0, veto: 'bad_rr 1.50<3', key: 'A|X|BUY|VWAP@1', ageMin: 10 })
  seedEvent(db, { strategy: 'vwap_trend', rr: 2.0, approved: 1, key: 'A|X|BUY|VWAP@1', ageMin: 5 })  // same setup, re-decided
  seedEvent(db, { strategy: 'vwap_trend', rr: 2.5, approved: 1, key: 'A|Y|BUY|VWAP@2', ageMin: 5 })
  seedEvent(db, { strategy: 'vwap_trend', rr: null, approved: 0, veto: 'spread', ageMin: 5 })         // unkeyed, no measured rr
  // A post-approval refusal RESOLVES an approval; it is not a gate decision.
  persistPostApprovalVeto(db, proposal('vwap_trend', { key: 'A|Y|BUY|VWAP@2' }), 'dispatch_refused')
  const p = proposalsByStrategy(db)
  assert.equal(p.vwap_trend.n, 3, 'two keyed setups + one unkeyed row')
  assert.equal(p.vwap_trend.rrs.length, 2, 'rows without checks.rr count in n, not in withRr')
  assert.deepEqual([...p.vwap_trend.rrs].sort(), [2, 2.5], 'the latest decision on setup 1 is the 2.0 approval')
  assert.equal(p.vwap_trend.approved, 2)
  assert.equal(p.vwap_trend.badRrVetoes, 0, 'the superseded bad_rr on setup 1 is not the latest decision')
  // Under the proposal gate the block says so rather than printing a median of two.
  const rv = targetReview(db)
  assert.equal(rv.strategies.vwap_trend.proposals.insufficient, true)
  assert.equal(rv.strategies.vwap_trend.proposals.withRr, 2)
  assert.equal(rv.strategies.vwap_trend.proposals.medianRr, undefined)
})

test('earned-floor admits are counted, prior admits split out, and the window and account scope apply', () => {
  const db = fresh()
  seedEvent(db, { strategy: 'rsi2_reversion', rr: 1.2, approved: 1, key: 'k1', checks: { earned_floor: { rr: 1.2, via: 'measured' } } })
  seedEvent(db, { strategy: 'rsi2_reversion', rr: 1.2, approved: 1, key: 'k2', checks: { earned_floor: { rr: 1.2, via: 'prior' } } })
  seedEvent(db, { strategy: 'rsi2_reversion', rr: 1.2, approved: 1, key: 'k3', accountId: DEMO2 })
  seedEvent(db, { strategy: 'rsi2_reversion', rr: 1.2, approved: 1, key: 'k4', ageMin: 40 * 24 * 60 })  // outside 30d
  const all = proposalsByStrategy(db)
  assert.equal(all.rsi2_reversion.n, 3)
  assert.equal(all.rsi2_reversion.earnedFloorAdmits, 2)
  assert.equal(all.rsi2_reversion.priorAdmits, 1)
  assert.equal(proposalsByStrategy(db, { accountId: DEMO }).rsi2_reversion.n, 2)
  assert.equal(proposalsByStrategy(db, { days: 60 }).rsi2_reversion.n, 4)
})

test('prior arithmetic is the earned-floor formula: W′ 0.6 → break-even 0.667, rr for E ≥ 0.1 is 0.833, E(1.2) = 0.32', () => {
  const a = priorArithmetic(0.6, { declared: 1.2, median: 2, minE: 0.1 })
  assert.equal(a.breakEvenRr, 0.667)
  assert.equal(a.rrForMinE, 0.833) // (0.1 + 1 − 0.6) / 0.6
  assert.equal(a.expectancyR.declared, 0.32)
  assert.equal(a.expectancyR.median, 0.8)
  assert.equal(a.expectancyR.hard, 1.4)
  assert.equal(a.wouldAdmit.declared, true)
  // No declared target → no E at it, and the admit reading is null, not false.
  const b = priorArithmetic(0.6, { declared: null, median: null })
  assert.equal(b.expectancyR.declared, null)
  assert.equal(b.wouldAdmit.declared, null)
  // Nothing to shrink toward → nothing invented.
  assert.equal(priorArithmetic(null), null)
  assert.equal(priorArithmetic(0), null)
  assert.equal(targetReview(fresh()).strategies.rsi2_reversion.prior, null, 'no sweep, no prior')
})

test('quantile interpolates and returns null on nothing', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([1, 2, 3], 0.5), 2)
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)
})

test('realised: 29 closes is insufficient; 40 closes reproduces exit-counterfactual on the same trades', () => {
  const db = fresh()
  seedClose(db, { strategy: 'rsi2_reversion', actualR: -1, n: 20 })
  seedClose(db, { strategy: 'rsi2_reversion', actualR: 1.2, bars: WON, n: 9 })
  let rv = targetReview(db)
  assert.equal(rv.strategies.rsi2_reversion.realised.insufficient, true)
  assert.equal(rv.strategies.rsi2_reversion.realised.closes, 29)
  assert.equal(rv.strategies.rsi2_reversion.realised.need, MIN_SAMPLE)

  seedClose(db, { strategy: 'rsi2_reversion', actualR: 1.2, bars: WON, n: 11 })
  rv = targetReview(db)
  const re = rv.strategies.rsi2_reversion.realised
  assert.equal(re.closes, 40)
  const cf = exitCounterfactual(db, { strategy: 'rsi2_reversion' })
  assert.equal(re.actual.expectancyR, cf.actual.expectancyR)
  assert.equal(re.actual.winRate, cf.actual.winRate)
  assert.equal(re.actual.profitFactor, cf.actual.profitFactor)
  assert.equal(re.shareReachedDeclared, 0.5, '20 of 40 reached the declared 1.2R')
  assert.deepEqual(Object.keys(re.rules), ['trail_0.5R', 'trail_1R', 'tp_1R'])
  assert.equal(re.rules.tp_1R.usable, 40)
  // A different strategy's closes do not leak in.
  seedClose(db, { strategy: 'ema_pullback', actualR: 3, n: 5 })
  assert.equal(targetReview(db).strategies.rsi2_reversion.realised.closes, 40)
  assert.equal(targetReview(db).strategies.ema_pullback.realised.closes, 5)
  // Account scoping: the other account's closes are not this one's record.
  seedClose(db, { strategy: 'rsi2_reversion', actualR: -1, n: 3, accountId: DEMO2 })
  assert.equal(targetReview(db, { accountId: DEMO }).strategies.rsi2_reversion.realised.closes, 40)
  assert.equal(targetReview(db).strategies.rsi2_reversion.realised.closes, 43)
})

test('read-only: row counts and the gate\'s answer are identical before and after a review', () => {
  const db = fresh()
  seedClose(db, { strategy: 'rsi2_reversion', actualR: -1, n: 3 })
  seedEvent(db, { strategy: 'rsi2_reversion', rr: 1.2, approved: 0, veto: 'bad_rr 1.20<3', key: 'k1' })
  const count = () => ['trades', 'risk_events', 'trade_postmortems', 'agent_state', 'position_events']
    .map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
  const before = count()
  const gateBefore = evaluateTrade(db, proposal('rsi2_reversion'))
  targetReview(db); targetReview(db, { days: 90, accountId: DEMO })
  assert.deepEqual(count(), before)
  const gateAfter = evaluateTrade(db, proposal('rsi2_reversion'))
  assert.equal(gateAfter.approved, gateBefore.approved)
  assert.equal(gateAfter.veto_reason, gateBefore.veto_reason)
})

test('source pin: no strategy module, no position manager, no writes', () => {
  const src = readFileSync(new URL('./target-review.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
  const allowed = new Set(['./risk.js', './strategies.js', './earned-floor.js', './exit-counterfactual.js', '../lib/exit-replay.js'])
  for (const i of imports) assert.ok(allowed.has(i), `unexpected import ${i}`)
  assert.ok(!imports.some(i => /position-manager|asset-controllers|rsi2-reversion|ema-pullback|vwap-trend|fib-confluence/.test(i)))
  assert.ok(!/\b(INSERT|UPDATE|DELETE|setState)\b/.test(src), 'the review writes nothing')
})

test('route: GET /state/target-review is declared once with days and account scope', () => {
  const src = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8')
  const decl = src.match(/router\.get\('\/target-review'/g) || []
  assert.equal(decl.length, 1)
  const body = src.slice(src.indexOf("router.get('/target-review'"))
  const block = body.slice(0, body.indexOf('\n  })\n') + 6)
  assert.ok(block.includes("import('../services/target-review.js')"))
  assert.ok(block.includes('requestedAccount(db, req)'))
  assert.ok(block.includes('Number(req.query.days)'))
})
