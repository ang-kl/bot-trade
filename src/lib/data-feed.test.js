import { describe, it, expect } from 'vitest'
import { dailyBarAge, dailyBarNote, dailyBarsSummary, latencyLine, costLines, quoteFreshnessLine, dataFeedCardScope,
  timeframeChips, barReceiptsNote, feedLatencyLine, quoteReceiptNote, formatAge } from './data-feed.js'

const OPEN = Date.parse('2026-09-24T21:00:00Z') // current broker day open
const NOW = Date.parse('2026-09-25T12:00:00Z')

describe('dailyBarAge', () => {
  it('names a bar from before the current broker-day open as an earlier day', () => {
    const a = dailyBarAge(Date.parse('2026-09-23T21:00:00Z'), OPEN, NOW)
    expect(a).toEqual({ status: 'earlier', ageHours: 39, days: 1 })
    expect(dailyBarNote(a)).toBe("previous broker day, started 39 h ago — not today's forming bar")
    expect(dailyBarNote(dailyBarAge(Date.parse('2026-09-21T21:00:00Z'), OPEN, NOW))).toMatch(/^3 broker days back/)
  })
  it('names the current day as current', () => {
    const a = dailyBarAge(OPEN, OPEN, NOW)
    expect(a.status).toBe('current')
    expect(dailyBarNote(a)).toBe('current broker day')
  })
  it('a bar starting up to 2 h before the anchor is unverified with the offset named, never "previous broker day"', () => {
    // After US DST ends (01-11) the anchor moves to 22:00Z; if the broker's
    // D1 bars stay at 21:00Z, the forming bar starts 1 h before the anchor.
    const winterOpen = Date.parse('2026-11-02T22:00:00Z')
    const winterNow = Date.parse('2026-11-03T12:00:00Z')
    const a = dailyBarAge(Date.parse('2026-11-02T21:00:00Z'), winterOpen, winterNow)
    expect(a).toEqual({ status: 'unverified', ageHours: 15, days: null, anchorOffsetHours: 1 })
    expect(dailyBarNote(a)).toBe("broker day unverified — bar boundary 1 h before the gate's 17:00 New York day open")
    expect(dailyBarNote(a)).not.toMatch(/previous broker day/)
    expect(dailyBarAge(winterOpen - 2 * 3_600_000, winterOpen, winterNow).status).toBe('unverified')
    // Past the band it is an earlier day again — the previous 21:00Z bar
    // starts 25 h before the anchor.
    const prev = dailyBarAge(Date.parse('2026-11-01T21:00:00Z'), winterOpen, winterNow)
    expect(prev).toMatchObject({ status: 'earlier', days: 1 })
    expect(dailyBarAge(winterOpen - 3 * 3_600_000, winterOpen, winterNow).status).toBe('earlier')
    expect(dailyBarsSummary([{ day: { t: Date.parse('2026-11-02T21:00:00Z') } }], winterOpen, winterNow))
      .toBe('1 retained daily bar for scoped open positions · 1 with the day unverified')
  })
  it('does not guess a day when the anchor or the bar time is missing', () => {
    expect(dailyBarAge(OPEN, null, NOW).status).toBe('unverified')
    expect(dailyBarAge(null, OPEN, NOW).status).toBe('unverified')
    expect(dailyBarNote(dailyBarAge(OPEN, null, NOW))).toBe('broker day unverified')
  })
  it('summarises how many retained bars are from an earlier day', () => {
    const rows = [{ day: { t: Date.parse('2026-09-23T21:00:00Z') } }, { day: { t: OPEN } }, { day: null }]
    expect(dailyBarsSummary(rows, OPEN, NOW)).toBe('2 retained daily bars for scoped open positions · 1 from an earlier broker day')
    expect(dailyBarsSummary(null, OPEN, NOW)).toBe('Feed freshness unavailable')
    expect(dailyBarsSummary([], OPEN, NOW)).toBe('No retained daily bars for scoped open positions')
    expect(dailyBarsSummary(rows, null, NOW)).toContain('2 with the day unverified')
  })
})

