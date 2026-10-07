// Codex · №11,740 · 2026-10-07; codex-footprint: performance-live-cards-2026-10-07.
import { describe, it, expect } from 'vitest'
import { LIVE_MARKETS, liveMarketSymbols, marketPage, liveMarketView, reportFreshness } from './performance-live-markets.js'
import { mergeDisplayQuote } from './display-quote.js'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'

describe('live market account and freshness boundaries', () => {
  it('uses the shared classes and only the requested account watchlist/positions', () => {
    const config = { watchlist_account: '11', watchlist: ['AAPL.US', 'NAS100', 'XAUUSD', 'NATGAS', 'COCOA', 'ODD', 'AAPL.US'] }
    expect(LIVE_MARKETS.map(p => liveMarketSymbols(p, config, '11', [{ account_id: '11', symbol: 'MSFT.US' }, { account_id: '22', symbol: 'TSLA.US' }]))).toEqual([
      ['AAPL.US', 'MSFT.US'], ['NAS100'], ['COCOA', 'NATGAS', 'XAUUSD'], ['ODD'],
    ])
    expect(liveMarketSymbols(LIVE_MARKETS[0], config, '22')).toEqual([])
    expect(liveMarketSymbols(LIVE_MARKETS[0], config, null)).toEqual([])
  })
  it('pages every symbol through the ten-symbol stream cap without dropping the rest', () => {
    const symbols = Array.from({ length: 23 }, (_, n) => `S${n}.US`)
    expect([0, 1, 2].flatMap(p => marketPage(symbols, p).symbols)).toEqual(symbols)
    expect(marketPage(symbols, 100)).toMatchObject({ page: 2, pages: 3, total: 23 })
    expect(marketPage([], 4)).toMatchObject({ page: 0, pages: 1, symbols: [] })
  })
  it('shows updated quotes, rejects another account and expires stale bid/ask', () => {
    const quote = mergeDisplayQuote(null, { accountId: '11', host: 'demo', symbol: 'AAPL.US', bid: 99, ask: 101 }, 100000)
    const page = { ...marketPage(['AAPL.US']), ticks: { 'AAPL.US': quote } }
    const view = (account, now) => liveMarketView(LIVE_MARKETS[0], page, { acct: 'all', quoteAccount: account, now, report: null })
    expect(view('11', 100000).rows[0].price).toBe(100)
    page.ticks['AAPL.US'] = mergeDisplayQuote(quote, { accountId: '11', host: 'demo', symbol: 'AAPL.US', bid: 109, ask: 111 }, 105000)
    expect(view('11', 105000).rows[0]).toMatchObject({ price: 110, delta: 10.000000000000009 })
    expect(view('22', 105000).rows[0].price).toBeNull()
    expect(view('11', 121000).rows[0].price).toBeNull()
    expect(view('11', 121000).feedNote).toContain('quotes: this account only')
  })
  it('does not pool USD/SGD money or invent a zero when the report is unavailable', () => {
    const groups = ['11', '22'].map(accountId => ({ accountId, market: 'stock', sym: 'AAPL.US', strat: 'x', stats: { ...emptyPopulation(), n: 1, pricedN: 1, net: 5, gw: 5, gl: 0 } }))
    const report = { status: 'complete', currencyByAccount: { 11: { currency: 'USD' }, 22: { currency: 'SGD' } }, windows: ['24h', '1w', '30d'].map(key => ({ key, groups })) }
    const page = { ...marketPage(['AAPL.US']), ticks: {} }
    const opts = { acct: 'all', quoteAccount: '11', now: 100000, report }
    const view = liveMarketView(LIVE_MARKETS[0], page, opts)
    expect(view.rows[0].pnl).toContain('not pooled')
    expect(view.rows[0].pnl).not.toContain('10.00')
    expect(liveMarketView(LIVE_MARKETS[0], page, { ...opts, report: null }).rows[0].pnl).toBe('—')
    expect(view.rows[0].meta).toContain('PF —')
  })
  it('labels a one-hour-old or failed report and returns to current after refresh', () => {
    const report = { status: 'complete', asOfMs: 100000 }
    expect(reportFreshness(report, 3700000)).toMatchObject({ state: 'stale', text: 'Report 60m old · STALE' })
    expect(reportFreshness(report, 110000, 'timeout').state).toBe('refresh-failed')
    expect(reportFreshness({ ...report, asOfMs: 3700000 }, 3705000).state).toBe('current')
    expect(reportFreshness(null, 3700000).state).toBe('unavailable')
    expect(reportFreshness({ ...report, asOfMs: 5000000 }, 3700000).state).toBe('unavailable')
  })
})
