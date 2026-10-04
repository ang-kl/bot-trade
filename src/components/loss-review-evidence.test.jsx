import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import LossReview from './LossReview.jsx'

it('inconclusive excursion evidence leaves a positive-net WMT close in Wins', () => {
  const common = { classification: 'inconclusive', strategy: 'vp_value', timeframe: '1h',
    side: 'SELL', lesson: 'Wait for sufficient evidence.', detail: 'Excursion evidence is inconsistent.' }
  const html = renderToStaticMarkup(<LossReview postmortems={{ rows: [
    { ...common, id: 1, symbol: 'WMT.US', net_pnl: 3.20, r_multiple: 2.94, result: 'Partial' },
    { ...common, id: 2, symbol: 'BTCUSD', net_pnl: -2, r_multiple: -1, result: 'Miss' },
  ], stats: [] }} />)
  const lossStart = html.indexOf('Losses — what the market did')
  const winStart = html.indexOf('Wins — what the exit engine did')
  expect(lossStart).toBeGreaterThan(0)
  expect(winStart).toBeGreaterThan(lossStart)
  const losses = html.slice(lossStart, winStart)
  const wins = html.slice(winStart)
  expect(wins).toContain('Wins — what the exit engine did (1)')
  expect(wins).toContain('WMT.US')
  expect(wins).toContain('INCONCLUSIVE')
  expect(wins).not.toContain('BTCUSD')
  expect(losses).toContain('Losses — what the market did (1)')
  expect(losses).toContain('BTCUSD')
  expect(losses).not.toContain('WMT.US')
})
