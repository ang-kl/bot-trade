import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountHistoryReading } from './AccountHistory.jsx'
test('history shows zero observations separately from unavailable data and names cashflow limitations', () => {
  expect(renderToStaticMarkup(<AccountHistoryReading report={null} />)).toContain('unavailable')
  const html = renderToStaticMarkup(<AccountHistoryReading report={{ points: [], retentionDays: 90,
    equityChange: null, externalFlowAdjustedChange: null, currency: null, cashflows: { complete: false, reason: 'cashflow_coverage_gap' },
    sampledDrawdown: null, drawdownBasis: 'not exact intraminute drawdown', note: 'not a time-weighted return', sampling: 'no interpolation' }} />)
  expect(html).toContain('0 retained observations')
  expect(html).toContain('cashflow_coverage_gap')
  expect(html).toContain('Equity change: Unavailable')
  expect(html).toContain('not exact intraminute drawdown')
})
