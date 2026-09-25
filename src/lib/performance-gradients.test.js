import { describe, it, expect } from 'vitest'
import { performanceGradients, gradientData, gradientFoot, OVERLAP_LABEL } from './performance-gradients.js'
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
    expect(r.a[0].cells[0].why.key).toBe('report')
    const zero = performanceGradients(report([]), [{ id: '11', name: 'A' }], s => s)
    expect(zero.t[0].cells[0].v).toBe('0')
  })
})

// WEB-7 (8,989-A rows 7-9).
const g = (accountId, net, { market = 'fx', strat = 'ema_pullback', n = 1, pricedN = 1 } = {}) => ({ accountId, sym: 'X', market, strat,
  stats: { ...emptyPopulation(), n, pricedN, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
const ccyReport = (groups, currencies) => ({ ...report(groups),
  currencyByAccount: Object.fromEntries(Object.entries(currencies).map(([id, currency]) => [id, { currency }])) })
const ABC = [{ id: '11', name: 'A' }, { id: '22', name: 'B' }, { id: '33', name: 'C' }]
describe('performance gradients per currency', () => {
  const r = performanceGradients(ccyReport([g('11', 20), g('22', -5), g('33', 7, { market: 'stock' })], { 11: 'USD', 22: 'USD', 33: 'SGD' }), ABC, s => s)
  it('puts the currency on every account head and gives each currency its own Overall', () => {
    expect(r.cols.map(c => c.name)).toEqual(['A USD', 'B USD', 'C SGD', 'Overall USD', 'Overall SGD'])
    expect(r.t[0].cells.map(c => c.raw)).toEqual([20, -5, 7, 15, 7])
    expect(r.pooling).toMatchObject({ perCurrency: true, currencies: ['USD', 'SGD'] })
  })
  it('never adds money across currencies in any column', () => {
    const byId = Object.fromEntries(r.wideCols.map((c, i) => [c.id, r.tWide[0].cells[i].raw]))
    expect(byId['strat:USD:ema_pullback']).toBe(15)
    expect(byId['strat:SGD:ema_pullback']).toBe(7)
    expect(byId['market:USD:fx']).toBe(15)
    expect(byId['market:SGD:stock']).toBe(7)
    // 20 − 5 + 7 = 22 would be a sum across USD and SGD.
    for (const row of [...r.tWide, ...r.a]) for (const c of row.cells) expect(c.raw).not.toBe(22)
    expect(r.groups.map(x => x.name)).toEqual(['Account', 'Strategy · USD', 'Strategy · SGD', 'Asset class · USD', 'Asset class · SGD'])
    expect(r.groups.reduce((s, x) => s + x.span, 0)).toBe(r.wideCols.length)
  })
  it('shows an asset-class Overall only for a currency with two trading accounts', () => {
    expect(r.assetCols.map(c => c.name)).toEqual(['A USD', 'B USD', 'C SGD', 'Overall USD'])
    expect(r.overallDropped).toBe(true)
    expect(r.a.find(x => x.label === 'Forex').cells.map(c => c.raw)).toEqual([20, -5, 0, 15])
    expect(gradientFoot(r, 'a')).toContain('only within one deposit currency (USD, SGD), never across currencies')
  })
  it('gives every column a unique id and label: three "Other" columns are three columns', () => {
    const strats = ['other', 's1', 's2', 's3', 's4', 's5', 's6', 's7']
    const groups = strats.map((s, i) => g('11', 1, { strat: s, n: 10 - i, pricedN: 10 - i })).concat(g('11', 2, { market: 'other', strat: 's7' }))
    const w = performanceGradients(ccyReport(groups, { 11: 'USD' }), [{ id: '11', name: 'A' }], s => s).wideCols
    expect(new Set(w.map(c => c.id)).size).toBe(w.length)
    expect(new Set(w.map(c => c.full)).size).toBe(w.length)
    const names = w.map(c => c.name)
    for (const n of ['Other (label)', 'Other strategies', 'Other markets']) expect(names).toContain(n)
    expect(names.filter(n => n === 'Other')).toEqual([])
  })
  it('marks a partial figure with its priced count, in cells, subtotals and copied data', () => {
    const p = performanceGradients(ccyReport([g('11', -5.32, { market: 'stock', n: 4, pricedN: 2 })], { 11: 'SGD' }), [{ id: '11', name: 'A' }], s => s)
    const c = p.t[0].cells[0]
    expect(c.v).toBe('−5.32')
    expect(c.partial).toBe('2 of 4 priced')
    expect(c.text).toBe('−5.32 (partial: 2 of 4 priced)')
    expect(p.aSub[0].raw).toBe(-5.32)
    expect(p.aSub[0].partial).toBe('2 of 4 priced')
    expect(p.tWideSub[0].partial).toBe('incl. partial')
    const data = gradientData(p.tWide, p.wideCols, 'window', p.tWideSub, OVERLAP_LABEL)
    expect(data[0]['A SGD']).toBe('−5.32 (partial: 2 of 4 priced)')
    expect(data.at(-1).window).toBe('Subtotal (overlapping)')
    expect(data.at(-1)['A SGD']).toContain('includes 3 partial')
    const whole = performanceGradients(ccyReport([g('11', 3)], { 11: 'SGD' }), [{ id: '11', name: 'A' }], s => s)
    expect(whole.t[0].cells[0].partial).toBeNull()
    expect(whole.tWideSub[0].partial).toBeNull()
  })
  it('says why a figure is absent instead of claiming there were no closes', () => {
    const unpriced = performanceGradients(ccyReport([g('11', 0, { n: 2, pricedN: 0 })], { 11: 'USD' }), [{ id: '11', name: 'A' }], s => s)
    expect(unpriced.t[0].cells[0].raw).toBeNull()
    expect(unpriced.t[0].cells[0].why.key).toBe('no_pnl')
    expect(unpriced.t[0].cells[0].text).toBe('— (none of its 2 closes has a recorded P&L)')
    // Without recorded currencies the single Overall keeps the old rule, now with its reason.
    const old = performanceGradients(report([group('11', 20), group('22', -5)]), [{ id: '11', name: 'A' }, { id: '22', name: 'B' }], s => s)
    expect(old.pooling.perCurrency).toBe(false)
    expect(old.cols.map(c => c.name)).toEqual(['A (ccy?)', 'B (ccy?)', 'Overall'])
    expect(old.t[0].cells[2].why.key).toBe('not_pooled')
    expect(gradientFoot(old, 't')).toContain('no account deposit currency is recorded')
    expect(JSON.stringify(old)).not.toContain('no closed trades')
  })
  it('names accounts without a recorded currency and unstamped closes as outside every pool', () => {
    const q = performanceGradients(ccyReport([g('11', 4), g('22', 9), g(null, 50)], { 11: 'USD' }), [{ id: '11', name: 'A' }, { id: '22', name: 'B' }], s => s)
    expect(q.cols.map(c => c.name)).toEqual(['A USD', 'B (ccy?)', 'Overall USD'])
    expect(q.t[0].cells.map(c => c.raw)).toEqual([4, 9, 4])
    expect(q.pooling).toMatchObject({ noCurrency: ['B · currency not recorded'], unstampedN: 1 })
    expect(gradientFoot(q, 't')).toContain('1 close without an account stamp is in no account or currency column')
  })
})
