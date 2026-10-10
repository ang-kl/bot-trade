// npx vitest run src/components/scoreboard.test.jsx
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScoreboardView, RStrip, OpenPositions, NightlyRecord, NightlyLine } from './Scoreboard.jsx'
import { stripLabel, startScoreboardPolling, fmtPf, fmtPfR, fmtMoney, SCOREBOARD_PATH, SCOREBOARD_POLL_MS, fmtAmount, fmtPrice, stopSide, balanceView, flowWords, nightlyLabel } from '../lib/scoreboard-view.js'
import PerformanceTargets from './PerformanceTargets.jsx'
import { readFileSync } from 'node:fs'

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

// Claude · № 13,024 10-Oct (owner after № 13,017: "scoreboard doesn;t show
// current balance, float, SL/TP. Is there a record in the storage of Bot-trade
// the daily balance of account recorded so that we can check pattern").
const overview = { asOfMs: Date.UTC(2026, 9, 10, 12), accounts: [
  { accountId: '43097342', currency: 'SGD', balance: 3062.38, equity: 3059.28, openPnl: -3.0999999999999996, status: 'fresh', positions: [
    { positionId: 247729394, symbol: 'USDSGD', side: 'BUY', lots: 0.02, entry: 1.28014, sl: 1.28061, tp: 1.28368, price: 1.28017 + 1e-16, netPnl: 0.05 },
    { positionId: 247726486, symbol: 'JPYX', side: 'BUY', lots: 2, entry: 690.3, sl: null, tp: null, price: 690, netPnl: -0.98 },
  ] },
  { accountId: '42993489', currency: 'USD', balance: null, equity: null, openPnl: null, status: 'stale', positions: [] },
] }
const nightly = {
  currency: 'SGD', shown: 3, unitUnrecorded: 4, otherUnit: 0, earlierOwn: 0, change: 490, up: 1, down: 1, flat: 0,
  firstAt: '2026-10-05T23:54:00.000Z', lastAt: '2026-10-07T23:54:00.000Z',
  nights: [
    { at: '2026-10-05T23:54:00.000Z', balance: 1000, openPnl: 0, equity: 1000, openPositions: 0, error: null, balanceChange: null, flows: null },
    { at: '2026-10-06T23:54:00.000Z', balance: 1500, openPnl: -5, equity: 1495, openPositions: 1, error: null, balanceChange: 500, flows: { status: 'read', external: 500 } },
    { at: '2026-10-07T23:54:00.000Z', balance: 1490, openPnl: 0, equity: 1490, openPositions: 0, error: null, balanceChange: -10, flows: { status: 'unread', external: null } },
  ],
}

describe('balance, float and SL/TP', () => {
  it('each row shows the live balance, float and equity from the overview poll, in that account\'s currency', () => {
    const r = { ...report, accounts: report.accounts.map(a => a.accountId === '43097342' ? { ...a, nightly } : a) }
    const html = renderToStaticMarkup(<ScoreboardView report={r} overview={overview} />)
    for (const bad of ['NaN', 'undefined', 'null', 'Infinity']) expect(html).not.toContain(bad)
    expect(html).toContain('SGD 3,062.38'); expect(html).toContain('float SGD −3.10 · equity SGD 3,059.28')
    expect(html).toContain('no fresh broker balance', 'a stale reading is said, never shown as zero')
    expect(html).toContain('no broker reading for this account')
    expect(html).toContain('Balance now · float')
    expect(html).toContain('Daily balance (3)')
    // The positions sit under their own account, with stop and target.
    expect(html).toContain('SL 1.28061 (in profit)'); expect(html).toContain('TP 1.28368'); expect(html).toContain('now 1.28017')
    expect(html).toContain('no SL'); expect(html).toContain('no TP')
    expect(html.indexOf('USDSGD')).toBeGreaterThan(html.indexOf('Demo · 5067353 · 43097342'))
    expect(html.indexOf('USDSGD')).toBeLessThan(html.indexOf('Live · 1251247 · 42993489'))
  })

  it('before the first overview read the cell says it is reading, not "no reading"', () => {
    expect(balanceView(null, false)).toEqual({ value: '…', sub: 'reading the broker cache' })
    expect(balanceView(null, true).value).toBe('—')
    expect(balanceView({ currency: 'USD', balance: 10, openPnl: null }, true)).toEqual({ value: 'USD 10.00', sub: 'float not read yet' })
  })

  it('a stop on the profit side of entry is said; a SELL stop above entry is not', () => {
    expect(stopSide({ side: 'BUY', entry: 134.1, sl: 151.19 })).toBe('in profit')
    expect(stopSide({ side: 'SELL', entry: 376.46, sl: 391.97 })).toBe(null)
    expect(stopSide({ side: 'SELL', entry: 100, sl: 99 })).toBe('in profit')
    expect(stopSide({ side: 'BUY', entry: 100, sl: 100 })).toBe('at entry')
    expect(stopSide({ side: 'long', entry: 100, sl: 101 })).toBe(null)
    expect(stopSide({ side: 'BUY', entry: 100, sl: null })).toBe(null)
    expect(fmtPrice(1.28014 + 2e-16)).toBe('1.28014'); expect(1.28014 + 2e-16).not.toBe(1.28014); expect(fmtAmount(42851.89, 'USD')).toBe('USD 42,851.89')
    const html = renderToStaticMarkup(<OpenPositions positions={[{ positionId: 1, symbol: 'UNH.US', side: 'SELL', lots: 3.6, entry: 376.46, sl: 391.97, tp: 273.5, price: 378.9, netPnl: -8.97 }]} currency="USD" />)
    expect(html).toContain('SL 391.97<'); expect(html).not.toContain('in profit')
    expect(html).toContain('USD −8.97'); expect(html).toContain('3.6 lots')
  })
})

