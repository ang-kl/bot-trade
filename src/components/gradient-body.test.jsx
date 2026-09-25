import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GradientBody, LedgerRow, MobileWindowCard } from '../pages/Performance.jsx'
import { performanceGradients, OVERLAP_LABEL, OVERLAP_TITLE } from '../lib/performance-gradients.js'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'

// WEB-7 (8,989-A rows 8-9): what the gradient table actually renders.
const g = (accountId, net, { market = 'fx', n = 1, pricedN = 1 } = {}) => ({ accountId, sym: 'X', market, strat: 'ema_pullback',
  stats: { ...emptyPopulation(), n, pricedN, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
const rep = (groups, currencyByAccount) => ({ status: 'complete', currencyByAccount,
  windows: ['1h', '12m', '30d'].map(key => ({ key, label: key, ledger: true, groups })) })
const accounts = [{ id: '11', name: 'A' }, { id: '22', name: 'B' }]

describe('gradient table rendering', () => {
  it('prints the priced count under a partial figure and labels the overlapping subtotal', () => {
    const r = performanceGradients(rep([g('11', -5.32, { market: 'stock', n: 4, pricedN: 2 }), g('22', 3)],
      { 11: { currency: 'SGD' }, 22: { currency: 'USD' } }), accounts, s => s)
    const html = renderToStaticMarkup(<GradientBody grid="86px" label="Window" cols={r.wideCols} groups={r.groups} rows={r.tWide}
      subtotals={r.tWideSub} subtotalLabel={OVERLAP_LABEL} subtotalTitle={OVERLAP_TITLE} foot="f" />)
    expect(html).toContain('2 of 4 priced')
    expect(html).toContain('Subtotal (overlapping)')
    expect(html).toContain('incl. partial')
    expect(html).toContain('A SGD')
    expect(html).toContain('B USD')
    expect(html).toContain('Asset class · SGD')
    // No money is summed across SGD and USD: −5.32 + 3 = −2.32 appears nowhere.
    expect(html).not.toContain('2.32')
  })
  it('an empty column states its real reason, never "no closed trades"', () => {
    const r = performanceGradients(rep([g('11', 0, { n: 2, pricedN: 0 }), g('22', 3)],
      { 11: { currency: 'USD' }, 22: { currency: 'USD' } }), accounts, s => s)
    const html = renderToStaticMarkup(<GradientBody grid="86px" label="Window" cols={r.cols} rows={r.t} foot="f" />)
    expect(html).toContain('No P&amp;L recorded')
    expect(html).toContain('none of its 2 closes has a recorded P&amp;L')
    expect(html).not.toContain('no closed trades')
    expect(html).not.toContain('>Unavailable<')
  })
  it('ledger rows say when a net is partial or not pooled, on desktop and phone', () => {
    const base = { key: 'lastmonth', label: 'Last month', from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z',
      winPct: 40, pf: 0.8, tp: 1, part: 0, sl: 1, manual: 0, edge: null, markets: {} }
    const partial = { ...base, net: -18392.97, trades: 461, pricedTrades: 449, moneyState: 'partial_recorded_account_units' }
    const row = w => renderToStaticMarkup(<table><tbody><LedgerRow w={w} nowMs={0} timeZone="UTC" /></tbody></table>)
    const card = w => renderToStaticMarkup(<MobileWindowCard w={w} timeZone="UTC" />)
    for (const html of [row(partial), card(partial)]) expect(html).toContain('partial · 449 of 461 priced')
    const pooled = { ...base, net: null, trades: 1315, pricedTrades: 1293, moneyState: 'unverified_cross_account_units' }
    for (const html of [row(pooled), card(pooled)]) expect(html).toContain('not pooled')
    // A null net was painted as a gain on the phone card (null >= 0).
    expect(card(pooled)).not.toContain('var(--color-up)')
    const whole = { ...base, net: 12, trades: 3, pricedTrades: 3, moneyState: 'recorded_account_units' }
    for (const html of [row(whole), card(whole)]) expect(html).not.toContain('priced')
  })
  it('renders three "Other" columns as three distinct heads', () => {
    const groups = ['other', 's1', 's2', 's3', 's4', 's5', 's6', 's7'].map((strat, i) => ({ ...g('11', 1, { n: 10 - i, pricedN: 10 - i }), strat }))
      .concat({ ...g('11', 2, { market: 'other' }), strat: 's7' })
    const r = performanceGradients(rep(groups, { 11: { currency: 'USD' } }), [{ id: '11', name: 'A' }], s => s)
    const html = renderToStaticMarkup(<GradientBody grid="86px" label="Window" cols={r.wideCols} groups={r.groups} rows={r.tWide} foot="f" />)
    for (const head of ['Other (label)', 'Other Strategies', 'Other Markets']) expect(html).toContain(`>${head}<`)
    expect(html).not.toContain('>Other<')
  })
})