describe('latencyLine', () => {
  it('prints the measured percentiles with their coverage', () => {
    expect(latencyLine({ measured: 154, of: 300, p50Ms: 312, p90Ms: 1480 }))
      .toBe('entry latency p50 312 ms · p90 1,480 ms · measured on 154 of 300 closes (submit → execution event)')
  })
  it('says not measured instead of printing a dash or a zero', () => {
    expect(latencyLine({ measured: 0, of: 12, p50Ms: null, p90Ms: null })).toBe('entry latency not measured on any of the latest 12 closes')
    expect(latencyLine(null)).toMatch(/unavailable/)
    expect(latencyLine({ measured: 0, of: 0 })).toMatch(/no recorded closes/)
  })
})

describe('costLines', () => {
  it('prints one line per currency and never a cross-currency total', () => {
    const lines = costLines({ window: { closes: 5 }, costs: [
      { currency: 'SGD', closes: 2, commissionKnown: 2, commission: -7, swapKnown: 1, swap: 0.5 },
      { currency: 'USD', closes: 2, commissionKnown: 2, commission: -1234.5, swapKnown: 0, swap: null },
      { currency: null, closes: 1, commissionKnown: 1, commission: -1, swapKnown: 1, swap: -1 },
    ] })
    expect(lines).toEqual([
      'SGD · commission -7.00 (2/2 recorded) · swap 0.50 (1/2 recorded)',
      'USD · commission -1,234.50 (2/2 recorded) · swap not recorded on 2 closes',
      'currency unverified · commission -1.00 (1/1 recorded) · swap -1.00 (1/1 recorded)',
    ])
    expect(lines.join(' ')).not.toMatch(/-1,242/)
  })
  it('says unavailable or empty instead of drawing zeros', () => {
    expect(costLines(null)).toEqual(['fees and swap unavailable — the data-feed report did not load'])
    expect(costLines({ window: { closes: 0 }, costs: [] })).toEqual(['fees and swap: no recorded closes in this scope'])
  })
})

describe('quoteFreshnessLine', () => {
  it('prints the 10-minute quote sources with the record age', () => {
    expect(quoteFreshnessLine({ status: 'measured', ageMs: 4_400, window10m: { passes: 12, fromSidecar: 4, fromBroker: 31, stale: 31 } }))
      .toBe('quotes, last 10 min (12 priced passes): sidecar 4 · broker 31 (stale 31) · record 4 s old')
  })
  it('names the missing record', () => {
    expect(quoteFreshnessLine({ status: 'unavailable', reason: 'no fast-monitor pass record' })).toBe('quote freshness not recorded (no fast-monitor pass record)')
    expect(quoteFreshnessLine({ status: 'no_priced_pass', ageMs: 1000, window10m: null })).toBe('quote freshness: no priced pass in the last 10 min · record 1 s old')
    expect(quoteFreshnessLine(null)).toMatch(/did not load/)
  })
})

