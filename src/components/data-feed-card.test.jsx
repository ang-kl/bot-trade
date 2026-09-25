import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DataFeed } from './PerfMacroSections.jsx'
import { dataFeedCardScope } from '../lib/data-feed.js'

// WEB-9 (8,989-A row 11): the card prints measured figures with their
// coverage and names what is not measured — no hard-coded latency dash, no
// configured % presented as the binding daily loss.
const OPEN = Date.parse('2026-09-24T21:00:00Z')
const report = {
  accountId: '46130058', asOfMs: Date.parse('2026-09-25T12:00:00Z'), brokerDayOpenMs: OPEN,
  execution: {
    window: { closes: 300, limit: 300, unattributed: 0 },
    latency: { measured: 154, of: 300, p50Ms: 312, p90Ms: 1480, maxMs: 4000 },
    costs: [{ currency: 'USD', closes: 300, commissionKnown: 298, commission: -812.4, swapKnown: 298, swap: -45.1, accounts: ['46130058'] }],
  },
  quotes: { status: 'measured', ageMs: 2_000, window10m: { passes: 11, fromSidecar: 4, fromBroker: 31, stale: 31 } },
  notMeasured: [{ key: 'feed_latency', label: 'market-feed latency (broker timestamp to receipt)' }],
}
const enforced = { status: 'computed', accountId: '46130058', capUsd: 1200.1744, binding: 'pct', pct: 0.04, gateBalanceUsd: 30004.36, remainingUsd: 1200.1744, uncapped: false, blocked: false }

describe('Data-feed card', () => {
  it('shows measured latency with coverage, fees per currency and quote freshness', () => {
    const html = renderToStaticMarkup(<DataFeed feedReport={report} dailyCap={enforced} openCount={1} slSet={1} tpSet={1} />)
    expect(html).toContain('p50 312 ms · p90 1,480 ms · measured on 154 of 300 closes')
    expect(html).toContain('USD · commission -812.40 (298/300 recorded) · swap -45.10 (298/300 recorded)')
    expect(html).toContain('sidecar 4 · broker 31 (stale 31) · record 2 s old')
    expect(html).toContain('Not measured: market-feed latency (broker timestamp to receipt)')
    // The old card: a hard-coded dash where 154 measurements exist.
    expect(html).not.toMatch(/latency <span[^>]*>—<\/span>/)
  })
  it('shows the cap the gate enforces, not the configured base %', () => {
    const html = renderToStaticMarkup(<DataFeed feedReport={report} dailyCap={enforced} depositCurrency="USD" />)
    expect(html).toContain('daily loss limit 1,200.17 USD/day enforced — the % of balance binds (4% of 30,004.36)')
    expect(html).not.toContain('3%/day')
  })
  it('labels a daily bar from an earlier broker day', () => {
    const positions = [{ id: 1, account_id: '46130058', symbol: 'XRPUSD', day: { t: Date.parse('2026-09-23T21:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5274, v: 10 } }]
    const html = renderToStaticMarkup(<DataFeed feedReport={report} marketReadings={positions} />)
    expect(html).toContain('1 retained daily bar for scoped open positions · 1 from an earlier broker day')
    expect(html).toContain('previous broker day, started 39 h ago — not today&#x27;s forming bar')
  })
  it('says the report did not load instead of drawing zeros or dashes', () => {
    const html = renderToStaticMarkup(<DataFeed />)
    expect(html).toContain('entry latency unavailable — the data-feed report did not load')
    expect(html).toContain('fees and swap unavailable')
    expect(html).toContain('quote freshness unavailable')
    expect(html).toContain('daily loss limit unavailable')
    expect(html).not.toContain('p50')
  })
  it('the all-accounts view names the per-account cap instead of a dash', () => {
    const html = renderToStaticMarkup(<DataFeed allAccounts feedReport={report} />)
    expect(html).toContain('daily loss limit per account — select one account')
  })
  it("after an account switch the card shows none of the previous account's figures (render-time scope)", () => {
    // What Performance.jsx holds between the switch and the new load: `acct`
    // is the new account, `feedReport` / `riskFull` are still the old one's.
    const riskFullOld = {
      risk: { scopedTo: '46130058', effective: { equityStopPct: 0.15 } },
      account: { accountId: '46130058', depositCurrency: 'SGD' },
      dailyCapEnforced: enforced,
    }
    const same = renderToStaticMarkup(<DataFeed {...dataFeedCardScope({ acct: '46130058', feedReport: report, riskFull: riskFullOld })} />)
    expect(same).toContain('p50 312 ms')
    expect(same).toContain('commission -812.40')
    expect(same).toContain('daily loss limit 1,200.17 USD/day enforced')
    expect(same).toContain('deposits in SGD')
    expect(same).toContain('configured 15%')

    const switched = renderToStaticMarkup(<DataFeed {...dataFeedCardScope({ acct: '99990001', feedReport: report, riskFull: riskFullOld })} />)
    for (const old of ['p50 312 ms', 'commission -812.40', 'sidecar 4', '1,200.17', 'deposits in SGD', 'configured 15%']) {
      expect(switched).not.toContain(old)
    }
    expect(switched).toContain('entry latency unavailable — the data-feed report did not load')
    expect(switched).toContain('daily loss limit unavailable')
    expect(switched).toMatch(/equity stop <span[^>]*>unverified</)
  })
  it('both DataFeed sites on the Performance page take their account props from the render-time scope', () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const page = strip(readFileSync(new URL('../pages/Performance.jsx', import.meta.url), 'utf8'))
    const sites = page.split('<DataFeed').slice(1).map(s => s.slice(0, s.indexOf('/>')))
    expect(sites).toHaveLength(2)
    for (const site of sites) {
      expect(site).toContain('{...feedCardScope}')
      // No site re-passes an unguarded account prop after (or instead of) the spread.
      expect(site).not.toMatch(/\b(feedReport|dailyCap|depositCurrency|equityStopPct|equityStopArmed|allAccounts)=/)
    }
    expect(page).toMatch(/const feedCardScope = dataFeedCardScope\(\{ acct, feedReport, riskFull, error \}\)/)
  })
  it('a configured equity stop is not presented as a verified armed state', () => {
    const html = renderToStaticMarkup(<DataFeed equityStopArmed equityStopPct={0.15} />)
    expect(html).toContain('configured 15%')
    expect(html).toContain('armed state not measured')
    expect(html).not.toContain('>armed<')
  })
})
