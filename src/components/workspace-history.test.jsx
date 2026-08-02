// Workspace history. The row-origin distinction is the careful part: a scoped
// read INCLUDES unstamped rows, and an unstamped row is not this account's
// action — it either predates stamping or is genuinely global. Rendering both
// the same way would let a master switch read as something done to this
// account, so that is tested directly.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkspaceHistory, { LogTable, BacktestTable, OriginTag } from './WorkspaceHistory.jsx'
import { actionLabel, rowOrigin, ago, backtestResult, toText } from '../lib/workspace-history-view.js'

const logRow = (over = {}) => ({
  id: 1, at: '2026-08-03 11:00:00', method: 'AUDIT', path: '/phase/scan_enabled',
  body: '{"key":"scan_enabled","from":"true","to":"false"}', account_id: '5203012', ...over,
})
const btRow = (over = {}) => ({
  id: 1, ran_at: '2026-08-03 09:00:00', strategy: 'ema', symbol: 'EURUSD', timeframe: 'H1',
  trades: 12, win_rate_pct: 58.3, profit_factor: 1.9, total_profit_pct: 4.1, error: null,
  account_id: '5203012', ...over,
})

describe('rowOrigin', () => {
  it('marks an unstamped row as shared, not as this account own', () => {
    const o = rowOrigin(logRow({ account_id: null }), '5203012')
    expect(o.kind).toBe('shared')
    expect(o.label).toMatch(/all accounts/)
  })
  it('marks this account own row as own', () => {
    expect(rowOrigin(logRow(), '5203012').kind).toBe('own')
  })
  it('marks another account row distinctly, rather than as own', () => {
    expect(rowOrigin(logRow({ account_id: '9999' }), '5203012').kind).toBe('other')
  })
  it('does not claim ownership when no account is being viewed', () => {
    expect(rowOrigin(logRow(), null).kind).toBe('own')
    expect(rowOrigin(logRow({ account_id: null }), null).kind).toBe('shared')
  })
})

describe('OriginTag', () => {
  it('renders a different label for shared and own rows', () => {
    const shared = renderToStaticMarkup(<OriginTag row={logRow({ account_id: null })} accountId="5203012" />)
    const own = renderToStaticMarkup(<OriginTag row={logRow()} accountId="5203012" />)
    expect(shared).not.toBe(own)
    expect(shared).toContain('all accounts')
  })
})

describe('actionLabel', () => {
  it('reads a phase flip and a controller event as words', () => {
    expect(actionLabel('/phase/scan_enabled')).toBe('Switch: scan_enabled')
    expect(actionLabel('/controller/atr_refresh/stalled')).toBe('Controller: atr_refresh stalled')
  })
  it('falls back to a tidied path rather than a blank', () => {
    expect(actionLabel('/pause-disposition')).toBe('pause disposition')
    expect(actionLabel(null)).toBe('—')
  })
})

describe('backtestResult', () => {
  it('reports a real result', () => {
    expect(backtestResult(btRow()).text).toMatch(/12 trades/)
  })
  it('does NOT render a failed run as a zero result', () => {
    const r = backtestResult(btRow({ error: 'no bars from broker', trades: null }))
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/failed/)
    expect(r.text).not.toMatch(/0 trades/)
  })
  it('distinguishes a genuinely flat run from a failure', () => {
    const r = backtestResult(btRow({ trades: 0 }))
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/no trades in the window/)
  })
  it('renders a null profit factor without printing null', () => {
    expect(backtestResult(btRow({ profit_factor: null })).text).not.toMatch(/null/)
  })
})

describe('tables', () => {
  it('say so when empty instead of rendering a bare header', () => {
    expect(renderToStaticMarkup(<LogTable rows={[]} accountId="A" />)).toMatch(/No actions recorded/)
    expect(renderToStaticMarkup(<BacktestTable rows={[]} accountId="A" />)).toMatch(/No backtest runs/)
  })
  it('render rows with their origin', () => {
    const html = renderToStaticMarkup(<LogTable rows={[logRow(), logRow({ id: 2, account_id: null })]} accountId="5203012" />)
    expect(html).toContain('Switch: scan_enabled')
    expect(html).toContain('all accounts')
  })
  it('colour a failed backtest differently from a real one', () => {
    const bad = renderToStaticMarkup(<BacktestTable rows={[btRow({ error: 'boom', trades: null })]} accountId="A" />)
    expect(bad).toContain('--color-down')
  })
})

describe('ago', () => {
  const now = Date.parse('2026-08-03T12:00:00Z')
  it('reads SQLite space-form stamps as UTC', () => {
    expect(ago('2026-08-03 11:00:00', now)).toBe('1h ago')
  })
  it('degrades to a dash rather than NaN', () => {
    expect(ago('nonsense', now)).toBe('—')
  })
})

describe('toText', () => {
  it('labels an unstamped action as all accounts rather than leaving it blank', () => {
    const t = toText({ scope: 'account 5203012', log: [logRow({ account_id: null })], backtests: [btRow()] })
    expect(t).toMatch(/all accounts/)
    expect(t).toMatch(/EURUSD/)
  })
})

describe('WorkspaceHistory', () => {
  it('renders without throwing before any data has arrived', () => {
    expect(renderToStaticMarkup(<WorkspaceHistory />)).toContain('Loading')
  })
})
