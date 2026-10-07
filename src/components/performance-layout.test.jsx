// Codex · №11,739 · 2026-10-07; codex-footprint: performance-live-cards-2026-10-07.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StratMxBody, GradientBody, CryptoBody } from '../pages/Performance.jsx'
import { MARKET_COLS } from '../../agent/shared/formulas.js'

describe('Performance table geometry', () => {
  it('keeps crypto outcome text readable within a scrolling table on a phone', () => {
    const html = renderToStaticMarkup(<CryptoBody crypto={{ feedNote: 'Owned quotes', rows: [{ sym: 'BTCUSD', price: 100, delta: 0, pnl: '—', meta: '0 closes · 0 priced · —% win · PF —' }] }} />)
    expect(html).toContain('overflow-x:auto')
    expect(html).toContain('min-width:680px')
    expect(html).toContain('0 closes')
  })
  it('keeps every market, Net and Edge on the same strategy row', () => {
    const html = renderToStaticMarkup(<StratMxBody stratMx={[{ name: 'x', label: 'X', cells: MARKET_COLS.map(() => ({ v: '1' })), net: '8', edge: '10%' }]} />)
    const templates = [...html.matchAll(/grid-template-columns:([^;"]+)/g)].map(m => m[1])
    expect(templates.length).toBeGreaterThanOrEqual(2)
    for (const template of templates) expect(template).toContain(`repeat(${MARKET_COLS.length},`)
  })
  it('wraps a partial-money coverage note within its own gradient cell', () => {
    const html = renderToStaticMarkup(<GradientBody grid="86px" label="Window" cols={[{ name: 'A' }]} rows={[{ label: '3M', cells: [{ v: '+1.00', raw: 1, partial: '563 of 576 priced' }] }]} foot="f" />)
    expect(html).toContain('563 of 576 priced')
    expect(html).not.toContain('white-space:nowrap')
    expect(html).toContain('overflow-wrap:anywhere')
  })
})
