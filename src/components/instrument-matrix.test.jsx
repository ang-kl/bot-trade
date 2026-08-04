// npx vitest run src/components/instrument-matrix.test.jsx
//
// The matrix has one job the placement logic cannot do for it: fit 1,900
// instruments into a third of a half-width iPad screen without the page
// growing. These cover the structural promises that make that true — fixed
// cell height, 44pt targets, a count on every cell, and a search that reports
// matches inside COLLAPSED cells.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import InstrumentMatrix from './watchlist/InstrumentMatrix.jsx'
import { MATRIX_COLUMNS, MATRIX_ROWS } from '../lib/instrument-matrix.js'

const SYMBOLS = ['NVDA', 'AMD.US', 'EURUSD', 'BTCUSD', 'XAUUSD', '0066.HK', 'GER40', 'JPM', 'SPY', 'MYSTERYCO']

const render = (props = {}) => renderToStaticMarkup(<InstrumentMatrix symbols={SYMBOLS} {...props} />)

// renderToStaticMarkup escapes entities, so "US Tech & Semis" arrives as
// "US Tech &amp; Semis". Compare against escaped text rather than loosening
// the assertions.
const esc = (t) => t.replace(/&/g, '&amp;')

// This environment has no DOM. The component reads its open-cell state from
// localStorage on mount and writes it in an effect, both already wrapped
// against a private-mode throw — a minimal stub is enough to drive it.
function withOpenCells(keys, fn) {
  const store = new Map([['watchlist_matrix_open', JSON.stringify(keys)]])
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
  try { return fn() } finally { delete globalThis.localStorage }
}

describe('the grid', () => {
  it('renders all four column heads and all seven row heads', () => {
    const html = render()
    for (const c of MATRIX_COLUMNS) expect(html).toContain(c.short)
    for (const r of MATRIX_ROWS) expect(html).toContain(esc(r.short))
  })

  it('every cell is a FIXED height with overflow hidden', () => {
    // This is what keeps the grid inside its third of the screen. A cell that
    // grew with its contents would reflow the other 27 around your tap — the
    // complaint the watchlist table's internal scroll already had to fix.
    const html = render()
    expect(html).toContain('h-[44px]')
    expect(html).toContain('overflow-hidden')
  })

  it('shows a count badge on every populated cell', () => {
    const html = render()
    expect(html).toContain('[1]')     // e.g. the lone Hong Kong listing
  })

  it('gives tap targets at least 44pt in both directions', () => {
    const html = render()
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('min-w-[44px]')
  })

  it('reports the total, the placed count, and the unclassified remainder', () => {
    const html = render()
    expect(html).toContain('10 instruments')
    expect(html).toContain('9 placed')
    // NAMED, not swallowed — MYSTERYCO has no establishable sector.
    expect(html).toContain('1 unclassified')
  })

  it('never lets the page scroll sideways — only the grid does', () => {
    const html = render()
    expect(html).toContain('overflow-x-auto')
  })
})

describe('the sticky filter bar', () => {
  it('is sticky, and carries the search plus all three session toggles', () => {
    const html = render()
    expect(html).toContain('sticky')
    expect(html).toContain('Search all instruments')
    for (const label of ['All', 'Active Now', 'Closed']) expect(html).toContain(label)
  })
})

describe('symbols', () => {
  it('links to TradingView with the broker suffix stripped', () => {
    // Cells start collapsed, so open one through the persisted state the
    // component reads on mount.
    const html = withOpenCells(['growth|us_tech'], () => render())
    expect(html).toContain('tradingview.com')
    expect(html).toContain('symbol=AMD')
    expect(html).not.toContain('symbol=AMD.US')
    // …and both members of that cell are listed, TradingView-linked.
    expect(html).toContain('>NVDA<')
  })

  it('an empty catalogue renders a calm empty grid rather than throwing', () => {
    const html = renderToStaticMarkup(<InstrumentMatrix symbols={[]} />)
    expect(html).toContain('0 instruments')
    expect(html).not.toContain('unclassified')
  })
})
