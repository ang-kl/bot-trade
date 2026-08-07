// campaign-stop.test.js — the drawdown limit that spans days.
//
// The claim under test is that this is OFF unless fully armed, that it measures
// from the STARTING equity rather than a high-water mark, and that an
// uncomputable total halts rather than passes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { campaignConfig, campaignStopVerdict, campaignReadout, DEFAULT_CAMPAIGN } from './campaign-stop.js'

const ARMED = campaignConfig({
  maxDrawdownPct: 0.08, startEquity: 46_073, startAt: '2026-08-07T00:00:00Z', label: 'concentrate-to-prove',
})
// 8% of 46,073 = 3,685.84 of budget.

test('off by default, and off on any partial config', () => {
  assert.equal(DEFAULT_CAMPAIGN.maxDrawdownPct, null)
  assert.equal(campaignConfig(null).armed, false)
  // A campaign needs all three: a percentage, a starting equity AND a start
  // time. Two out of three is not a campaign, it is a guess about the anchor.
  assert.equal(campaignConfig({ maxDrawdownPct: 0.08 }).armed, false)
  assert.equal(campaignConfig({ maxDrawdownPct: 0.08, startEquity: 46_073 }).armed, false)
  assert.equal(campaignConfig({ startEquity: 46_073, startAt: '2026-08-07' }).armed, false)
  assert.equal(ARMED.armed, true)
})

test('a nonsense percentage disarms rather than clamping to something plausible', () => {
  const base = { startEquity: 46_073, startAt: '2026-08-07T00:00:00Z' }
  assert.equal(campaignConfig({ ...base, maxDrawdownPct: 0 }).armed, false)
  assert.equal(campaignConfig({ ...base, maxDrawdownPct: 1 }).armed, false, '100% is not a drawdown limit')
  assert.equal(campaignConfig({ ...base, maxDrawdownPct: -0.08 }).armed, false)
  assert.equal(campaignConfig({ ...base, maxDrawdownPct: 'eight' }).armed, false)
})

test('an unarmed campaign never halts anything', () => {
  const v = campaignStopVerdict({ cfg: campaignConfig(null), realisedSinceStart: -999_999 })
  assert.equal(v.halt, false)
  assert.equal(v.reason, null)
})

test('inside the budget it reports the spend and lets trading continue', () => {
  const v = campaignStopVerdict({ cfg: ARMED, realisedSinceStart: -1_000 })
  assert.equal(v.halt, false)
  assert.equal(v.drawdownUsd, 1_000)
  assert.equal(v.remainingUsd, 2_685.84)
  assert.equal(v.drawdownPct, 0.0217)
})

test('at the limit it halts, and the reason says the daily cap will not save you', () => {
  const v = campaignStopVerdict({ cfg: ARMED, realisedSinceStart: -3_685.84 })
  assert.equal(v.halt, true)
  assert.equal(v.remainingUsd, 0)
  assert.match(v.reason, /campaign_stop \(concentrate-to-prove\)/)
  assert.match(v.reason, /8\.00% campaign limit/)
  assert.match(v.reason, /The daily cap resets tomorrow; this does not\./)
})

test('measured from STARTING equity, not from the high-water mark', () => {
  // The campaign ran to +10,000 and then gave back 3,700. A high-water anchor
  // would call that a 13,700 drawdown and halt; measuring from the start says
  // the account is still up and nothing has been spent. The start anchor is
  // deliberate: a high-water anchor keeps moving the line up and silently
  // widens the allowance after every good day.
  const v = campaignStopVerdict({ cfg: ARMED, realisedSinceStart: 6_300 })
  assert.equal(v.halt, false)
  assert.equal(v.drawdownUsd, 0, 'a campaign in profit has spent none of its loss budget')
})

test('an uncomputable total halts — silence is not safety', () => {
  for (const bad of [null, undefined, NaN, 'nope']) {
    const v = campaignStopVerdict({ cfg: ARMED, realisedSinceStart: bad })
    assert.equal(v.halt, true, `${String(bad)} must halt`)
    assert.match(v.reason, /could not be computed/)
  }
})

test('the readout gives one number a human can act on', () => {
  const r = campaignReadout({
    cfg: ARMED, realisedSinceStart: -1_842.92,
    nowMs: Date.parse('2026-08-10T00:00:00Z'),
  })
  assert.equal(r.armed, true)
  assert.equal(r.budgetUsd, 3_685.84)
  assert.equal(r.budgetUsedFrac, 0.5, 'half the campaign budget gone')
  assert.equal(r.daysIn, 3)
  assert.equal(r.halt, false)
})

test('the readout of an unarmed campaign says so rather than showing zeros', () => {
  const r = campaignReadout({ cfg: campaignConfig(null), realisedSinceStart: -500 })
  assert.equal(r.armed, false)
  assert.equal(r.halt, false)
  // No budget, no fraction — a 0% used bar on an unarmed campaign would read as
  // "protected and untouched", which is the opposite of the truth.
  assert.equal(r.budgetUsedFrac, undefined)
})

test('budgetUsedFrac is capped at 1 so a breach cannot render past full', () => {
  const r = campaignReadout({ cfg: ARMED, realisedSinceStart: -99_999, nowMs: Date.parse('2026-08-08T00:00:00Z') })
  assert.equal(r.budgetUsedFrac, 1)
  assert.equal(r.halt, true)
})
