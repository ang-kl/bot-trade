// npx vitest run src/components/scoreboard.test.jsx
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScoreboardView, RStrip } from './Scoreboard.jsx'
import { stripLabel, startScoreboardPolling, fmtPf, fmtPfR, fmtMoney, SCOREBOARD_PATH, SCOREBOARD_POLL_MS } from '../lib/scoreboard-view.js'
import PerformanceTargets from './PerformanceTargets.jsx'

const metrics = over => ({ n: 0, wins: 0, losses: 0, zeros: 0, winRatePct: null, grossWin: 0, grossLoss: 0, profitFactor: null,
  avgWin: null, avgLoss: null, payoff: null, net: null, expectancy: null, rScored: 0, expectancyR: null, profitFactorR: null, ...over })
const tradeRows = Array.from({ length: 20 }, (_, i) => ({
  id: 100 + i, symbol: i % 2 ? 'EURUSD' : 'XAUUSD', side: i % 3 ? 'BUY' : 'SELL', strategy: i === 4 ? null : 'vwap_trend',
  close_reason: i === 5 ? null : 'tp_hit', net_pnl: i % 2 ? 12.3 : -16.4, realised_rr: i === 7 ? null : i % 2 ? 0.61 + i / 10 : -0.81,
  closed_at: i === 9 ? null : new Date(Date.UTC(2026, 9, 10, 8, 0) - i * 3_600_000).toISOString(), source: i % 5 ? 'autopilot' : 'manual',
}))
const account = (id, currency, over = {}) => ({
  accountId: id, label: `…${id.slice(-4)}`, currency, registered: true, enabled: true, closedN: 30, lastCloseAt: '2026-10-10T08:00:00.000Z',
  last20: { ...metrics({ n: 20, wins: 9, losses: 11, winRatePct: 45, grossWin: 110.7, grossLoss: 180.4, profitFactor: 0.61, avgWin: 12.3,
    avgLoss: 16.4, payoff: 0.75, net: -69.7, expectancy: -3.49, rScored: 19, expectancyR: -0.12, profitFactorR: 0.8 }),
  externalN: 4, rows: tradeRows, bot: metrics({ n: 16 }) },
  days30: { days: 30, from: '2026-09-10T08:00:00.000Z', ...metrics({ n: 38 }), externalN: 6,
    bot: metrics({ n: 32, wins: 14, losses: 18, winRatePct: 43.75, profitFactor: 0.72, expectancyR: 0.12, net: -80, rScored: 30 }) },
  ...over,
})
const report = {
  at: '2026-10-10T08:01:00.000Z', account: 'all', days: 30, trades: 20,
  accounts: [account('43097342', 'SGD', { login: '5067353', isLive: false, leverage: 200, openNow: 3, closedToday: 2 }), account('42993489', 'USD', { login: '1251247', isLive: true }),
    { ...account('11112222', null), last20: { ...metrics({}), externalN: 0, rows: [], bot: metrics({}) },
      days30: { days: 30, ...metrics({}), externalN: 0, bot: metrics({}) }, lastCloseAt: null }],
  pooled: { days30: metrics({ n: 76 }), days30Bot: metrics({ n: 64, winRatePct: 43.75, expectancyR: 0.12 }) },
  excluded: { unpriced: 0, unstamped: 0, superseded: 1 },
}

