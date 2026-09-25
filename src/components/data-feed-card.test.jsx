import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DataFeed } from './PerfMacroSections.jsx'
import { dataFeedCardScope } from '../lib/data-feed.js'
import { dailyStopView, feedDailyStopView } from '../lib/daily-stop-display.js'

// WEB-9 (8,989-A row 11): the card prints measured figures with their
// coverage and names what is not measured — no hard-coded latency dash, no
// configured % presented as the binding daily loss. The daily stop is the
// account-overview reading the account cards print (WEB-2), not a figure of
// this card's own.
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
// GET /state/account-overview accounts[].dailyStop, as daily-stop-reading.js
// returns it: the 4% tier on a 30,004.36 account, a USD account, no loss yet.
const TIER = {
  accountId: '46130058', status: 'in_force', reason: null, capUsd: 1200.17, currency: 'USD', binding: 'pct',
  explain: '% cap $1200.17 — the $300.00 flat cap is out of force while the balance tier rule is on',
  balanceUsed: 30004.36, balanceKey: 'acct:46130058:account_balance_usd', remainingUsd: 1200.17, engineBlock: null,
  moneyCurrency: 'USD', unitsComparable: true, unitsNote: null, estimatedStopoutUsd: null,
  lossCapUsed: { status: 'measured', pct: 0, consumed: 0, realisedLoss: 0, floatingLoss: 0, reason: null },
}
// The USD 200 floor on an SGD account (H-P2-4 open).
const FLOOR_SGD = {
  accountId: '99990001', status: 'in_force', reason: null, capUsd: 200, currency: 'USD', binding: 'floor',
  explain: 'the USD 200.00 floor binds — above USD 1.54 from the % check', remainingUsd: 173.4, engineBlock: null,
  moneyCurrency: 'SGD', unitsComparable: false,
  unitsNote: "The risk engine compares this USD-configured cap with this account's SGD P&L; units question H-P2-4 is open and nothing here converts it.",
  lossCapUsed: { status: 'not_comparable', pct: null, consumed: null, realisedLoss: 26.6, floatingLoss: 0, reason: 'units' },
}
const overview = { accounts: [{ accountId: '46130058', dailyStop: TIER }, { accountId: '99990001', dailyStop: FLOOR_SGD }] }