describe('dataFeedCardScope', () => {
  // The state an account switch leaves behind: acct already moved to B,
  // feedReport and riskFull still A's until the new load finishes.
  const feedA = { accountId: 'A', execution: { latency: { measured: 1, of: 1, p50Ms: 5, p90Ms: 5 } } }
  // risk-full also carries daily-loss figures of its own (`dailyPacing`, and
  // a gate figure WEB-9 once added). None of them may reach the card: its
  // daily stop is the account-overview reading the account cards print.
  const riskA = {
    risk: { scopedTo: 'A', effective: { equityStopPct: 0.15 } },
    account: { accountId: 'A', depositCurrency: 'SGD' },
    dailyPacing: { accountId: 'A', capUsd: 150, binding: 'usd' },
    dailyCapEnforced: { status: 'computed', accountId: 'A', capUsd: 100 },
  }
  it('passes every figure through when the responses belong to the account on screen', () => {
    expect(dataFeedCardScope({ acct: 'A', feedReport: feedA, riskFull: riskA })).toEqual({
      feedReport: feedA,
      allAccounts: false,
      equityStopPct: 0.15,
      equityStopArmed: true,
    })
  })
  it("never hands the previous account's figures to the new account", () => {
    expect(dataFeedCardScope({ acct: 'B', feedReport: feedA, riskFull: riskA })).toEqual({
      feedReport: null,
      allAccounts: false,
      equityStopPct: null,
      equityStopArmed: null,
    })
  })
  it('carries no daily-loss figure and no second currency reading from risk-full', () => {
    const s = dataFeedCardScope({ acct: 'A', feedReport: feedA, riskFull: riskA })
    const flat = JSON.stringify(s)
    for (const n of ['150', '100', 'SGD']) expect(flat).not.toContain(n)
    for (const k of ['dailyCap', 'dailyStop', 'dailyPacing', 'depositCurrency']) expect(s).not.toHaveProperty(k)
  })
  it('the all-accounts view carries no single-account figure', () => {
    const s = dataFeedCardScope({ acct: 'all', feedReport: feedA, riskFull: riskA })
    expect(s.allAccounts).toBe(true)
    expect(s.feedReport).toBeNull()
    expect(s.equityStopArmed).toBeNull()
    const own = { ...feedA, accountId: 'all' }
    expect(dataFeedCardScope({ acct: 'all', feedReport: own, riskFull: null }).feedReport).toBe(own)
  })
  it('an error body, a page error or a numeric id are handled without guessing', () => {
    expect(dataFeedCardScope({ acct: 'A', feedReport: { ...feedA, error: 'timeout' } }).feedReport).toBeNull()
    expect(dataFeedCardScope({ acct: 'A', riskFull: riskA, error: 'agent down' }).equityStopArmed).toBeNull()
    // accounts.account_id is TEXT; a numeric id in a body still matches its string.
    expect(dataFeedCardScope({ acct: '46130058', feedReport: { ...feedA, accountId: 46130058 } }).feedReport).not.toBeNull()
    expect(dataFeedCardScope({ acct: 'A', riskFull: { ...riskA, risk: { ...riskA.risk, effective: { equityStopPct: null } } } }).equityStopArmed).toBe(false)
  })
})

// WEB-9b: the chips are receipts from GET /state/data-feed `barReceipts`.
const SINCE = Date.parse('2026-09-25T10:00:00Z')
const src = (o) => ({ source: 'strategy_scan', receivedAtMs: NOW - 42_000, newestBarOpenMs: Date.parse('2026-09-25T11:00:00Z'), newestBarForming: true, bars: 150, accountId: '46130058', host: 'demo.ctraderapi.com', ...o })
const RECEIPTS = {
  sinceMs: SINCE,
  timeframes: [
    { timeframe: '5m', periodMs: 300_000, lastReceivedAtMs: NOW - 20_000, sources: [src({ receivedAtMs: NOW - 20_000, newestBarOpenMs: NOW - 60_000 })] },
    { timeframe: '1h', periodMs: 3_600_000, lastReceivedAtMs: NOW - 42_000, sources: [src(), src({ source: 'other', receivedAtMs: NOW - 900_000 })] },
    { timeframe: '1d', periodMs: 86_400_000, lastReceivedAtMs: NOW - 7_200_000, fromPreviousProcess: true,
      sources: [src({ source: 'daily_bar', receivedAtMs: NOW - 7_200_000, newestBarOpenMs: Date.parse('2026-09-23T21:00:00Z'), newestBarForming: false, bars: 2, fromPreviousProcess: true })] },
    { timeframe: '4h', periodMs: 14_400_000, lastReceivedAtMs: null, emptyResponses: 3, lastEmptyAtMs: NOW - 60_000, sources: [] },
  ],
}

