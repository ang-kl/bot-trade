// The decision feed, tested where the wording carries the meaning.
//
// The panel exists to separate two things a raw log cannot: a handful of
// setups retrying every cycle, and a filter rejecting the whole universe.
// Both produce the same row count. The reading that distinguishes them is
// prose, so it is tested as prose.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DecisionFeed, { StageBlock, RowsTable } from './DecisionFeed.jsx'
import { repeatReading, ago, toText, DECISION_TONE } from '../lib/decision-feed-view.js'

const stage = (over = {}) => ({
  stage: 'style_filter',
  count: 30,
  distinctSymbols: 3,
  lastAt: '2026-08-02 11:00:00',
  decisions: { skip: 30 },
  reasons: [
    { reason: 'wrong style', decision: 'skip', count: 20, distinctSymbols: 3, lastAt: '2026-08-02 11:00:00' },
    { reason: null, decision: 'skip', count: 10, distinctSymbols: 2, lastAt: '2026-08-02 10:00:00' },
  ],
  moreReasons: 0,
  repeatRatio: 10,
  ...over,
})

const feed = (over = {}) => ({
  windowHours: 24,
  since: '2026-08-01T12:00:00Z',
  accountId: '5203012',
  activeAccountId: '5203012',
  total: 30,
  totals: { proceed: 0, skip: 30, veto: 0, other: 0 },
  unstamped: 4,
  stages: [stage()],
  rows: [
    { id: 2, account_id: '5203012', symbol: 'EURUSD', timeframe: 'H1', strategy: 'ema', stage: 'style_filter', decision: 'skip', reason: 'wrong style', created_at: '2026-08-02 11:00:00' },
    { id: 1, account_id: null, symbol: null, timeframe: null, strategy: null, stage: 'dispatch', decision: 'veto', reason: null, created_at: '2026-08-02 10:00:00' },
  ],
  truncated: false,
  ...over,
})

describe('DecisionFeed', () => {
  it('renders without throwing before any data has arrived', () => {
    const html = renderToStaticMarkup(<DecisionFeed />)
    expect(html).toContain('Decision Feed card')
    expect(html).toContain('Loading')
  })

  it('the compact variant renders its own heading, not the desktop one', () => {
    const html = renderToStaticMarkup(<DecisionFeed variant="compact" />)
    expect(html).toContain('Why it did or did not trade')
    expect(html).not.toContain('Decision Feed card')
    expect(html).toContain('Loading')
  })

  it('an unknown variant falls back to the full card rather than rendering nothing', () => {
    expect(renderToStaticMarkup(<DecisionFeed variant="nonsense" />)).toContain('Decision Feed card')
  })
})

describe('repeatReading', () => {
  it('calls a high repeat ratio a few waiting setups, not a wide rejection', () => {
    const r = repeatReading(stage({ count: 800, distinctSymbols: 3, repeatRatio: 266.7 }))
    expect(r).toMatch(/3 instruments/)
    expect(r).toMatch(/waiting/)
  })

  it('calls a low repeat ratio a universe-wide rejection', () => {
    const r = repeatReading(stage({ count: 800, distinctSymbols: 780, repeatRatio: 1 }))
    expect(r).toMatch(/universe/)
  })

  it('gives the same row count opposite readings — the whole point of the panel', () => {
    const stuck = repeatReading(stage({ count: 800, distinctSymbols: 3, repeatRatio: 266.7 }))
    const wide = repeatReading(stage({ count: 800, distinctSymbols: 780, repeatRatio: 1 }))
    expect(stuck).not.toBe(wide)
  })

  it('names the single-instrument case explicitly', () => {
    expect(repeatReading(stage({ distinctSymbols: 1, repeatRatio: 40 }))).toMatch(/one instrument/)
  })

  it('offers no reading when there is nothing to divide by', () => {
    expect(repeatReading(stage({ distinctSymbols: 0, repeatRatio: null }))).toBe(null)
    expect(repeatReading(null)).toBe(null)
  })
})

describe('StageBlock', () => {
  it('fill mode drops the row flex-basis, which would be a HEIGHT in a column', () => {
    // `flex: 1 1 300px` resolves against the main axis. In the desktop's row
    // container that reads "at least 300px wide"; in the phone's column
    // container the same value means 300px TALL, and the card renders as a
    // stack of tall empty boxes.
    const row = renderToStaticMarkup(<StageBlock s={stage()} />)
    const col = renderToStaticMarkup(<StageBlock s={stage()} fill />)
    expect(row).toContain('300px')
    expect(col).not.toContain('300px')
    expect(col).toContain('width:100%')
  })

  it('shows the stage, its volume, and a badge per decision kind', () => {
    const html = renderToStaticMarkup(<StageBlock s={stage()} />)
    expect(html).toContain('style_filter')
    expect(html).toContain('30')
    expect(html).toContain('skip')
  })

  it('names an unrecorded reason instead of rendering a blank line', () => {
    const html = renderToStaticMarkup(<StageBlock s={stage()} />)
    expect(html).toContain('no reason recorded')
  })

  it('reports capped reasons rather than dropping them silently', () => {
    const html = renderToStaticMarkup(<StageBlock s={stage({ moreReasons: 4 })} />)
    expect(html).toContain('4 more reasons')
  })
})

describe('RowsTable', () => {
  it('renders a dash for missing symbol, strategy and reason', () => {
    const html = renderToStaticMarkup(<RowsTable rows={feed().rows} />)
    expect(html).toContain('EURUSD')
    expect(html).toContain('—')
  })
})

describe('ago', () => {
  const now = Date.parse('2026-08-02T12:00:00Z')
  it('reads SQLite space-form stamps as UTC', () => {
    expect(ago('2026-08-02 11:00:00', now)).toBe('1h ago')
  })
  it('agrees with the ISO form of the same instant', () => {
    expect(ago('2026-08-02 09:00:00', now)).toBe(ago('2026-08-02T09:00:00Z', now))
  })
  it('degrades to a dash rather than NaN', () => {
    expect(ago('nonsense', now)).toBe('—')
    expect(ago(null, now)).toBe('—')
  })
})

describe('toText', () => {
  it('leads with the summary and states the unstamped count', () => {
    const t = toText(feed())
    expect(t).toMatch(/Decision feed — last 24h/)
    expect(t).toMatch(/4 not stamped to an account/)
    expect(t).toMatch(/style_filter — 30 \(3 symbols\)/)
  })

  it('says all accounts when the read is unscoped', () => {
    expect(toText(feed({ accountId: null, unstamped: 0 }))).toMatch(/all accounts/)
  })

  it('marks a capped row list', () => {
    expect(toText(feed({ truncated: true }))).toMatch(/capped/)
  })

  it('writes a null reason as such rather than as an empty cell', () => {
    expect(toText(feed())).toMatch(/\(no reason recorded\)/)
  })
})

describe('DECISION_TONE', () => {
  it('does not colour a veto and a proceed the same', () => {
    expect(DECISION_TONE.veto).not.toBe(DECISION_TONE.proceed)
  })
})
