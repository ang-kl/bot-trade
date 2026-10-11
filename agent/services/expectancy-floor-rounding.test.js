// node --test agent/services/expectancy-floor-rounding.test.js
//
// Claude · № 13,141 11-Oct (Codex P2 on #1317, round 4; claude-builder).
// effectiveRrFloor is what a proposer asks "what will the gate demand" (the
// burn-in, the pad's bracket advice). It took expectancyVerdict's quoted
// `need`, rounded to the NEAREST hundredth, while the gate compares
// E = W·rr − (1 − W) > minE strictly on the raw value — so a target built at
// the quoted ratio could land a hair under and be refused a second time.
// expectancyFloorFor now rounds UP through rrNeededFor and re-checks at the
// gate's own rounding. Red before (7.43), green after (7.44).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { expectancyFloorFor, expectancyVerdict, effectiveRrFloor, ceilRr, HARD_MIN_RR } from './risk.js'

const MIN_E = 0.15

// Codex P2 on #1317, round 6: the configured floor itself is answered as the
// two-decimal ratio the gate judges, on the thin-sample path too.
test('a configured minRR with more than two decimals is answered rounded up on a fresh account (thin sample)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('A', '1', 0, 1, 'active')`).run()
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 3.004, minExpectancyR: 0.15 }))
  assert.equal(effectiveRrFloor(db, 'A', 'burnin'), 3.01, 'a target built at 3.004 reaches the gate as 3.00 and fails the 3.004 floor; 3.01 does not')
  assert.equal(expectancyFloorFor({ trades: 5, winRate: 0.1 }, 3.004, MIN_E), 3.01, 'the thin-sample early return rounds too')
  // expectancy clause disabled (null is honoured by the merge): the final return rounds as well
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 3.004, minExpectancyR: null }))
  assert.equal(effectiveRrFloor(db, 'A', 'burnin'), 3.01, 'with the expectancy clause off the configured floor is still answered as 3.01')
  assert.equal(ceilRr(3.6000000000000005), 3.6)
  assert.equal(ceilRr(3.004), 3.01)
  assert.equal(ceilRr(4.2), 4.2)
})

test('3 wins in 22 closes: the quoted 7.43R fails the gate, the floor returned is 7.44R and passes it', () => {
  const stats = { trades: 22, winRate: 3 / 22 }
  const quoted = expectancyVerdict(stats, HARD_MIN_RR, { minE: MIN_E }).need
  assert.equal(quoted, 7.43, 'the verdict quotes the nearest-hundredth figure')
  assert.equal(expectancyVerdict(stats, quoted, { minE: MIN_E }).ok, false, 'the gate refuses a target at the quoted ratio')
  const floor = expectancyFloorFor(stats, HARD_MIN_RR, MIN_E)
  assert.equal(floor, 7.44)
  assert.equal(expectancyVerdict(stats, floor, { minE: MIN_E }).ok, true, 'the returned floor clears the gate\'s own comparison')
})

test('a quoted 3.00 that hides a raw 3.004 does not leave the static floor at exactly 3R', () => {
  // (minE + 1 − W) / W = 3.004  ⇒  W = 1.15 / 4.004
  const stats = { trades: 40, winRate: 1.15 / 4.004 }
  assert.equal(expectancyVerdict(stats, HARD_MIN_RR, { minE: MIN_E }).need, 3, 'quoted as 3.00')
  assert.equal(expectancyVerdict(stats, HARD_MIN_RR, { minE: MIN_E }).ok, false, 'yet the gate refuses exactly 3R')
  const floor = expectancyFloorFor(stats, HARD_MIN_RR, MIN_E)
  assert.equal(floor, 3.01)
  assert.equal(expectancyVerdict(stats, floor, { minE: MIN_E }).ok, true)
})

test('an exact 3.6 the gate admits stays 3.6 (floating-point carries it as 3.6000000000000005; burn-in pins it)', () => {
  const stats = { trades: 24, winRate: 0.25 }
  const floor = expectancyFloorFor(stats, HARD_MIN_RR, MIN_E)
  assert.equal(floor, 3.6)
  assert.equal(expectancyVerdict(stats, floor, { minE: MIN_E }).ok, true)
})

test('an owner floor with more than two decimals is answered with the two-decimal ratio the gate will actually see (Codex P2, round 5)', () => {
  // the gate rounds a proposal's ratio to two decimals before judging it, so
  // 3.004 would reach it as 3.00 and fail the floor itself
  const stats = { trades: 40, winRate: 1.15 / 4.002 }
  const floor = expectancyFloorFor(stats, 3.004, MIN_E)
  assert.equal(floor, Math.round(floor * 100) / 100, 'two decimals')
  assert.ok(floor >= 3.01, `at or above the next hundredth, got ${floor}`)
  assert.equal(expectancyVerdict(stats, floor, { minE: MIN_E }).ok, true)
  // no measured demand above an exact two-decimal floor: unchanged
  assert.equal(expectancyFloorFor({ trades: 40, winRate: 0.6 }, 4.2, MIN_E), 4.2)
})

test('a win rate that needs less than the static floor, or a thin sample, leaves the floor alone', () => {
  assert.equal(expectancyFloorFor({ trades: 40, winRate: 0.6 }, HARD_MIN_RR, MIN_E), HARD_MIN_RR, '0.92R needed: the static floor stands')
  assert.equal(expectancyFloorFor({ trades: 5, winRate: 0.1 }, HARD_MIN_RR, MIN_E), HARD_MIN_RR, 'thin sample fails open')
  assert.equal(expectancyFloorFor({ trades: 40, winRate: 1 }, HARD_MIN_RR, MIN_E), HARD_MIN_RR, 'unusable win rate fails open')
  assert.equal(expectancyFloorFor(null, HARD_MIN_RR, MIN_E), HARD_MIN_RR)
})
