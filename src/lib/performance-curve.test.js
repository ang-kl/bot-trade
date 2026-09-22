import { expect, it } from 'vitest'
import { performanceCurve } from './performance-curve.js'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'
const g = (accountId, day, net, n = 1) => ({ accountId, day, stats: { ...emptyPopulation(), n, pricedN: net == null ? 0 : n, net: net ?? 0 } })
const report = daily => ({ status: 'complete', asOfMs: Date.parse('2026-09-23T00:00:00Z'), daily })
it('uses complete daily aggregates and keeps path chronology', () => {
  const c = performanceCurve(report([g('11', '2026-09-22', -10), g('11', '2026-09-21', 100, 201)]), '11', [], 30)
  expect(c.pricedN).toBe(202); expect(c.rows.map(r => r.equity)).toEqual([100, 90]); expect(c.rows[1].dd).toBe(-10)
})
it('does not accumulate different accounts just because they closed on different days', () => {
  const c = performanceCurve(report([g('11', '2026-09-21', 100), g('22', '2026-09-22', -10)]), 'all', [], 30)
  expect(c.moneyAvailable).toBe(false); expect(c.rows.every(r => r.equity == null)).toBe(true)
})
it('missing report or unpriced closes never draw a flat zero equity claim', () => {
  expect(performanceCurve(null, '11', [{ day: '2026-09-22', approved: 1 }], 30).rows[0].equity).toBe(null)
  expect(performanceCurve(report([g('11', '2026-09-22', null)]), '11', [], 30).reason).toBe('unpriced_closes')
})
