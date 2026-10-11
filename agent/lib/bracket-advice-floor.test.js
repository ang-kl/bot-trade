// node --test agent/lib/bracket-advice-floor.test.js
//
// Claude · № 13,128 11-Oct (Codex P2 on #1317; claude-builder). The order
// pad's bracket-gap advice is built on the floor the gate will actually
// demand of this account and strategy (effectiveRrFloor, passed as
// `ctx.rrFloor`), not on the registry override alone. Before: an
// rsi2_reversion pad order without a target was told a 1R target "would
// satisfy the R:R floor" and the resubmission was refused at 3R.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeBracketGap } from './bracket-advice.js'
import { initDB } from '../db.js'
import { effectiveRrFloor, lowestAdmittedRr, HARD_MIN_RR } from '../services/risk.js'
import { setState } from '../db.js'

const ctx = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0900, digits: 4 }

function seeded() {
  const db = initDB(':memory:')
  const ACCT = '47790949'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  return { db, ACCT }
}

// Claude · № 13,137 11-Oct (Codex P2 on #1317, round 3): the pad passes the
// LOWEST ratio the gate admits, which reads the earned-floor side too.
test('lowestAdmittedRr — no earned-floor evidence: the static floor', () => {
  const { db, ACCT } = seeded()
  assert.equal(lowestAdmittedRr(db, ACCT, 'vwap_trend'), HARD_MIN_RR)
  assert.equal(lowestAdmittedRr(db, ACCT, 'rsi2_reversion'), HARD_MIN_RR)
})

test('lowestAdmittedRr — a strategy whose prior pays under the floor is admitted at its prefilter, and the advice follows', () => {
  const { db, ACCT } = seeded()
  // W' = 60% (no live closes): rrNeededFor = ceil((1 − 0.6 + 0.1) / 0.6) → 0.84, under every prefilter
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ vwap_trend: { winRatePct: 60, trades: 500, combos: 20 }, rsi2_reversion: { winRatePct: 60, trades: 500, combos: 20 } }))
  assert.equal(lowestAdmittedRr(db, ACCT, 'vwap_trend'), 1.5, 'the registry prefilter, not the 0.84 the win rate alone would allow')
  assert.equal(lowestAdmittedRr(db, ACCT, 'rsi2_reversion'), 1.0, 'rsi2 keeps its own 1R override as the prefilter')
  const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'vwap_trend', minRR: 3, rrFloor: lowestAdmittedRr(db, ACCT, 'vwap_trend') })
  assert.equal(adv.suggestion, 1.115, '1.5R from 1.1000 against a 0.0100 stop')
})

test('lowestAdmittedRr — a prior that needs more than the static floor leaves the static floor', () => {
  const { db, ACCT } = seeded()
  // W' = 20%: rrNeededFor = (0.8 + 0.1) / 0.2 = 4.5 > 3
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ fib_confluence: { winRatePct: 20, trades: 500, combos: 20 } }))
  assert.equal(lowestAdmittedRr(db, ACCT, 'fib_confluence'), HARD_MIN_RR)
})

test('with the gate\'s floor supplied, the suggestion sits at that floor even for a strategy with a lower override', () => {
  const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'rsi2_reversion', minRR: 3, rrFloor: 3 })
  assert.ok(adv, 'advice produced')
  assert.equal(adv.suggestion, 1.13, '3R from 1.1000 against a 0.0100 stop')
  assert.match(adv.suggestionBasis, /^3R from entry/)
})

test('without it the registry override still decides (legacy callers unchanged)', () => {
  const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'rsi2_reversion', minRR: 3 })
  assert.equal(adv.suggestion, 1.11, '1R: the rsi2 override, as before')
})

test('effectiveRrFloor is what the pad passes: never below HARD_MIN_RR on a fresh account', () => {
  const db = initDB(':memory:')
  const ACCT = '47790949'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  assert.equal(effectiveRrFloor(db, ACCT, 'rsi2_reversion'), HARD_MIN_RR)
  const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'rsi2_reversion', minRR: 3, rrFloor: effectiveRrFloor(db, ACCT, 'rsi2_reversion') })
  assert.equal(adv.suggestion, 1.13)
})

// Codex P2 on #1317, round 8: the snapped price must still read at or above
// the floor to a gate that judges the ratio at two decimals.
test('a target that price precision rounds back under the floor is advanced a tick until the gate-visible ratio clears', () => {
  const gateRatio = (tp, entry, sl) => Math.round((Math.abs(tp - entry) / Math.abs(entry - sl)) * 100) / 100
  const adv = describeBracketGap('guard_no_target', { symbol: 'XYZ', side: 'BUY', entry: 100, sl: 99.7, digits: 2, strategy: 'vwap_trend', minRR: 3, rrFloor: 3.01 })
  assert.equal(adv.suggestion, 100.91, '100.903 snaps to 100.90 (3.00R, under 3.01); one tick up reads 3.03R')
  assert.ok(gateRatio(adv.suggestion, 100, 99.7) >= 3.01)
  const short = describeBracketGap('guard_no_target', { symbol: 'XYZ', side: 'SELL', entry: 100, sl: 100.3, digits: 2, strategy: 'vwap_trend', minRR: 3, rrFloor: 3.01 })
  assert.equal(short.suggestion, 99.09, 'the short side advances downward')
  assert.ok(gateRatio(short.suggestion, 100, 100.3) >= 3.01)
  // a target that already clears is left exactly where the floor puts it
  const clean = describeBracketGap('guard_no_target', { ...ctx, strategy: 'vwap_trend', minRR: 3, rrFloor: 3 })
  assert.equal(clean.suggestion, 1.13)
})

test('a malformed rrFloor is ignored, not trusted', () => {
  for (const bad of [0, -1, NaN, 'abc', null]) {
    const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'rsi2_reversion', minRR: 3, rrFloor: bad })
    assert.equal(adv.suggestion, 1.11, String(bad))
  }
})
