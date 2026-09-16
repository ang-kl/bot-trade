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

test('time cap expired on a LOSER → FULL_EXIT, same reason string as ever', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const res = evaluatePosition(pos, { currentPrice: 3390 }) // −0.5R
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.exitFraction, 1)
  assert.match(res.reason, /^time_cap_expired \(/)
})

// PR-J (11-09-2026) — measured over five broker statements / 95 bot deals:
// winners' median move +0.39% against losers' −0.76%, avg win ÷ avg loss 0.72
// at a 51% win rate, and ten positions closed in one batch at 21:31 SGT by
// this very rule after 17–21h held, several in profit. The cap now closes
// losers only.
test('PR-J: time cap expired on a WINNER → trails instead of closing, and the stop only tightens', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 60_000).toISOString(),
    current_sl: 3380,
  })
  const res = evaluatePosition(pos, { currentPrice: 3440, atr: undefined }) // +2R
  assert.equal(res.action, 'MOVE_SL', 'a winner at the cap is not closed')
  assert.match(res.reason, /time_cap_trailing/)
  // 1.5 × 1R (no ATR supplied) behind the +2R peak = +0.5R = 3410.
  assert.equal(res.newSL, 3410)
  assert.ok(res.newSL > pos.current_sl, 'tighten-only')
  assert.ok(res.updates.time_cap_trail_at, 'the pass is stamped')
})

test('PR-J: the cap trail uses ATR when the caller has one', () => {
  const pos = longXAU({ time_cap_at: new Date(Date.now() - 60_000).toISOString() })
  const res = evaluatePosition(pos, { currentPrice: 3440, atr: 4 }) // 1.5 × 4 = 6 behind 3440
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3434)
  assert.match(res.reason, /1.5×ATR/)
})

test('PR-J: the cap NEVER loosens a stop — it refuses the hold and closes instead', () => {
  // Stop already at +1.5R (3430); the trail would sit at +0.5R (3410) and the
  // breakeven floor at 3400, both looser. Checker B1: a hold that cannot
  // improve the stop is an unpriced extension of risk, so the cap closes the
  // position exactly as it did before PR-J. RED if a looser stop is proposed.
  const capAt = new Date(Date.now() - 60_000).toISOString()
  const pos = longXAU({ time_cap_at: capAt, current_sl: 3430 })
  const res = evaluatePosition(pos, { currentPrice: 3440 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.reason, `time_cap_expired (${capAt})`)
  assert.equal(res.newSL, null, 'no stop is proposed at all, let alone a looser one')
  assert.equal(res.updates.time_cap_trail_at, undefined, 'nothing is stamped when nothing was held')
})

// ---------------------------------------------------------------------------
// CHECKER B1 (11-09-2026) — the band the measurement is actually about.
//
// The winners' median move is +0.39 % against 1–3 % stops, i.e. roughly +0.13R
// to +0.39R. The first version of this rule trailed at `peak − 1.5 × 1R` with
// no floor, so with the entry stop at −1R it tightened nothing below peak 1.5R:
// every position in the 21:31 batch would have been stamped, held for up to
// 72 h, and left at FULL ORIGINAL RISK — turning a realised +0.13R…+0.39R back
// into −1R of open risk, ten times over. These cases are that band.
// ---------------------------------------------------------------------------

for (const [r, price] of [[0.13, 3402.6], [0.2, 3404], [0.39, 3407.8], [0.5, 3410], [0.9, 3418]]) {
  test(`PR-J/B1: a held winner at +${r}R is protected at breakeven, never left at full risk`, () => {
    const pos = longXAU({ time_cap_at: new Date(Date.now() - 60_000).toISOString(), current_sl: 3380 })
    const res = evaluatePosition(pos, { currentPrice: price })
    assert.equal(res.action, 'MOVE_SL', 'the position is held')
    assert.match(res.reason, /time_cap_trailing/)
    assert.ok(res.newSL > pos.current_sl, `the stop must TIGHTEN (got ${res.newSL} vs ${pos.current_sl})`)
    assert.ok(res.newSL >= pos.entry_price, 'and never sit worse than breakeven')
    assert.equal(res.newSL, 3400, 'peak − 1.5R is below entry in this band, so the floor is breakeven')
    assert.ok(res.updates.time_cap_trail_at)
  })
}

test('PR-J/B1: a SHORT held in the same band is floored at breakeven too', () => {
  const pos = shortEUR({ time_cap_at: new Date(Date.now() - 60_000).toISOString() })
  const res = evaluatePosition(pos, { currentPrice: 1.0996 }) // +0.2R
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, pos.entry_price)
  assert.ok(res.newSL < pos.current_sl, 'a short tightens by lowering the stop')
})