describe('Scoreboard view', () => {
  it('renders every account with its own currency label, big figures and no NaN/undefined/null text', () => {
    const html = renderToStaticMarkup(<ScoreboardView report={report} selected="42993489" />)
    for (const bad of ['NaN', 'undefined', 'null', 'Infinity']) expect(html).not.toContain(bad)
    expect(html).toContain('…7342'); expect(html).toContain('…3489'); expect(html).toContain('…2222')
    // Claude · № 12,990: the owner's account line — side · login · account · currency — and its facts.
    expect(html).toContain('Demo · 5067353 · 43097342 · SGD'); expect(html).toContain('Live · 1251247 · 42993489 · USD')
    expect(html).toContain('11112222 · currency unverified'); expect(html).toContain('1:200 · 3 open · 2 closed today · 30 closed')
    expect(html).toContain('SGD −69.70'); expect(html).toContain('USD −69.70')
    expect(html).toContain('45%'); expect(html).toContain('0.61'); expect(html).toContain('−0.12R')
    expect(html).toContain('Win ÷ loss <strong>0.75</strong>') // Claude · № 12,989: compact row wording
    expect(html).toContain('30 days, bot only: </span>32 trades') // Claude · № 12,989
    expect(html).toContain('Last 20 trades')
    expect(html).toContain('No closed trades recorded.')
    expect(html).toContain('R pooled; no money total')
    // The selected account leads.
    expect(html.indexOf('…3489')).toBeLessThan(html.indexOf('…7342'))
    // Money from two currencies is never added: -69.70 twice, never -139.40.
    expect(html).not.toContain('139.40')
  })

  it('the strip is an image with counts in its label, bars above and below a zero line, no forbidden colour', () => {
    const html = renderToStaticMarkup(<RStrip rows={tradeRows} />)
    expect(html).toContain('role="img"')
    expect(html).toContain(`aria-label="${stripLabel(tradeRows)}"`)
    expect(stripLabel(tradeRows)).toBe('R of the last 20 trades, oldest to newest: 9 above zero, 10 below zero, 0 at zero, 1 without a scored R. Bars clipped at plus or minus 3R.')
    expect(html).toContain('fill="var(--color-up)"'); expect(html).toContain('fill="var(--color-down)"')
    expect((html.match(/<rect /g) || []).length).toBe(20)
    // Every fill is a theme token: up, down, or muted for an unscored trade.
    expect([...new Set(html.match(/fill="[^"]*"/g))].sort()).toEqual(['fill="var(--color-down)"', 'fill="var(--color-muted)"', 'fill="var(--color-up)"'])
    for (const bad of ['NaN', 'undefined']) expect(html).not.toContain(bad)
  })

  it('a large R is clipped at ±3R: a 9R bar is no taller than a 3R bar', () => {
    const tall = renderToStaticMarkup(<RStrip rows={[{ id: 1, realised_rr: 9 }]} />)
    const three = renderToStaticMarkup(<RStrip rows={[{ id: 1, realised_rr: 3 }]} />)
    const h = s => Number(s.match(/<rect [^>]*height="([\d.]+)"/)[1])
    expect(h(tall)).toBe(h(three))
  })

  it('profit factor says "no losses" rather than a number, and a dash with no trades', () => {
    expect(fmtPf(null, { n: 3, losses: 0 })).toBe('no losses')
    expect(fmtPf(null, { n: 0, losses: 0 })).toBe('—')
    expect(fmtPf(1.234, { n: 3, losses: 1 })).toBe('1.23')
    expect(fmtPfR({ rScored: 0 })).toBe('—')
    expect(fmtPfR({ rScored: 2, profitFactorR: null })).toBe('no losses')
    expect(fmtMoney(-5, 'SGD')).toBe('SGD −5.00'); expect(fmtMoney(5, null)).toBe('+5.00'); expect(fmtMoney(null, 'SGD')).toBe('—')
  })

  it('no report yet, a failed first read, and a failed later read each say so', () => {
    expect(renderToStaticMarkup(<ScoreboardView report={null} />)).toContain('Reading the scoreboard')
    expect(renderToStaticMarkup(<ScoreboardView report={null} error="busy" />)).toContain('Scoreboard unavailable: busy')
    const stale = renderToStaticMarkup(<ScoreboardView report={report} error="busy" />)
    expect(stale).toContain('Last read failed (busy); showing the read from')
  })
})

describe('Scoreboard polling', () => {
  afterEach(() => { vi.useRealTimers() })
  it('fetches on mount, then every 60 s, and skips while the page is asleep', async () => {
    vi.useFakeTimers()
    expect(SCOREBOARD_POLL_MS).toBe(60_000)
    let asleep = false
    const get = vi.fn().mockResolvedValue(report)
    const reports = [], errors = []
    const stop = startScoreboardPolling({ onReport: r => reports.push(r), onError: e => errors.push(e) },
      { get, asleep: () => asleep, configured: () => true, target: null, win: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenLastCalledWith(SCOREBOARD_PATH)
    expect(SCOREBOARD_PATH).toBe('/state/scoreboard?account=all&days=30')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(2)
    asleep = true
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(get).toHaveBeenCalledTimes(2)
    asleep = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(3)
    get.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(errors).toEqual(['offline'])
    expect(reports.length).toBe(3)
    stop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(get).toHaveBeenCalledTimes(4)
  })
})

describe('Forward results card: measured latest-20 beside the unchanged verdict', () => {
  const row = { accountId: '11', currency: 'SGD', scope: { account: '11', coverage: { pct: 100 } }, conversionFee: 0,
    latest20: { n: 20, eligible: 12, pending: 8, winRatePct: null, profitFactor: null,
      measured: { n: 12, wins: 9, losses: 3, winRatePct: 75, profitFactor: 2, grossWin: 18, grossLoss: 9 } },
    winRate: { status: 'not_assessed', latest20Status: 'unmeasurable', consecutiveDays: 0 },
    profitFactor: { status: 'not_assessed', latest20Status: 'unmeasurable', consecutiveDays: 0 },
    currentDay: { day: '2026-10-10', n: 0 }, days: [] }
  it('shows "k of n broker-proven" and the figures, and the verdict still reads Evidence incomplete', () => {
    const html = renderToStaticMarkup(<PerformanceTargets report={{ accounts: [row] }} selected="11" />)
    expect(html).toContain('Measured so far (12 of 20 broker-proven): win rate 75.0% · 9W / 3L · PF 2.00')
    expect(html).toContain('Evidence incomplete')
    expect(html).not.toContain('>Met<')
  })
  it('an older server without the measured block renders as before', () => {
    const { measured, ...latest20 } = row.latest20
    expect(measured).toBeTruthy()
    const html = renderToStaticMarkup(<PerformanceTargets report={{ accounts: [{ ...row, latest20 }] }} selected="11" />)
    expect(html).not.toContain('Measured so far')
  })
})

// Claude · № 12,989 10-Oct (owner: "too much white spacing, and have to scroll
// down"): one compact row per account under ONE header row (hidden from screen
// readers and, by CSS, on phones — each cell then carries its own label).
describe('compact rows', () => {
  it('one header row and one row per account', () => {
    const html = renderToStaticMarkup(<ScoreboardView report={report} />)
    expect((html.match(/class="sb-row sb-head" aria-hidden="true"/g) || []).length).toBe(1)
    expect((html.match(/<article class="sb-row"/g) || []).length).toBe(report.accounts.length)
    for (const h of ['Win rate', 'Profit factor', 'Expectancy', 'Win ÷ loss · net']) expect(html).toContain(h)
  })
})
