// Codex · №11,667 (codex-footprint: signals-ui-2026-10-07).
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TradeSignalsCard } from './Trade.jsx'

const row = (symbol, extra = {}) => ({
  symbol, account_id: '101', accountLabel: 'Demo 101', strategy: 'ema_pullback',
  timeframe: '4h', bias: 'long', confidence: 9, price: 1.12,
  thesis: `Fixture ${symbol}`, eligibility: 'candidate', entry: null, ...extra,
})
const report = rows => ({ accountId: '101', rows, lastScanAt: '2026-10-07T00:00:00Z' })
const render = (data, accountId = '101') => renderToStaticMarkup(<TradeSignalsCard report={data} accountId={accountId} />)

describe('Trade signal eligibility presentation', () => {
  it('counts candidates, blocked observations and linked entries separately', () => {
    const html = render(report([
      row('EURUSD'), row('BTCUSD', { eligibility: 'scan_only', reason: 'strategy OFF' }),
      row('XAUUSD', { entry: { tradeId: 44, status: 'open', positionId: 'pos44' } }),
    ]))
    expect(html).toContain('Signals — 1 candidate · 1 blocked scan · 1 recorded entry')
    expect(html.match(/<h3[^>]*>(.*?)<\/h3>/s)?.[1]).not.toContain(' active')
    expect(html).toContain('EURUSD')
    expect(html).toContain('Trade 44 · open · position pos44')
    expect(html).not.toContain('BTCUSD')
    expect(html).toContain('Show blocked scans (1)')
    expect(html).toContain('aria-pressed="false"')
  })

  it('retains an actual linked entry when that strategy is now disarmed', () => {
    const html = render(report([row('XAUUSD', {
      eligibility: 'scan_only', reason: 'strategy OFF',
      entry: { tradeId: 44, status: 'closed', positionId: 'pos44' },
    })]))
    expect(html).toContain('0 candidates · 0 blocked scans · 1 recorded entry')
    expect(html).toContain('Trade 44 · closed · position pos44')
    expect(html).not.toContain('Show blocked scans')
  })

  it('does not treat missing or unknown eligibility as an entry candidate', () => {
    const html = render(report([row('USDCHF', { eligibility: undefined }), row('GBPUSD', { eligibility: 'unknown' })]))
    expect(html).toContain('0 candidates · 2 blocked scans · 0 recorded entries')
    expect(html).toContain('No eligible candidates or recorded entries.')
    expect(html).not.toContain('USDCHF')
    expect(html).not.toContain('GBPUSD')
  })

  it('keeps neutral and skip observations outside actionable counts and rows', () => {
    const html = render(report([row('USDJPY', { bias: 'neutral' }), row('USDCAD', { bias: 'skip' }), row('EURUSD')]))
    expect(html).toContain('1 candidate · 0 blocked scans · 0 recorded entries · 2 scanned flat')
    expect(html).not.toContain('USDJPY')
    expect(html).not.toContain('USDCAD')
    expect(html).toContain('EURUSD')
  })

  it('withholds stale rows and counts when the viewed account differs', () => {
    const html = render(report([row('EURUSD')]), '202')
    expect(html).toContain('Signals — awaiting account data')
    expect(html).not.toContain('Account 101')
    expect(html).toContain('Account 202')
    expect(html).not.toContain('EURUSD')
    expect(html).not.toContain('1 candidate')
  })

  it('shows read failure as unavailable rather than a verified zero count', () => {
    const html = render({ ...report([row('EURUSD')]), error: 'read failed' })
    expect(html).toContain('Signals — unavailable')
    expect(html).toContain('read failed')
    expect(html).not.toContain('EURUSD')
    expect(html).not.toContain('0 candidates')
  })

  it('keeps each account-labelled row distinct in the all-account view', () => {
    const data = { ...report([row('EURUSD'), row('EURUSD', { account_id: '202', accountLabel: 'Demo 202' })]), accountId: 'all' }
    const html = render(data, 'all')
    expect(html).toContain('Signals — 2 candidates')
    expect(html).toContain('Demo 101')
    expect(html).toContain('Demo 202')
    expect((html.match(/Candidate · no linked entry/g) || []).length).toBe(2)
  })
})
