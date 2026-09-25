// WEB-10 (8,989-A row 13). Owner default 25-09-2026: a close with no recorded
// price is drawn as a labelled gap, never as zero; the All view's chart opens
// on an account it can draw; decision bars say they count risk events only.
import { expect, it } from 'vitest'
import { performanceCurve, defaultChartAccount, curveMoney, DECISION_FEED_DAYS } from './performance-curve.js'
import { emptyPopulation, populationStats } from '../../agent/shared/performance-populations.js'

// One daily group: `priced` closes summing to `net`, plus `unpriced` closes.
const g = (accountId, day, net, priced = 1, unpriced = 0) => ({ accountId, day,
  stats: { ...emptyPopulation(), n: priced + unpriced, pricedN: priced, net: priced ? net : 0 } })
const report = (daily, extra = {}) => ({ status: 'complete', asOfMs: Date.parse('2026-09-25T00:00:00Z'), daily, ...extra })

it('an unpriced close breaks the line instead of withholding every priced close', () => {
  const c = performanceCurve(report([
    g('11', '2026-09-20', 100), g('11', '2026-09-21', -50), g('11', '2026-09-22', null, 0, 1), g('11', '2026-09-23', 20),
  ]), '11', [], 30)
  expect(c.moneyAvailable).toBe(true)
  expect(c.moneyState).toBe('gapped')
  expect(c.unpricedN).toBe(1); expect(c.unpricedDays).toBe(1)
  expect(c.rows.map(r => r.gap)).toEqual([false, false, true, false])
  expect(c.rows.map(r => r.afterGap)).toEqual([false, false, true, true])
  // The level after the break counts priced closes only; the unpriced day adds
  // nothing because nothing is known about it — it is flagged, not priced.
  expect(c.rows.map(r => r.equity)).toEqual([100, 50, 50, 70])
  expect(c.rows[2].pnl).toBeNull(); expect(c.rows[2].unpricedN).toBe(1)
  // Drawdown is measured within the unbroken stretch: the stretch that starts
  // at the gap has its own peak, so the pre-gap high does not leak across it.
  expect(c.rows[1].dd).toBe(-50)
  expect(c.rows[3].peak).toBe(70); expect(c.rows[3].dd).toBe(0)
})

it('a day with priced and unpriced closes keeps its priced money and is still a break', () => {
  const c = performanceCurve(report([g('11', '2026-09-21', 10), g('11', '2026-09-22', 30, 1, 2)]), '11', [], 30)
  expect(c.rows[1]).toMatchObject({ gap: true, pnl: 30, closes: 3, unpricedN: 2, equity: 40 })
  expect(c.unpricedN).toBe(2)
})

it('a range where no close has a price is still withheld, and pooled accounts name the pooling', () => {
  const none = performanceCurve(report([g('11', '2026-09-22', null, 0, 2)]), '11', [], 30)
  expect(none.moneyAvailable).toBe(false); expect(none.reason).toBe('unpriced_closes')
  expect(none.rows[0].equity).toBeNull(); expect(none.rows[0].unpricedN).toBe(2)
  const pooled = performanceCurve(report([g('11', '2026-09-21', 5), g('22', '2026-09-22', null, 0, 1)]), 'all', [], 30)
  expect(pooled.moneyAvailable).toBe(false)
  expect(pooled.reason).toBe('unverified_cross_account_units')
  expect(pooled.rows.every(r => r.equity == null && !r.gap)).toBe(true)
})

it('a fully priced range is unchanged: no gaps, exact from zero', () => {
  const c = performanceCurve(report([g('11', '2026-09-21', 100), g('11', '2026-09-22', -10)]), '11', [], 30)
  expect(c.moneyState).toBe('complete'); expect(c.reason).toBe('recorded_close_units')
  expect(c.rows.map(r => [r.equity, r.gap, r.afterGap])).toEqual([[100, false, false], [90, false, false]])
})

it('days older than the decision feed have no count, not a zero bar', () => {
  expect(DECISION_FEED_DAYS).toBe(90)
  const c = performanceCurve(report([g('11', '2026-06-20', 5)], { timeZone: 'UTC' }), '11',
    [{ day: '2026-09-20', approved: 2, vetoed: 7, vetoed_distinct: 3 }], null)
  const at = day => c.rows.find(r => r.day === day)
  // asOf 2026-09-25T00:00Z − 90 days = 2026-06-27T00:00Z: that day is only
  // partly covered, so it and every older day are unknown.
  expect(at('2026-06-20')).toMatchObject({ decisionsKnown: false, approved: null, vetoed: null })
  expect(at('2026-06-27')).toMatchObject({ decisionsKnown: false, approved: null })
  expect(at('2026-06-28')).toMatchObject({ decisionsKnown: true, approved: 0, vetoed: 0 })
  expect(at('2026-09-20')).toMatchObject({ decisionsKnown: true, approved: 2, vetoed: 7, vetoedDistinct: 3 })
  expect(c.decisionDaysNotRetained).toBe(8)
  // The close itself is still on the line: retention limits decisions only.
  expect(at('2026-06-20').equity).toBe(5)
})

it('without a decision feed every day is unknown rather than zero', () => {
  const c = performanceCurve(report([g('11', '2026-09-22', 5)]), '11', null, 30)
  expect(c.decisionState).toBe('unavailable')
  expect(c.rows[0].approved).toBeNull()
})

it('the All view opens on the first account whose curve can be drawn, judged over the whole report', () => {
  const r = report([
    g('489', '2026-09-21', 3), g('489', '2026-09-22', null, 0, 1), // gapped
    g('342', '2026-09-20', 7), // complete
    g('908', '2026-09-19', 4), // complete, later in the list
    g('000', '2026-09-18', null, 0, 2), // nothing priced
  ])
  const acct = id => ({ account_id: id })
  expect(defaultChartAccount(r, ['489', '148', '342', '908'].map(acct))).toBe('342')
  // No complete account: a gapped one beats a known-zero one…
  expect(defaultChartAccount(r, ['148', '489'].map(acct))).toBe('489')
  // …and a known-zero line beats one with nothing priced.
  expect(defaultChartAccount(r, ['000', '148'].map(acct))).toBe('148')
  expect(defaultChartAccount(r, ['000'].map(acct))).toBe('000')
  // Before the report arrives nothing can be judged: the first account.
  expect(defaultChartAccount(null, ['489', '342'].map(acct))).toBe('489')
  expect(defaultChartAccount(r, [])).toBe('all')
  // Numeric ids from /state/accounts compare as strings.
  expect(defaultChartAccount(r, [{ account_id: 489 }, { account_id: 342 }])).toBe('342')
})

it('curveMoney reads the population the same way the ledger does', () => {
  expect(curveMoney(populationStats([g('11', 'd', 5, 1, 1)], { accountId: '11' })).moneyState).toBe('gapped')
  expect(curveMoney(populationStats([], { accountId: '11' })).moneyState).toBe('complete')
  expect(curveMoney(populationStats([], { available: false })).reason).toBe('unavailable')
})
