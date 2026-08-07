// early-trim.test.js — the shadow trim (owner: "ship T2 log-only now").
//
// The behavioural claim under test is that this module DECIDES and never ACTS,
// so the tests are about the decision boundary and the refusals. There is no
// act path to test, which is itself the point.

import test from 'node:test'
import assert from 'node:assert/strict'
import { earlyTrimDecision, earlyTrimConfig, earlyTrimShadowRow, DEFAULT_EARLY_TRIM } from './early-trim.js'

const ON = earlyTrimConfig({ enabled: true })
// LONG 100 entry, 90 stop → 10 of risk distance, so 1R = 110.
const LONG = { side: 'LONG', entry: 100, originalSl: 90, volume: 1000, cfg: ON }

test('off by default — a feature that writes shadow rows must be asked for', () => {
  assert.equal(DEFAULT_EARLY_TRIM.enabled, false)
  assert.equal(earlyTrimDecision({ ...LONG, price: 120, cfg: earlyTrimConfig(null) }).trim, false)
  assert.equal(earlyTrimDecision({ ...LONG, price: 120, cfg: earlyTrimConfig(null) }).reason, 'disabled')
})

test('fires exactly at the threshold, not before', () => {
  assert.equal(earlyTrimDecision({ ...LONG, price: 109.9 }).trim, false)
  assert.equal(earlyTrimDecision({ ...LONG, price: 109.9 }).reason, 'below_threshold')
  const at = earlyTrimDecision({ ...LONG, price: 110 })
  assert.equal(at.trim, true)
  assert.equal(at.rNow, 1)
  assert.equal(at.trimVolume, 500)
  assert.equal(at.remainVolume, 500)
})

test('R is signed by direction — a short in profit is a lower price', () => {
  const short = { side: 'SHORT', entry: 100, originalSl: 110, volume: 1000, cfg: ON }
  assert.equal(earlyTrimDecision({ ...short, price: 90 }).trim, true)
  // The same price that pays a long loses for a short.
  assert.equal(earlyTrimDecision({ ...short, price: 110 }).trim, false)
})

test('R uses the ORIGINAL stop — a ratcheted stop must not manufacture 1R', () => {
  // The keeper has trailed the live stop to 108. Against THAT the trade looks
  // like +5R at 109; against the original 90 it is +0.9R and must not trim.
  // Passing the ratcheted stop in is the bug this asserts against, so the test
  // is the same call with the wrong input and the right one.
  assert.equal(earlyTrimDecision({ ...LONG, price: 109 }).trim, false)
  assert.equal(earlyTrimDecision({ ...LONG, originalSl: 108, price: 109 }).trim, true)
})

test('one trim per position, ever — not one per leg', () => {
  const r = earlyTrimDecision({ ...LONG, price: 200, alreadyTrimmed: true })
  assert.equal(r.trim, false)
  assert.equal(r.reason, 'already_trimmed')
})

test('refuses to leave a remnant under the broker minimum', () => {
  const r = earlyTrimDecision({ ...LONG, price: 120, volume: 150, minVolume: 100 })
  assert.equal(r.trim, false)
  assert.match(r.reason, /remainder_below_min_lot remain=75 min=100/)
  // Same position, no minimum declared: the guard cannot fire on unknown data.
  assert.equal(earlyTrimDecision({ ...LONG, price: 120, volume: 150 }).trim, true)
})

test('no original stop means the rule cannot be evaluated, not that it passes', () => {
  const r = earlyTrimDecision({ ...LONG, originalSl: null, price: 500 })
  assert.equal(r.trim, false)
  assert.equal(r.reason, 'no_original_stop')
})

test('a stop AT the entry is refused rather than treated as infinite R', () => {
  const r = earlyTrimDecision({ ...LONG, originalSl: 100, price: 101 })
  assert.equal(r.trim, false)
  assert.equal(r.reason, 'stop_at_entry')
})

test('breakeven rides with the trim, and can be turned off explicitly', () => {
  assert.equal(earlyTrimDecision({ ...LONG, price: 110 }).slToBreakeven, 100)
  const noBe = earlyTrimConfig({ enabled: true, moveSlToBreakeven: false })
  assert.equal(earlyTrimDecision({ ...LONG, price: 110, cfg: noBe }).slToBreakeven, null)
})

test("mode is 'log' whatever the config says — there is no act path here", () => {
  assert.equal(earlyTrimConfig({ enabled: true, mode: 'act' }).mode, 'log')
  assert.equal(earlyTrimConfig({ enabled: true, mode: 'anything' }).mode, 'log')
})

test('a non-trim decision still reports rNow — the refusals are the data', () => {
  const r = earlyTrimDecision({ ...LONG, price: 105 })
  assert.equal(r.trim, false)
  assert.equal(r.rNow, 0.5, 'a week of these is what makes the shadow record readable')
})

test('the shadow row says applied:false on its face', () => {
  const d = earlyTrimDecision({ ...LONG, price: 110 })
  const row = earlyTrimShadowRow(d, { symbol: 'EURUSD', positionId: '1', tradeId: 2, accountId: 'A', price: 110 })
  assert.equal(row.applied, false)
  assert.equal(row.kind, 'early_trim_shadow')
  assert.equal(row.wouldTrimVolume, 500)
  assert.equal(row.wouldMoveSlTo, 100)
})

test('malformed config leaves the feature off rather than half-configured', () => {
  const c = earlyTrimConfig({ enabled: true, atR: 'nonsense', frac: -1 })
  assert.equal(c.atR, DEFAULT_EARLY_TRIM.atR)
  assert.equal(c.frac, DEFAULT_EARLY_TRIM.frac)
  assert.equal(earlyTrimConfig('not an object').enabled, false)
})
