import { expect, it } from 'vitest'
import { performanceCurve } from './performance-curve.js'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'
it('continues local close totals through today without inventing current floating profit', () => {
  const r = { status: 'complete', timeZone: 'Asia/Singapore', asOfMs: Date.parse('2026-09-24T22:00:00Z'),
    daily: [{ accountId: '11', day: '2026-09-23', stats: { ...emptyPopulation(), n: 1, pricedN: 1, net: 20 } }] }
  const c = performanceCurve(r, '11', [], 30)
  expect(c.rows.map(r => r.equity)).toEqual([20, 20, 20])
  expect(c.rows.at(-1).t).toBe(Date.parse('2026-09-25'))
  expect(c.rows.at(-1).pnl).toBeNull()
})

it('range selection retains the local date across UTC boundaries', () => {
  const r = { status: 'complete', timeZone: 'America/Los_Angeles', asOfMs: Date.parse('2026-09-25T02:00:00Z'),
    daily: ['2026-09-22', '2026-09-23', '2026-09-24'].map(day => ({ accountId: '11', day, stats: { ...emptyPopulation(), n: 1, pricedN: 1, net: 2 } })) }
  expect(performanceCurve(r, '11', [], 1).rows.map(r => r.t)).toEqual([Date.parse('2026-09-23'), Date.parse('2026-09-24')])
})