describe('nightly balance record', () => {
  it('lists every night newest first with its change, and says whether deposits were checked', () => {
    const html = renderToStaticMarkup(<NightlyRecord rec={nightly} />)
    for (const bad of ['NaN', 'undefined', 'null', 'Infinity']) expect(html).not.toContain(bad)
    expect(html).toContain('SGD 1,490.00'); expect(html).toContain('change −10.00'); expect(html).toContain('change +500.00')
    expect(html).toContain('incl. deposits/withdrawals +500.00', 'a +500 night that was a deposit')
    expect(html).toContain('deposits not checked')
    expect(html).toContain('change —')
    expect(html).toContain('4 earlier days not shown: currency not recorded then.')
    // Claude · № 13,029: each row named in New York time, whatever the browser's zone.
    expect(html).toContain('Wed, Oct 07, 7:54 PM ET'); expect(html).toContain('taken at the New York close (4:00 PM ET)')
    expect(html).toContain('First to last: <strong')
    expect(html.indexOf('SGD 1,490.00')).toBeLessThan(html.indexOf('SGD 1,500.00'))
    expect(flowWords(nightly.nights[0])).toBe('')
    expect(flowWords({ balanceChange: 1, flows: { status: 'read', external: 0 } })).toBe('no deposit or withdrawal')
    expect(flowWords({ balanceChange: 1, flows: { status: 'unclassified', external: null } })).toBe('a broker entry is unclassified')
  })

  it('the line is an image labelled with its counts; no nights draws nothing', () => {
    const html = renderToStaticMarkup(<NightlyLine rec={nightly} />)
    expect(html).toContain('role="img"')
    expect(nightlyLabel(nightly)).toBe('Daily balance, 3 readings, SGD 1,000.00 to SGD 1,490.00: up on 1 day, down on 1 day, unchanged on 0 days.')
    expect(renderToStaticMarkup(<NightlyLine rec={{ ...nightly, nights: [] }} />)).toBe('')
  })
})

// Claude · № 13,035 10-Oct (Codex P2 on #1304): on a wide card the header row
// is aria-hidden, so each value keeps its own label in the accessibility tree.
describe('wide layout keeps every cell labelled for a screen reader', () => {
  it('each figure is rendered with its label, and the wide CSS hides the label visually, never with display:none', () => {
    const html = renderToStaticMarkup(<ScoreboardView report={report} overview={overview} />)
    for (const label of ['Balance now', 'Win rate', 'Profit factor', 'Expectancy']) expect(html).toContain(`<span class="sb-cell-label">${label}</span>`)
    expect(html).toContain('class="sb-row sb-head" aria-hidden="true"')
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const wide = css.slice(css.indexOf('@container (min-width: 56rem)'))
    const rule = wide.match(/\.sb-cell-label\s*\{([^}]*)\}/)
    expect(rule, 'the wide block styles the label').not.toBeNull()
    expect(rule[1]).not.toMatch(/display:\s*none/)
    expect(rule[1]).toMatch(/clip-path:\s*inset\(50%\)/)
  })
})
