// Codex · №11,791 · 2026-10-07; codex-footprint: performance-essentials.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PerformanceTargets from './PerformanceTargets.jsx'
const row = { accountId: '11', currency: 'SGD', latest20: { n: 20, eligible: 19, pending: 1 },
  winRate: { status: 'unmeasurable', latest20Status: 'unmeasurable', consecutiveDays: 0 },
  profitFactor: { status: 'unmeasurable', latest20Status: 'unmeasurable', consecutiveDays: 0 },
  currentDay: { day: '2026-10-07', n: 0 }, days: [], unavailable: '1 pending close.' }
const report = { accounts: [row, { ...row, accountId: '22', currency: 'USD' }] }
describe('Essential goal layout', () => {
  it('leads with the explicitly selected account on phones while retaining every account', () => {
    const html = renderToStaticMarkup(<PerformanceTargets report={report} selected="22" variant="responsive" />)
    const mobile = html.split('class="min-[700px]:hidden"')[1].split('class="hidden min-[700px]:flex"')[0]
    expect(mobile.indexOf('22 · USD')).toBeLessThan(mobile.indexOf('<summary>1 other account'))
    expect(mobile).toContain('11 · SGD')
    expect(mobile).toContain('1 pending close.')
    expect(html).not.toContain('>Met<')
  })
  it('does not silently choose an account when the selected identity is absent', () => {
    const html = renderToStaticMarkup(<PerformanceTargets report={report} selected="absent" variant="responsive" />)
    const mobile = html.split('class="min-[700px]:hidden"')[1].split('class="hidden min-[700px]:flex"')[0]
    expect(mobile).toContain('<summary>All 2 account results</summary>')
    expect(mobile.indexOf('<summary>')).toBeLessThan(mobile.indexOf('<article'))
  })
})