describe('Data-feed card', () => {
  it('shows measured latency with coverage, fees per currency and quote freshness', () => {
    const html = renderToStaticMarkup(<DataFeed feedReport={report} dailyStop={dailyStopView(TIER)} openCount={1} slSet={1} tpSet={1} />)
    expect(html).toContain('p50 312 ms · p90 1,480 ms · measured on 154 of 300 closes')
    expect(html).toContain('USD · commission -812.40 (298/300 recorded) · swap -45.10 (298/300 recorded)')
    expect(html).toContain('sidecar 4 · broker 31 (stale 31) · record 2 s old')
    expect(html).toContain('Not measured: market-feed latency (broker timestamp to receipt)')
    // The old card: a hard-coded dash where 154 measurements exist.
    expect(html).not.toMatch(/latency <span[^>]*>—<\/span>/)
  })
  it('shows the stop the engine enforces, why it binds and what is left today — from the one reading', () => {
    const html = renderToStaticMarkup(<DataFeed feedReport={report} dailyStop={dailyStopView(TIER)} />)
    expect(html).toContain('daily stop −1,200 USD (FX day)</span> · % cap $1200.17 — the $300.00 flat cap is out of force while the balance tier rule is on · 1,200 USD left today')
    expect(html).not.toContain('3%/day')
    expect(html).not.toContain('H-P2-4')
  })
  it('a non-USD account: the USD cap and the reading\'s units note, never a mixed-unit "left today"', () => {
    const html = renderToStaticMarkup(<DataFeed dailyStop={dailyStopView(FLOOR_SGD)} />)
    expect(html).toContain('daily stop −200 USD (FX day)</span> · the USD 200.00 floor binds — above USD 1.54 from the % check · left today not comparable')
    expect(html).not.toContain('173')
    expect(html).toContain('units question H-P2-4 is open')
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
    expect(html).toContain('daily stop not read')
    expect(html).not.toContain('p50')
  })
  it('the all-accounts view names the per-account stop instead of a dash or one account\'s figure', () => {
    const html = renderToStaticMarkup(<DataFeed allAccounts feedReport={report} dailyStop={dailyStopView(TIER)} />)
    expect(html).toContain('daily stop per account — see the account cards')
    expect(html).not.toContain('1,200')
  })
  it("after an account switch the card shows none of the previous account's figures (render-time scope)", () => {
    // What Performance.jsx holds between the switch and the new load: `acct`
    // is the new account, `feedReport` / `riskFull` are still the old one's.
    // risk-full's own daily-loss figures ride along and must not surface.
    const riskFullOld = {
      risk: { scopedTo: '46130058', effective: { equityStopPct: 0.15 } },
      account: { accountId: '46130058', depositCurrency: 'SGD' },
      dailyPacing: { accountId: '46130058', capUsd: 150, binding: 'usd' },
      dailyCapEnforced: { status: 'computed', accountId: '46130058', capUsd: 987.65, binding: 'usd' },
    }
    const card = (acct) => renderToStaticMarkup(<DataFeed {...dataFeedCardScope({ acct, feedReport: report, riskFull: riskFullOld })} dailyStop={feedDailyStopView(overview, acct)} />)
    const same = card('46130058')
    expect(same).toContain('p50 312 ms')
    expect(same).toContain('commission -812.40')
    expect(same).toContain('daily stop −1,200 USD (FX day)')
    expect(same).toContain('configured 15%')
    for (const other of ['987', '150', 'deposits in SGD', 'H-P2-4']) expect(same).not.toContain(other)

    const switched = card('99990001')
    for (const old of ['p50 312 ms', 'commission -812.40', 'sidecar 4', '1,200', 'configured 15%']) {
      expect(switched).not.toContain(old)
    }
    expect(switched).toContain('entry latency unavailable — the data-feed report did not load')
    // The daily stop is the NEW account's own row, at once — the overview
    // carries every account, so there is no stale window to guard.
    expect(switched).toContain('daily stop −200 USD (FX day)')
    expect(switched).toMatch(/equity stop <span[^>]*>unverified</)
  })
  it('both DataFeed sites on the Performance page take their account props from the render-time scope', () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const page = strip(readFileSync(new URL('../pages/Performance.jsx', import.meta.url), 'utf8'))
    const sites = page.split('<DataFeed').slice(1).map(s => s.slice(0, s.indexOf('/>')))
    expect(sites).toHaveLength(2)
    for (const site of sites) {
      expect(site).toContain('{...feedCardScope}')
      // The daily stop is the one reading the account cards use.
      expect(site).toContain('dailyStop={feedDailyStop}')
      // No site re-passes an unguarded account prop after (or instead of) the spread.
      expect(site).not.toMatch(/\b(feedReport|dailyCap|depositCurrency|equityStopPct|equityStopArmed|allAccounts)=/)
    }
    expect(page).toMatch(/const feedCardScope = dataFeedCardScope\(\{ acct, feedReport, riskFull, error \}\)/)
    expect(page).toMatch(/const feedDailyStop = useMemo\(\(\) => feedDailyStopView\(overview, acct\), \[overview, acct\]\)/)
    // …and the account cards read the same overview rows through the same view.
    expect(page).toMatch(/const current = overview\?\.accounts\.find\(r => r\.accountId === String\(a\.account_id\)\)/)
    expect(page).toMatch(/const stop = cardStopFields\(current, /)
  })
  // WEB-9b: the OHLCV chips were five fixed labels over "their receipt times
  // are not measured". They are now the agent's own receipt times.
  it('the timeframe chips show real receipt times, and the feed latency is measured on the broker stamp', () => {
    const now = report.asOfMs
    const withReceipts = {
      ...report,
      barReceipts: {
        sinceMs: now - 3_600_000,
        timeframes: [
          { timeframe: '15m', periodMs: 900_000, lastReceivedAtMs: now - 42_000, sources: [{ source: 'strategy_scan', receivedAtMs: now - 42_000, newestBarOpenMs: now - 60_000, newestBarForming: true, bars: 150, accountId: '46130058' }] },
          { timeframe: '1d', periodMs: 86_400_000, lastReceivedAtMs: now - 600_000, sources: [{ source: 'daily_bar', receivedAtMs: now - 600_000, newestBarOpenMs: Date.parse('2026-09-23T21:00:00Z'), newestBarForming: false, bars: 2, accountId: '46130058' }] },
        ],
      },
      feedLatency: { status: 'measured', windowMs: 600_000, rangeMs: 60_000, byHost: [{ host: 'demo.ctraderapi.com', events: 212, p50Ms: 38, p90Ms: 120, maxMs: 910, outOfRange: 0, unstamped: 0 }] },
      notMeasured: [{ key: 'gateway_feed_latency', label: "market-feed latency on the gateways' tick feed (Node holds no broker timestamp for it)" }],
    }
    const html = renderToStaticMarkup(<DataFeed feedReport={withReceipts} nowMs={now} />)
    expect(html).toContain('>15m · 42 s</span>')
    expect(html).toContain('>1D · 10 min</span>')
    expect(html).toContain('>1m · none</span>')
    expect(html).toContain('already closed at receipt')
    expect(html).toContain('Each chip is how long ago the agent last received')
    expect(html).toContain('demo.ctraderapi.com p50 38 ms · p90 120 ms · max 910 ms over 212 events')
    expect(html).not.toContain('receipt times are not measured')
    expect(html).not.toContain('per-timeframe bar receipt times')
    // A report without receipts (an older agent) claims no time on a chip.
    const old = renderToStaticMarkup(<DataFeed feedReport={report} nowMs={now} />)
    expect(old).toContain('bar receipt times not reported by this agent')
    expect(old).toContain('market-feed latency not reported by this agent')
    expect(old).toMatch(/>1h<\/span>/)
    const none = renderToStaticMarkup(<DataFeed />)
    expect(none).toContain('bar receipt times unavailable — the data-feed report did not load')
    expect(none).toContain('market-feed latency unavailable — the data-feed report did not load')
    expect(none).not.toContain('Not measured:')
  })
  it('a configured equity stop is not presented as a verified armed state', () => {
    const html = renderToStaticMarkup(<DataFeed equityStopArmed equityStopPct={0.15} />)
    expect(html).toContain('configured 15%')
    expect(html).toContain('armed state not measured')
    expect(html).not.toContain('>armed<')
  })
})
