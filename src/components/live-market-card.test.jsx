// Codex · №11,740 · 2026-10-07; codex-footprint: performance-live-cards-2026-10-07.
import { it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import LiveMarketCard from './LiveMarketCard.jsx'

it('shows account source, bounded paging and one leading collapse control', () => {
  const market = { key: 'stock', title: 'Stocks', feedNote: 'Quotes: account 11', rows: [{ sym: 'AAPL.US', price: 100, delta: 1, pnl: '—', meta: 'PF —' }], k: [], total: 23, page: 0, pages: 3 }
  const html = renderToStaticMarkup(<LiveMarketCard market={market} />)
  expect(html).toContain('Quotes: account 11')
  expect(html).toContain('Page 1 of 3 · 23 symbols')
  expect(html).toContain('Next symbols')
  expect(html).toContain('overflow-x:auto')
  expect((html.match(/aria-label="Collapse this section"/g) || []).length).toBe(1)
  expect(html.indexOf('Collapse this section')).toBeLessThan(html.indexOf('Stocks — live quotes'))
})