test('PR-J/B1: a stop already at or above breakeven is not loosened — the cap closes', () => {
  // Stop at +0.25R, position at +0.5R: breakeven and peak−1.5R are both looser
  // than what the position already has, so the hold is refused.
  const capAt = new Date(Date.now() - 60_000).toISOString()
  const pos = longXAU({ time_cap_at: capAt, current_sl: 3405 })
  const res = evaluatePosition(pos, { currentPrice: 3410 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.reason, `time_cap_expired (${capAt})`)
})

test('PR-J/B1: a stop-less row gets a stop at breakeven, never at peak − 1.5R', () => {
  // isTighter() answers true for a null stop, so without the floor this would
  // PLACE a stop at −1.3R on a +0.2R position (checker minor 3).
  const pos = longXAU({ time_cap_at: new Date(Date.now() - 60_000).toISOString(), current_sl: null })
  const res = evaluatePosition(pos, { currentPrice: 3404 })
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3400, 'entry, not 3400 − 1.3 × 20')
})

test('PR-J: a SHORT winner at the cap trails downward, tighten-only', () => {
  const pos = shortEUR({ time_cap_at: new Date(Date.now() - 60_000).toISOString() })
  const res = evaluatePosition(pos, { currentPrice: 1.0960 }) // +2R
  assert.equal(res.action, 'MOVE_SL')
  assert.ok(res.newSL < pos.current_sl, 'a short tightens by lowering the stop')
  assert.ok(Math.abs(res.newSL - 1.0990) < 1e-9, 'peak +2R minus 1.5R = +0.5R')
})

test('PR-J: the stamp stops the cap being re-evaluated — the ladder governs from then on', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 60_000).toISOString(),
    time_cap_trail_at: new Date(Date.now() - 30_000).toISOString(),
    current_sl: 3410,
    mfe_r: 2,
  })
  const res = evaluatePosition(pos, { currentPrice: 3440 })
  assert.notEqual(res.action, 'FULL_EXIT')
  assert.doesNotMatch(res.reason, /time_cap_trailing/, 'the cap branch does not fire twice')
})

test('PR-J: the backstop closes the held winner at timeCapMaxExtraHours', () => {
  const capAt = new Date(Date.now() - 73 * 3_600_000).toISOString()
  const pos = longXAU({ time_cap_at: capAt, time_cap_trail_at: capAt, mfe_r: 2 })
  const res = evaluatePosition(pos, { currentPrice: 3440 })
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /time_cap_expired_backstop/)
  assert.equal(res.exitFraction, 1)
  // And one hour short of it, the position is still held.
  const inside = evaluatePosition(
    longXAU({ time_cap_at: new Date(Date.now() - 71 * 3_600_000).toISOString(), time_cap_trail_at: capAt, mfe_r: 2 }),
    { currentPrice: 3440 },
  )
  assert.notEqual(inside.action, 'FULL_EXIT')
})

test('PR-J REVERT SWITCH: timeCapHoldWinners:false reproduces the pre-PR-J close exactly', () => {
  const capAt = new Date(Date.now() - 60_000).toISOString()
  const pos = longXAU({ time_cap_at: capAt })
  const res = evaluatePosition(pos, { currentPrice: 3440, rules: { timeCapHoldWinners: false } })
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.exitFraction, 1)
  assert.equal(res.reason, `time_cap_expired (${capAt})`)
  assert.equal(res.newSL, null)
  assert.equal(res.updates.time_cap_trail_at, undefined, 'nothing is stamped in the old behaviour')
})

