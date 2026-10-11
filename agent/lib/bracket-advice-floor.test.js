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
import { effectiveRrFloor, HARD_MIN_RR } from '../services/risk.js'

const ctx = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0900, digits: 4 }

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

test('a malformed rrFloor is ignored, not trusted', () => {
  for (const bad of [0, -1, NaN, 'abc', null]) {
    const adv = describeBracketGap('guard_no_target', { ...ctx, strategy: 'rsi2_reversion', minRR: 3, rrFloor: bad })
    assert.equal(adv.suggestion, 1.11, String(bad))
  }
})
