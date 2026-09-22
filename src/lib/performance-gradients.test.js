import { describe, it, expect } from 'vitest'
import { performanceGradients } from './performance-gradients.js'
import { aggregateAccounts } from './perf-aggregate.js'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'
const group = (accountId, net) => ({ accountId, sym: 'EURUSD', market: 'fx', strat: 'ema_cross',
  stats: { ...emptyPopulation(), n: 1, pricedN: 1, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
function report(groups) { return { status: 'complete', windows: ['1h', '12m', '30d'].map(key => ({ key, label: key, ledger: true, groups })) } }
describe('performance gradients', () => {
  it('uses full population groups and unrounded numbers for overlapping footings', () => {
    const r = performanceGradients(report([group('11', 0.125)]), [{ id: '11', name: 'A' }], s => s)
    expect(r.t[0].cells[0].v).toBe('+0.13')
    expect(r.tWideSub[0].raw).toBe(0.375)
    expect(r.tWideSub[0].v).toBe('+0.38')
    expect(r.t[0].cells[0].v).not.toContain('$')
  })
  it('keeps each account value while refusing a cross-account money total', () => {
    const r = performanceGradients(report([group('11', 20), group('22', -5)]), [{ id: '11', name: 'A' }, { id: '22', name: 'B' }], s => s)
    expect(r.t[0].cells.map(c => c.raw)).toEqual([20, -5, null])
    expect(r.t[0].cells[2].v).toBe('—')
  })
  it('does not consolidate account cards with unverified units or infer their risk usage', () => {
    const r = aggregateAccounts([{ id: '11', ccy: 'unknown', bal: 10, day: -2, cap: 1, moneyVerified: false }, { id: '22', ccy: 'unknown', bal: 30, day: 4, cap: 2, moneyVerified: false }])
    expect(r.groups).toHaveLength(2)
    expect(r.groups.every(g => g.usedPct == null)).toBe(true)
    expect(r.groups.map(g => g.bal).sort((a, b) => a - b)).toEqual([10, 30])
  })
  it('does not turn a failed report into zero', () => {
    const r = performanceGradients(null, [{ id: '11', name: 'A' }], s => s)
    expect(r.t).toEqual([])
    expect(r.a[0].cells[0].v).toBe('—')
    const zero = performanceGradients(report([]), [{ id: '11', name: 'A' }], s => s)
    expect(zero.t[0].cells[0].v).toBe('0')
  })
})