test('PR-J: timeCapHoldMinR raises the bar for what counts as a winner', () => {
  const pos = longXAU({ time_cap_at: new Date(Date.now() - 60_000).toISOString() })
  const held = evaluatePosition(pos, { currentPrice: 3420, rules: { timeCapHoldMinR: 0.5 } }) // +1R
  assert.equal(held.action, 'MOVE_SL')
  const closed = evaluatePosition(pos, { currentPrice: 3405, rules: { timeCapHoldMinR: 0.5 } }) // +0.25R
  assert.equal(closed.action, 'FULL_EXIT')
  assert.match(closed.reason, /^time_cap_expired \(/)
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

test('time cap beats partial-exit (pre-PR-J behaviour, pinned by the revert switch)', () => {
  const pos = longXAU({
    time_cap_at: new Date(Date.now() - 1000).toISOString(),
  })
  const res = evaluatePosition(pos, { currentPrice: 3430, rules: { timeCapHoldWinners: false } })
  assert.equal(res.action, 'FULL_EXIT')
})

test('time cap still beats partial-exit for a LOSER under the PR-J default', () => {
  const pos = longXAU({ time_cap_at: new Date(Date.now() - 1000).toISOString() })
  const res = evaluatePosition(pos, { currentPrice: 3392 }) // −0.4R
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

// ---------------------------------------------------------------------------
// Production, 2026-08-03 (owner screenshot, account 43097342): seven burn-in
// positions whose thesis said "closes in ≤12m" were still open 5h18m to 8h31m
// past their time caps, holding −$52.91. Every one had entry_price null and
// logged "Price data unavailable", so currentR returned null and the function
// bailed at the price gate — which sat ABOVE the time-cap check.
// ---------------------------------------------------------------------------
test('TIME CAP fires even when the position cannot be priced', () => {
  const pos = {
    id: 1, symbol: '9618.HK', side: 'long',
    entry_price: null,               // the production shape
    current_sl: 127.402, current_tp: null,
    initial_risk: 3.04, mfe_r: 0, mae_r: 0, be_moved: 0, scaled_out: 0,
    invalidation_trigger: null,
    time_cap_at: '2026-08-03T01:48:20.405Z',
    created_at: '2026-08-03 01:36:20',
  }
  const out = evaluatePosition(pos, { currentPrice: null, now: new Date('2026-08-03T07:00:00Z') })
  assert.equal(out.action, 'FULL_EXIT', 'an unpriceable position past its cap must still exit')
  assert.match(out.reason, /time_cap_expired/)
  assert.equal(out.exitFraction, 1)
})

test('an unpriceable position BEFORE its cap still holds', () => {
  // The fix must not turn "no price" into "close everything".
  const pos = {
    id: 2, symbol: 'VIX', side: 'long', entry_price: null,
    current_sl: 17.26, current_tp: 18.35, initial_risk: 1, mfe_r: 0, mae_r: 0,
    be_moved: 0, scaled_out: 0, invalidation_trigger: null,
    time_cap_at: '2026-08-03T09:00:00.000Z',
    created_at: '2026-08-03 08:50:00',
  }
  const out = evaluatePosition(pos, { currentPrice: null, now: new Date('2026-08-03T08:55:00Z') })
  assert.equal(out.action, 'HOLD')
  assert.equal(out.reason, 'no_current_price')
})

test('a position with NO time cap and no price is unaffected', () => {
  const pos = {
    id: 3, symbol: 'EURUSD', side: 'long', entry_price: 1.1,
    current_sl: 1.09, current_tp: null, initial_risk: 0.01, mfe_r: 0, mae_r: 0,
    be_moved: 0, scaled_out: 0, invalidation_trigger: null,
    time_cap_at: null, created_at: '2026-08-03 08:50:00',
  }
  const out = evaluatePosition(pos, { currentPrice: null, now: new Date('2026-08-03T09:55:00Z') })
  assert.equal(out.action, 'HOLD')
  assert.equal(out.reason, 'no_current_price')
})

// ---------------------------------------------------------------------------
// PR-J rule 2: the bank target becomes a PARTIAL, and the rest trails.
//
// Same measurement as the time-cap change: the whole-position take at +1R is
// what capped the winners while the losers ran to full stops (avg win ÷ avg
// loss 0.72 over 95 deals). `bankFraction` 1 — the default HERE — is still the
// pre-PR-J whole close; managed-exit.js is what sets it to 0.5, and only for
// the families the take is scoped to.
// ---------------------------------------------------------------------------

test('PR-J: bankFraction 0.5 banks half and trails the remainder from at least breakeven', () => {
  const pos = longXAU({ scaled_out: 0, current_sl: 3380 })
  const res = evaluatePosition(pos, {
    currentPrice: 3420, // +1R
    rules: { bankTriggerR: 1, bankFraction: 0.5, partialTriggerR: Infinity, runnerTriggerR: Infinity },
  })
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.equal(res.exitFraction, 0.5)
  assert.match(res.reason, /bank_partial_1R 50%/)
  // 1.5R behind the +1R peak is −0.5R, below entry → floored at breakeven.
  assert.equal(res.newSL, pos.entry_price)
  assert.ok(res.newSL > pos.current_sl, 'tighten-only')
  assert.equal(res.updates.scaled_out, 1)
  assert.equal(res.updates.be_moved, 1)
  assert.ok(res.updates.bank_partial_at, 'the bank is stamped')
})

test('PR-J: the remainder is NEVER re-banked at the same trigger', () => {
  const pos = longXAU({
    scaled_out: 1, be_moved: 1, current_sl: 3400, mfe_r: 1,
    bank_partial_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const res = evaluatePosition(pos, {
    currentPrice: 3420,
    rules: { bankTriggerR: 1, bankFraction: 0.5, partialTriggerR: Infinity, runnerTriggerR: Infinity, alwaysTrailR: 0.5 },
  })
  assert.notEqual(res.action, 'PARTIAL_EXIT', 'no loop of ever-smaller partials')
  assert.notEqual(res.action, 'FULL_EXIT')
  assert.doesNotMatch(res.reason, /bank_partial/)
})

test('PR-J REVERT SWITCH: bankFraction 1.0 reproduces the pre-PR-J full close exactly', () => {
  const pos = longXAU({ scaled_out: 0 })
  const res = evaluatePosition(pos, {
    currentPrice: 3420,
    rules: { bankTriggerR: 1, bankFraction: 1, partialTriggerR: Infinity, runnerTriggerR: Infinity },
  })
  assert.equal(res.action, 'FULL_EXIT')
  assert.equal(res.exitFraction, 1)
  assert.equal(res.reason, 'bank_target_1R (current R=1.00)')
  assert.equal(res.updates.bank_partial_at, undefined)
})

test('PR-J: a SHORT banks half and floors its stop at breakeven too', () => {
  const pos = shortEUR()
  const res = evaluatePosition(pos, {
    currentPrice: 1.0980, // +1R
    rules: { bankTriggerR: 1, bankFraction: 0.5, partialTriggerR: Infinity, runnerTriggerR: Infinity },
  })
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.equal(res.newSL, pos.entry_price)
  assert.ok(res.newSL < pos.current_sl, 'a short tightens by lowering the stop')
})

test('PR-J: with an ATR the remainder trails behind the peak, not at breakeven', () => {
  const pos = longXAU({ current_sl: 3380, mfe_r: 3 })
  const res = evaluatePosition(pos, {
    currentPrice: 3460, // +3R
    atr: 5,             // 1.5 × 5 = 7.5 behind 3460 → 3452.5, above entry
    rules: { bankTriggerR: 1, bankFraction: 0.5, partialTriggerR: Infinity, runnerTriggerR: Infinity },
  })
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.equal(res.newSL, 3452.5)
})
