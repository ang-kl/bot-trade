// node --test agent/services/position-manager.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluatePosition,
  currentR,
  priceAtR,
  DEFAULT_RULES,
  _internal,
} from './position-manager.js'

// Helpers ------------------------------------------------------------------

function longXAU(overrides = {}) {
  return {
    id: 1,
    symbol: 'XAUUSD',
    side: 'long',
    entry_price: 3400,
    current_sl: 3380,    // 20-point risk
    current_tp: 3440,
    initial_risk: 20,
    mfe_r: 0,
    mae_r: 0,
    be_moved: 0,
    scaled_out: 0,
    invalidation_trigger: null,
    time_cap_at: null,
    strategy: 'trend',
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...overrides,
  }
}

function shortEUR(overrides = {}) {
  return {
    id: 2,
    symbol: 'EURUSD',
    side: 'short',
    entry_price: 1.1000,
    current_sl: 1.1020,  // 0.0020 risk
    current_tp: 1.0960,
    initial_risk: 0.0020,
    mfe_r: 0,
    mae_r: 0,
    be_moved: 0,
    scaled_out: 0,
    invalidation_trigger: null,
    time_cap_at: null,
    strategy: 'range',
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...overrides,
  }
}

// R-unit math --------------------------------------------------------------

test('currentR — long in profit', () => {
  const pos = longXAU()
  assert.equal(currentR(pos, 3410), 0.5)
  assert.equal(currentR(pos, 3420), 1.0)
  assert.equal(currentR(pos, 3430), 1.5)
})

test('currentR — long in drawdown', () => {
  const pos = longXAU()
  assert.equal(currentR(pos, 3390), -0.5)
})

test('currentR — short in profit', () => {
  const pos = shortEUR()
  assert.equal(Math.round(currentR(pos, 1.0990) * 100) / 100, 0.5)
  assert.equal(Math.round(currentR(pos, 1.0980) * 100) / 100, 1.0)
})

test('priceAtR round-trips', () => {
  const pos = longXAU()
  assert.equal(priceAtR(pos, 1), 3420)
  assert.equal(priceAtR(pos, 0.5), 3410)
  assert.equal(priceAtR(pos, -1), 3380)
})

test('priceAtR for shorts goes the other way', () => {
  const pos = shortEUR()
  assert.equal(Math.round(priceAtR(pos, 1) * 10000) / 10000, 1.0980)
})

// Metric updates -----------------------------------------------------------

test('MFE and MAE update every tick', () => {
  const pos = longXAU({ mfe_r: 0.5, mae_r: -0.3 })
  const r1 = evaluatePosition(pos, { currentPrice: 3405 }) // +0.25R
  assert.equal(r1.updates.mfe_r, 0.5, 'mfe holds the prior high')
  assert.equal(r1.updates.mae_r, -0.3, 'mae holds the prior low')

  const r2 = evaluatePosition(pos, { currentPrice: 3395 }) // -0.25R
  assert.equal(r2.updates.mae_r, -0.3)

  const r3 = evaluatePosition(pos, { currentPrice: 3375 }) // -1.25R
  assert.equal(r3.updates.mae_r, -1.25)
})

// Rule 1: time cap ---------------------------------------------------------

test('time cap expired → FULL_EXIT', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const res = evaluatePosition(pos, { currentPrice: 3405 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.exitFraction, 1)
  assert.match(res.reason, /time_cap_expired/)
})

test('time cap in the future → no exit on that rule', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  })
  const res = evaluatePosition(pos, { currentPrice: 3405 })
  assert.notEqual(res.action, 'FULL_EXIT')
})

// Rule 2: price-based invalidation trigger ---------------------------------

test('invalidation trigger "price<3390" fires for long when price drops', () => {
  const pos = longXAU({ invalidation_trigger: 'price<3390' })
  const res = evaluatePosition(pos, { currentPrice: 3385 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /invalidation_trigger/)
})

test('invalidation trigger "price>1.1050" fires for short when price rises', () => {
  const pos = shortEUR({ invalidation_trigger: 'price>1.1050' })
  const res = evaluatePosition(pos, { currentPrice: 1.1060 })
  assert.equal(res.action, 'FULL_EXIT')
})

test('free-text trigger is ignored by deterministic layer', () => {
  const pos = longXAU({
    invalidation_trigger: 'close below 3390 on 15m with >1.5x vol',
  })
  const res = evaluatePosition(pos, { currentPrice: 3385 })
  // No price parser match → should fall through to HOLD (LLM handles it)
  assert.notEqual(res.action, 'FULL_EXIT')
})

// Rule 3: partial exit -----------------------------------------------------

test('at +1.5R and not scaled_out → PARTIAL_EXIT + trail to +0.5R', () => {
  const pos = longXAU()
  const res = evaluatePosition(pos, { currentPrice: 3430 }) // +1.5R
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.equal(res.exitFraction, DEFAULT_RULES.partialFraction)
  assert.equal(res.newSL, 3410, 'SL trails to +0.5R = 3410')
  assert.equal(res.updates.scaled_out, 1)
  assert.equal(res.updates.be_moved, 1)
})

test('already scaled_out: no second partial', () => {
  const pos = longXAU({ scaled_out: 1, be_moved: 1, current_sl: 3410 })
  const res = evaluatePosition(pos, { currentPrice: 3430 }) // +1.5R
  assert.notEqual(res.action, 'PARTIAL_EXIT')
})

// Rule 4: runner trail -----------------------------------------------------

test('post-partial, at +2.5R → MOVE_SL trailing 1R behind', () => {
  const pos = longXAU({ scaled_out: 1, be_moved: 1, current_sl: 3410 })
  const res = evaluatePosition(pos, { currentPrice: 3450 }) // +2.5R
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3430, 'trail sits at +1.5R = 3430')
})

