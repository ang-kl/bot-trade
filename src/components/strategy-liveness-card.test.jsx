// The liveness card, tested where it can actually be wrong.
//
// No jsdom in this repo, so the component is rendered with react-dom/server
// (hooks run fine in node; effects do not, so SSR gives the pre-fetch state)
// and the pure pieces are called directly. The first test is not ceremony: an
// earlier draft referenced a `const` inside its own initialiser, which eslint
// passed and which threw on the FIRST render — exactly what rendering here
// catches.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import StrategyLivenessCard, { Table, Row } from './StrategyLivenessCard.jsx'
import { ago, toText } from '../lib/strategy-liveness-view.js'

const fixture = (over = {}) => ({
  windowDays: 7,
  since: '2026-07-26T00:00:00Z',
  totalScans: 4200,
  verdictable: true,
  strategies: [
    { key: 'cup_handle', name: 'Cup & Handle', armed: true, signals: 0, decisions: 0, vetoes: 0, opened: 0, closed: 0, lastSignalAt: null, lastTradeAt: null, verdict: 'silent', note: 'armed but produced NO signal in this window' },
    { key: 'ema', name: 'EMA Cross', armed: true, signals: 120, decisions: 118, vetoes: 118, opened: 0, closed: 0, lastSignalAt: '2026-08-02T10:00:00Z', lastTradeAt: null, verdict: 'signalling_not_trading', note: 'producing signals but none reached an order' },
    { key: 'rsi2', name: 'RSI-2', armed: true, signals: 40, decisions: 40, vetoes: 12, opened: 8, closed: 6, lastSignalAt: '2026-08-02T11:00:00Z', lastTradeAt: '2026-08-02T11:05:00Z', verdict: 'trading', note: 'producing signals and opening positions' },
    { key: 'brk', name: 'Breakout', armed: false, signals: 0, decisions: 0, vetoes: 0, opened: 0, closed: 0, lastSignalAt: null, lastTradeAt: null, verdict: 'idle_unarmed', note: 'not armed — absence here is expected' },
  ],
  ...over,
})

describe('StrategyLivenessCard', () => {
  it('renders without throwing before any data has arrived', () => {
    const html = renderToStaticMarkup(<StrategyLivenessCard />)
    expect(html).toContain('Strategy Liveness table')
    expect(html).toContain('Loading')
  })
})

describe('Table', () => {
  it('shows every strategy, armed or not', () => {
    const html = renderToStaticMarkup(<Table data={fixture()} />)
    for (const n of ['Cup &amp; Handle', 'EMA Cross', 'RSI-2', 'Breakout']) expect(html).toContain(n)
  })

  it('renders the funnel counts, not a score', () => {
    const html = renderToStaticMarkup(<Table data={fixture()} />)
    expect(html).toContain('118') // decisions
    expect(html).toContain('stopped')
  })
})

describe('Row', () => {
  const rowHtml = (s, verdictable = true) =>
    renderToStaticMarkup(<table><tbody><Row s={s} verdictable={verdictable} /></tbody></table>)
  // The ROW tint, not any class in the row. The verdict Badge carries the same
  // error token, so a naive substring match passes for the wrong reason — the
  // first draft of these tests did exactly that.
  const rowTint = (s, verdictable = true) => /<tr class="([^"]*)"/.exec(rowHtml(s, verdictable))?.[1] ?? ''

  it('flags an ARMED strategy that produced nothing', () => {
    expect(rowTint(fixture().strategies[0])).toContain('--color-error-bg')
  })

  it('does not flag an UNARMED strategy — absence there is expected', () => {
    expect(rowTint(fixture().strategies[3])).toBe('')
  })

  it('does not flag anything while the window is not judgeable', () => {
    expect(rowTint(fixture().strategies[0], false)).toBe('')
  })

  it('does not flag a strategy that signals but never orders — that is a gate, not a dead code path', () => {
    expect(rowTint(fixture().strategies[1])).toBe('')
  })

  it('says "never" rather than a blank when a strategy has never signalled', () => {
    expect(rowHtml(fixture().strategies[0])).toContain('never')
  })
})

describe('ago', () => {
  it('reports never for a missing timestamp', () => {
    expect(ago(null)).toBe('never')
  })
  it('reads a SQL space-form timestamp as UTC, not local', () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const sql = iso.replace('T', ' ').replace('Z', '')
    expect(ago(sql)).toBe(ago(iso))
  })
  it('degrades to a dash on an unparseable stamp instead of NaN', () => {
    expect(ago('not a date')).toBe('—')
  })
})

describe('toText', () => {
  it('carries the funnel and the verdict for every strategy', () => {
    const text = toText(fixture())
    expect(text).toContain('Cup & Handle')
    expect(text).toContain('0 signals → 0 decisions')
    expect(text).toContain('Silent')
    expect(text.split('\n')).toHaveLength(5) // header + 4 strategies
  })
  it('marks a window that cannot be judged', () => {
    expect(toText(fixture({ verdictable: false }))).toContain('too few to judge')
  })
})