describe('timeframeChips (WEB-9b)', () => {
  it("shows each timeframe's last receipt age, shortest first, including timeframes beyond the named five", () => {
    const chips = timeframeChips(RECEIPTS, NOW)
    expect(chips.map(c => c.text)).toEqual(['1m · none', '5m · 20 s', '15m · none', '1h · 42 s', '4h · none', '1D · 2 h (before restart)'])
    expect(chips.find(c => c.key === '5m').received).toBe(true)
  })
  it('the title names every reader, the newest bar and whether it was still forming', () => {
    const h1 = timeframeChips(RECEIPTS, NOW).find(c => c.key === '1h')
    expect(h1.title).toContain('strategy scan: received 2026-09-25 11:59 UTC via account 46130058 · newest bar opened 2026-09-25 11:00 UTC, still forming at receipt · 150 bars')
    expect(h1.title).toContain('other reader (unnamed caller): received 2026-09-25 11:45 UTC')
    const d1 = timeframeChips(RECEIPTS, NOW).find(c => c.key === '1d')
    expect(d1.title).toContain("open positions' daily bar: received 2026-09-25 10:00 UTC via account 46130058 · newest bar opened 2026-09-23 21:00 UTC, already closed at receipt · 2 bars · received before the last restart")
  })
  it('a timeframe with no bar says so, and counts empty answers instead of calling them receipts', () => {
    const chips = timeframeChips(RECEIPTS, NOW)
    expect(chips.find(c => c.key === '1m').title).toBe('no 1m bar received since the agent started, 2026-09-25 10:00 UTC')
    expect(chips.find(c => c.key === '4h').title).toBe('no 4h bar received since the agent started, 2026-09-25 10:00 UTC · 3 empty answers (no bars), last 2026-09-25 11:59 UTC')
  })
  it('without receipts the chips name the timeframe and claim no time', () => {
    for (const r of [undefined, null, {}]) {
      const chips = timeframeChips(r, NOW)
      expect(chips.map(c => c.text)).toEqual(['1m', '15m', '1h', '4h', '1D'])
      expect(chips.every(c => !c.received && c.title === 'receipt time unavailable')).toBe(true)
    }
  })
  it('the note under the chips says what a chip is, or why there are none', () => {
    expect(barReceiptsNote(null)).toBe('bar receipt times unavailable — the data-feed report did not load')
    expect(barReceiptsNote({ accountId: 'all' })).toBe('bar receipt times not reported by this agent')
    expect(barReceiptsNote({ barReceipts: RECEIPTS })).toMatch(/^Each chip is how long ago the agent last received that timeframe's bars from the broker \(agent clock;.*3 timeframes received · recording since 2026-09-25 10:00 UTC\.$/)
  })
  it('formatAge', () => {
    expect([formatAge(4_400), formatAge(125_000), formatAge(5_400_000), formatAge(3 * 86_400_000), formatAge(-1)]).toEqual(['4 s', '2 min', '1.5 h', '3 d', 'age unknown'])
    expect([formatAge(null), formatAge(undefined), formatAge('')]).toEqual(['age unknown', 'age unknown', 'age unknown'])
  })
  it('with no clock the chip uses the age the agent computed, never a made-up "0 s"', () => {
    const rows = { ...RECEIPTS, timeframes: [{ ...RECEIPTS.timeframes[1], ageMs: 42_000 }, { ...RECEIPTS.timeframes[0], ageMs: null }] }
    const chips = timeframeChips(rows, null)
    expect(chips.find(c => c.key === '1h').text).toBe('1h · 42 s')
    expect(chips.find(c => c.key === '5m').text).toBe('5m · age unknown')
    const noSince = timeframeChips({ sinceMs: null, timeframes: [] }, NOW)
    expect(noSince[0].title).toBe('no 1m bar received since the agent started, time unavailable')
  })
  it("a browser clock behind the agent's never shrinks a receipt below the age the agent computed", () => {
    // The agent said 42 s old at the report; a browser 5 min behind would compute a negative age.
    const rows = { ...RECEIPTS, timeframes: [{ ...RECEIPTS.timeframes[1], ageMs: 42_000 }] }
    expect(timeframeChips(rows, NOW - 300_000).find(c => c.key === '1h').text).toBe('1h · 42 s')
    // A browser clock ahead of the report still ages the chip (the report is up to a refresh old).
    expect(timeframeChips(rows, NOW + 60_000).find(c => c.key === '1h').text).toBe('1h · 2 min')
  })
})

describe('feedLatencyLine (WEB-9b)', () => {
  const FL = {
    status: 'measured', windowMs: 600_000, rangeMs: 60_000,
    byHost: [
      { host: 'demo.ctraderapi.com', events: 212, p50Ms: 38, p90Ms: 120, maxMs: 910, minMs: -4, outOfRange: 2, unstamped: 0 },
      { host: 'live.ctraderapi.com', events: 0, p50Ms: null, p90Ms: null, maxMs: null, minMs: null, outOfRange: 0, unstamped: 0, snapshotsSkipped: 4 },
    ],
  }
  it('prints per host, with what was not counted and the clock-offset caveat', () => {
    // The live host was open but gave only its snapshots: named, not dropped.
    expect(feedLatencyLine(FL)).toBe('market-feed latency, broker spot timestamp → agent receipt, last 10 min: demo.ctraderapi.com p50 38 ms · p90 120 ms · max 910 ms over 212 events (2 beyond ±60 s not counted); live.ctraderapi.com stream open, 0 latency samples: 4 snapshots, 0 without a broker stamp, 0 beyond ±60 s · includes any broker/agent clock offset')
  })
  it('a stream that was open but gave no usable sample says what it gave, never "no stream was open"', () => {
    // 1 snapshot + 30 events all 90 s off the broker stamp (a clock offset beyond the range).
    const allOff = { status: 'not_measured_recently', windowMs: 600_000, rangeMs: 60_000,
      byHost: [{ host: 'live.ctraderapi.com', events: 0, p50Ms: null, p90Ms: null, maxMs: null, minMs: null, snapshotsSkipped: 1, unstamped: 0, outOfRange: 30 }] }
    const line = feedLatencyLine(allOff)
    expect(line).toBe('market-feed latency not measured in the last 10 min — live.ctraderapi.com stream open, 0 latency samples: 1 snapshot, 0 without a broker stamp, 30 beyond ±60 s')
    expect(line).not.toContain('no timestamped price stream was open')
    const unstamped = { ...allOff, byHost: [{ ...allOff.byHost[0], snapshotsSkipped: 2, unstamped: 7, outOfRange: 0 }] }
    expect(feedLatencyLine(unstamped)).toContain('live.ctraderapi.com stream open, 0 latency samples: 2 snapshots, 7 without a broker stamp, 0 beyond ±60 s')
  })
  it('a host whose ring dropped events inside the window prints the span it really covers', () => {
    const busy = { status: 'measured', windowMs: 600_000, rangeMs: 60_000,
      byHost: [{ host: 'demo.ctraderapi.com', events: 4000, p50Ms: 40, p90Ms: 90, maxMs: 300, outOfRange: 0, unstamped: 0, truncated: true, coversMs: 200_000 }] }
    expect(feedLatencyLine(busy)).toBe('market-feed latency, broker spot timestamp → agent receipt, last 10 min: demo.ctraderapi.com p50 40 ms · p90 90 ms · max 300 ms over 4000 events in the last 3 min only (older events in the 10 min window were not kept) · includes any broker/agent clock offset')
    // Not truncated: no span clause, the window stands.
    expect(feedLatencyLine({ ...busy, byHost: [{ ...busy.byHost[0], truncated: false, coversMs: 600_000 }] })).not.toContain('only (older events')
  })
  it('says not measured — and when it last was — instead of a dash or a zero', () => {
    const idle = { status: 'not_measured_recently', windowMs: 600_000, byHost: [], lastMeasured: { atMs: NOW - 3_600_000, byHost: [{ host: 'demo.ctraderapi.com', events: 90, p50Ms: 41 }] } }
    expect(feedLatencyLine(idle)).toBe('market-feed latency not measured in the last 10 min — no timestamped price stream was open · last measured 2026-09-25 11:00 UTC: demo.ctraderapi.com p50 41 ms over 90 events')
    expect(feedLatencyLine({ status: 'not_measured_recently', windowMs: 600_000, byHost: [] })).toBe('market-feed latency not measured in the last 10 min — no timestamped price stream was open')
    expect(feedLatencyLine(undefined)).toBe('market-feed latency unavailable — the data-feed report did not load')
    expect(feedLatencyLine(null)).toBe('market-feed latency not reported by this agent')
  })
})

describe('quoteReceiptNote (WEB-9b, row 10)', () => {
  it("is the AGENT's receipt, with the broker's own time beside it when stamped", () => {
    expect(quoteReceiptNote({ receivedAtMs: Date.parse('2026-09-25T12:04:24.500Z'), brokerAtMs: Date.parse('2026-09-25T12:04:24.310Z') }))
      .toBe('Agent receipt 12:04:24 UTC · broker time 12:04:24 UTC')
    expect(quoteReceiptNote({ receivedAtMs: NOW, brokerAtMs: null })).toBe('Agent receipt 12:00:00 UTC · broker time not stamped')
    expect(quoteReceiptNote(null)).toBe('No quote received')
    expect(quoteReceiptNote({ receivedAtMs: NOW })).not.toMatch(/Broker receipt/)
  })
})