test('runner trail only tightens, never loosens', () => {
  const pos = longXAU({ scaled_out: 1, current_sl: 3445 }) // already high
  const res = evaluatePosition(pos, { currentPrice: 3450 })
  // trail would be 3430 which is looser than 3445 → engine skips
  assert.notEqual(res.action, 'MOVE_SL')
})

// Rule 5: breakeven move ---------------------------------------------------

test('at +0.7R and not be_moved → MOVE_SL to entry', () => {
  const pos = longXAU()
  const res = evaluatePosition(pos, { currentPrice: 3414 }) // +0.7R
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3400)
  assert.equal(res.updates.be_moved, 1)
})

test('be_moved already set → no BE re-trigger', () => {
  const pos = longXAU({ be_moved: 1, current_sl: 3400 })
  const res = evaluatePosition(pos, { currentPrice: 3414 })
  assert.notEqual(res.action, 'MOVE_SL')
  assert.equal(res.action, 'HOLD')
})

test('BE move works for shorts too (direction-aware)', () => {
  const pos = shortEUR()
  const res = evaluatePosition(pos, { currentPrice: 1.0986 }) // +0.7R
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(Math.round(res.newSL * 10000) / 10000, 1.1000)
})

// Rule 6: HOLD ------------------------------------------------------------

test('below all thresholds → HOLD', () => {
  const pos = longXAU()
  const res = evaluatePosition(pos, { currentPrice: 3405 }) // +0.25R
  assert.equal(res.action, 'HOLD')
  assert.equal(res.newSL, null)
  assert.equal(res.exitFraction, null)
})

test('no currentPrice → HOLD with null metrics but MFE preserved', () => {
  const pos = longXAU({ mfe_r: 1.2 })
  const res = evaluatePosition(pos, { currentPrice: null })
  assert.equal(res.action, 'HOLD')
  assert.equal(res.metrics.currentR, null)
  assert.equal(res.updates.mfe_r, 1.2)
})

// Precedence --------------------------------------------------------------

test('time cap beats partial-exit', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 1000).toISOString(),
  })
  const res = evaluatePosition(pos, { currentPrice: 3430 }) // would trigger partial
  assert.equal(res.action, 'FULL_EXIT')
})

test('invalidation beats BE move', () => {
  const pos = longXAU({ invalidation_trigger: 'price<3420' })
  // Price is +0.7R (3414) but also below invalidation? No, 3414 < 3420.
  const res = evaluatePosition(pos, { currentPrice: 3414 })
  assert.equal(res.action, 'FULL_EXIT')
})

// Parser ------------------------------------------------------------------

test('parsePriceTrigger handles whitespace and case', () => {
  const t = _internal.parsePriceTrigger('  PRICE  <  3400.5 ')
  assert.ok(t)
  assert.ok(t.fired(3400))
  assert.ok(!t.fired(3401))
})

test('parsePriceTrigger rejects garbage', () => {
  assert.equal(_internal.parsePriceTrigger(''), null)
  assert.equal(_internal.parsePriceTrigger(null), null)
  assert.equal(_internal.parsePriceTrigger('close below 3400 on 15m'), null)
})

// Bank target ---------------------------------------------------------------

test('bank target: FULL_EXIT at bankTriggerR — margin recycled out of a big winner', () => {
  // risk 20 → +4R = 3480. Default bankTriggerR is 4.
  const res = evaluatePosition(longXAU({ scaled_out: 1 }), { currentPrice: 3480 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /bank_target_4R/)
  assert.equal(res.exitFraction, 1)
})

test('bank target: beats the runner trail (a +17R LLY-style winner banks, not trails)', () => {
  const res = evaluatePosition(longXAU({ scaled_out: 1 }), { currentPrice: 3400 + 17 * 20 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /bank_target/)
})

test('bank target: below the trigger the runner trail still manages the trade', () => {
  // +3R with scaled_out → runner MOVE_SL (bank at 4R not reached)
  const res = evaluatePosition(longXAU({ scaled_out: 1 }), { currentPrice: 3460 })
  assert.equal(res.action, 'MOVE_SL')
  assert.match(res.reason, /runner_trail/)
})

test('bank target: disabled with bankTriggerR 0 — old trail-forever behaviour', () => {
  const res = evaluatePosition(longXAU({ scaled_out: 1 }), { currentPrice: 3480, rules: { bankTriggerR: 0 } })
  assert.equal(res.action, 'MOVE_SL')
  assert.match(res.reason, /runner_trail/)
})

test('bank target: per-class override flows through rules (crypto banks at 3R)', () => {
  const res = evaluatePosition(longXAU({ scaled_out: 1 }), { currentPrice: 3460, rules: { bankTriggerR: 3 } })
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /bank_target_3R/)
})
