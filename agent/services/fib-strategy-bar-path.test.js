// node --test agent/services/fib-strategy-bar-path.test.js
//
// S-3 (26-09-2026, integrated plan row 1.6): the bar path's three cache
// defects and the Phase 0 counters. Each test drives scanSymbolFib /
// getRegimeBars through a stub broker (the module's fetcher seam), so what is
// checked is the bars a strategy is actually handed, not the source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {
  scanSymbolFib, getRegimeBars, _setTrendbarFetcherForTests, _resetBarCacheForTests,
  closedBarsOf, cacheExpiryFor, barCloseAt,
} from './fib-strategy.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { barPathView, recordBarFetch, recordScanPass, isHistoryLimited, HISTORY_EDGE_MS, WINDOW_PAD_BARS, _resetBarPathCountersForTests } from '../lib/bar-path-counters.js'
import { trendbarWindowStartMs, trendbarFetchPlan } from '../lib/ctrader-ws.js'
import { noteTokenWait } from '../lib/ctrader-session.js'
import { impossibleDepthCells } from './armed-cell-reachability.js'
import { strategyLiveness } from './strategy-liveness.js'
import { initDB, getState, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { acctMatrixKey } from './stage-matrix.js'

const H = 3_600_000
const CREDS = { host: 'demo.example.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '46130058' }

/** `n` 1h-style bars of period `ms`, the newest opening at `lastOpen`. */
function bars(n, ms, lastOpen) {
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const t = lastOpen - i * ms
    const c = 100 + Math.sin(t / ms) * 2
    out.push({ t, o: c, h: c + 1, l: c - 1, c, v: 10 })
  }
  return out
}

/** A stub broker: `count` bars per period, the newest one FORMING now. Records every call. */
function stubBroker({ short = {} } = {}) {
  const calls = []
  const fn = async (_h, _c, _s, _t, _a, symbolId, periods, count, _to, _end, opts) => {
    calls.push({ symbolId, periods: [...periods], count, purpose: opts?.purpose })
    const now = Date.now()
    const out = {}
    for (const p of periods) {
      const ms = p === '1mo' ? 30 * 86_400_000 : ({ '1w': 7 * 86_400_000, '1d': 86_400_000, '4h': 4 * H, '1h': H, '30m': H / 2, '15m': H / 4, '5m': H / 12 })[p]
      const n = short[p] != null ? Math.min(count, short[p]) : count
      out[p] = bars(n, ms, Math.floor(now / ms) * ms) // last bar opened in the current period: forming
    }
    return out
  }
  return { fn, calls }
}

/** A strategy stand-in with its own guard, recording the length it is handed per timeframe. */
function spyStrategy(key, minBars) {
  const seen = []
  const compute = (b, tf) => { seen.push({ tf, n: b.length, lastT: b.at(-1)?.t }); return null }
  compute.minBars = minBars
  return { entry: { key, compute, minBars }, seen }
}

function fresh(t) {
  _resetBarCacheForTests()
  _resetBarPathCountersForTests()
  t.after(() => { _setTrendbarFetcherForTests(null); _resetBarCacheForTests(); _resetBarPathCountersForTests() })
}

test('S-3: a 30-bar regime write forces a deeper fetch — the scan does not accept a shallower entry', async (t) => {
  fresh(t)
  const broker = stubBroker()
  _setTrendbarFetcherForTests(broker.fn)
  // The regime read caches 30 bars of 1h under the scan's key.
  const reg = await getRegimeBars(CREDS, 7, { preferredTfs: ['4h'], fallbackTf: '1h', count: 30 })
  assert.equal(reg.bars.length, 30)
  const spy = spyStrategy('ema_pullback', 450)
  await scanSymbolFib(CREDS, 'EURUSD', 7, { strategies: [spy.entry] })
  const scanCall = broker.calls.find(c => c.purpose === 'strategy_scan')
  assert.ok(scanCall, 'the scan fetched')
  assert.ok(scanCall.periods.includes('1h'), 'the 30-bar 1h entry was NOT accepted as current for a 450-bar need')
  assert.equal(scanCall.count, 451, 'the need plus one')
  const oneH = spy.seen.find(s => s.tf === '1h')
  assert.equal(oneH.n, 450, 'the strategy got its full window on 1h')
  assert.equal(barPathView().fetches.shallowRefetches, 1, 'the refetch is counted')
})

test('S-3: a count − 1 answer (the forming bar dropped) still runs ema_pullback — the fetch asks minBars + 1', async (t) => {
  fresh(t)
  const broker = stubBroker()
  _setTrendbarFetcherForTests(broker.fn)
  // The real ema_pullback, wrapped to see what it is handed.
  const real = STRATEGY_REGISTRY.find(s => s.key === 'ema_pullback')
  const seen = []
  const compute = (b, tf, o) => { seen.push({ tf, n: b.length }); return real.compute(b, tf, o) }
  compute.minBars = real.minBars
  assert.equal(real.minBars, 450)
  await scanSymbolFib(CREDS, 'EURUSD', 8, { strategies: [{ key: 'ema_pullback', compute, minBars: 450 }] })
  const call = broker.calls[0]
  assert.equal(call.count, 451)
  const oneH = seen.find(s => s.tf === '1h')
  assert.equal(oneH.n, 450, 'every closed bar the guard needs: the broker answered `count` bars with the last one forming')
  assert.equal(barPathView().starved.rows.filter(r => r.strategy === 'ema_pullback' && r.timeframe === '1h').length, 0, 'not starved on 1h')
})

test('S-3: a mid-bar fetch is never read as closed — not later in the bar, not after its close', async (t) => {
  fresh(t)
  const T0 = Date.UTC(2026, 8, 25, 10, 20, 0) // 10:20 — mid 1h bar (10:00–11:00)
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
  const broker = stubBroker()
  _setTrendbarFetcherForTests(broker.fn)
  const spy = spyStrategy('donchian_breakout', 40)
  await scanSymbolFib(CREDS, 'EURUSD', 9, { strategies: [spy.entry] })
  const formingOpen = Date.UTC(2026, 8, 25, 10, 0, 0)
  const first = spy.seen.find(s => s.tf === '1h')
  assert.ok(first.lastT < formingOpen, 'the 10:00 bar, forming at the fetch, is not handed over')

  // 10:59 — still inside the bar, the cache is current and still excludes it.
  t.mock.timers.setTime(Date.UTC(2026, 8, 25, 10, 59, 0))
  spy.seen.length = 0
  await scanSymbolFib(CREDS, 'EURUSD', 9, { strategies: [spy.entry] })
  assert.equal(broker.calls.filter(c => c.periods.includes('1h')).length, 1, 'no refetch inside the bar')
  assert.ok(spy.seen.find(s => s.tf === '1h').lastT < formingOpen)

  // 11:05 — the bar has closed. The OLD cache (fetch time + 1h = 11:20) would
  // still be current and would hand over the 10:20 partial bar as closed.
  t.mock.timers.setTime(Date.UTC(2026, 8, 25, 11, 5, 0))
  spy.seen.length = 0
  await scanSymbolFib(CREDS, 'EURUSD', 9, { strategies: [spy.entry] })
  assert.equal(broker.calls.filter(c => c.periods.includes('1h')).length, 2, 'the entry expired at the bar close and was refetched')
  const after = spy.seen.find(s => s.tf === '1h')
  assert.equal(after.lastT, formingOpen, 'the 10:00 bar is handed over only once it was fetched closed')
})

test('S-3 helpers: closedBarsOf judges at the fetch; expiry is the forming bar\'s close; months are calendar months', () => {
  const b = bars(5, H, Date.UTC(2026, 8, 25, 10))
  const fetchedAt = Date.UTC(2026, 8, 25, 10, 20)
  assert.equal(closedBarsOf(b, '1h', fetchedAt).length, 4, 'forming at fetch → dropped')
  assert.equal(closedBarsOf(b, '1h', Date.UTC(2026, 8, 25, 11, 0, 1)).length, 5, 'fetched after its close → kept')
  assert.equal(cacheExpiryFor(b, '1h', fetchedAt), Date.UTC(2026, 8, 25, 11), 'expires at the bar close, not fetch + 1h')
  assert.equal(cacheExpiryFor(bars(5, H, Date.UTC(2026, 8, 25, 9)), '1h', fetchedAt), fetchedAt + H, 'no forming bar → one period')
  assert.equal(barCloseAt(Date.UTC(2026, 0, 1), '1mo'), Date.UTC(2026, 1, 1), 'January closes on 1 February, not after 30 days')
  // A broker whose month starts at 21:00 UTC the day before (UTC+3).
  assert.equal(barCloseAt(Date.UTC(2026, 6, 31, 21), '1mo'), Date.UTC(2026, 7, 31, 21))
})

test('S-3 mirrors: every bar handed to a strategy (the scanner job\'s bars) was closed at its receipt, and a 40-bar strategy still sees 150', async (t) => {
  fresh(t)
  const T0 = Date.UTC(2026, 8, 25, 10, 20, 0)
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
  _setTrendbarFetcherForTests(stubBroker().fn)
  const jobs = []
  const spy = spyStrategy('fib_confluence', 40)
  await scanSymbolFib(CREDS, 'EURUSD', 11, { strategies: [spy.entry], onEvaluation: (job) => jobs.push(job) })
  t.mock.timers.setTime(Date.UTC(2026, 8, 25, 11, 5, 0))
  await scanSymbolFib(CREDS, 'EURUSD', 11, { strategies: [spy.entry], onEvaluation: (job) => jobs.push(job) })
  const oneH = jobs.filter(j => j.timeframe === '1h')
  assert.equal(oneH.length, 2)
  for (const j of oneH) {
    assert.equal(j.bars.length, 150, 'the window a mirrored strategy sees is unchanged')
    // scanner-feed.js barInputRefusal: `b.t + duration > job.receivedAtMs` is
    // refused as last_bar_partial / bar_not_closed.
    for (const b of j.bars) assert.ok(b.t + H <= j.receivedAtMs, 'closed at receipt — no partial bar reaches the mirror')
  }
})

test('S-3 Phase 0: the counters increment — token wait by purpose, deadline hits, fetches, starved, short history', async (t) => {
  fresh(t)
  const v0 = barPathView()
  assert.equal(v0.tokenWait.state, 'not_measured')
  assert.equal(v0.deadline.state, 'not_measured')
  assert.equal(v0.fetches.state, 'not_measured')

  noteTokenWait({ purpose: 'strategy_scan' }, 250)
  noteTokenWait({ purpose: 'regime' }, 0)
  recordScanPass({ deadlineHit: false })
  recordScanPass({ deadlineHit: true })
  // A broker holding only 190 monthly bars (BTCUSD 1mo).
  _setTrendbarFetcherForTests(stubBroker({ short: { '1mo': 190 } }).fn)
  const spy = spyStrategy('ema_pullback', 450)
  await scanSymbolFib(CREDS, 'BTCUSD', 12, { strategies: [spy.entry] })

  const v = barPathView()
  assert.equal(v.tokenWait.requests, 2)
  assert.equal(v.tokenWait.waitedRequests, 1)
  assert.equal(v.tokenWait.byPurpose.strategy_scan.totalMs, 250)
  assert.deepEqual([v.deadline.scanPasses, v.deadline.deadlineHits, v.deadline.share], [2, 1, 0.5])
  assert.equal(v.fetches.byPurpose.strategy_scan.requests, 8, 'one per timeframe of the ladder')
  const starved = v.starved.rows.find(r => r.strategy === 'ema_pullback' && r.timeframe === '1mo')
  assert.ok(starved && starved.need === 450 && starved.lastHave === 189, 'starved on 1mo: 190 bars, the forming one dropped')
  assert.deepEqual(v.shortHistory.rows.map(r => [r.symbol, r.timeframe, r.got]), [['BTCUSD', '1mo', 190]])

  // …and the impossible cells follow from the observed history.
  const cells = impossibleDepthCells(v.shortHistory.rows, STRATEGY_REGISTRY)
  assert.deepEqual(cells.map(c => c.strategy).sort(), ['cup_handle', 'ema_pullback', 'inv_cup_handle'])
  assert.ok(cells.every(c => c.symbol === 'BTCUSD' && c.timeframe === '1mo' && c.history === 190))
  // A later full answer clears it — never a stale "impossible".
  recordBarFetch({ purpose: 'strategy_scan', symbol: 'BTCUSD', timeframe: '1mo', asked: 451, got: 451 })
  assert.equal(barPathView().shortHistory.rows.length, 0)
})

test('S-3: /state/data-feed carries the Phase 0 block, "not_measured" until a sample exists', async (t) => {
  fresh(t)
  const db = initDB(':memory:')
  const app = express()
  app.use('/state', stateRouter(db))
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  try {
    const j = await fetch(`http://127.0.0.1:${srv.address().port}/state/data-feed`).then(r => r.json())
    assert.equal(j.barPath.tokenWait.state, 'not_measured')
    assert.equal(j.barPath.thresholds.tokenWaitP95Ms, 5000)
    recordScanPass({ deadlineHit: true })
    // A different URL: the state router caches a GET answer for a few seconds.
    const j2 = await fetch(`http://127.0.0.1:${srv.address().port}/state/data-feed?limit=5`).then(r => r.json())
    assert.equal(j2.barPath.deadline.deadlineHits, 1)
  } finally { srv.close() }
})

test('S-3 liveness: tsmom_long is read from the momentum ranking, not the scan — never "silent" while the ranking proposes', () => {
  const db = initDB(':memory:')
  const nowMs = Date.UTC(2026, 8, 26, 3)
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,?,?)').run('46130058', 0, 1, 'active')
  setState(db, acctMatrixKey('46130058'), JSON.stringify({ strategy: { tsmom_long: { trade: true } } }))
  // Plenty of scan activity, none of it tsmom_long (the scan never produces it).
  const ins = db.prepare('INSERT INTO scans (symbol, strategy, scanned_at) VALUES (?, ?, ?)')
  for (let i = 0; i < 60; i++) ins.run('EURUSD', 'fib_confluence', new Date(nowMs - i * 60_000).toISOString())
  const read = () => strategyLiveness(db, { accountId: '46130058', nowMs }).strategies.find(s => s.key === 'tsmom_long')

  // The ranking has not run in the window: unknown, not silent.
  assert.equal(read().verdict, 'unknown')
  // The ranking ran and proposed entries.
  const ms = db.prepare('INSERT INTO momentum_shadow (symbol, action, side, at) VALUES (?, ?, ?, ?)')
  ms.run('AAPL.US', 'enter', 'long', new Date(nowMs - 86_400_000).toISOString())
  ms.run('MSFT.US', 'refused', 'long', new Date(nowMs - 86_400_000).toISOString())
  const r = read()
  assert.equal(r.signals, 1)
  assert.equal(r.signalSource, 'momentum_shadow')
  assert.notEqual(r.verdict, 'silent')
  // A scan-produced strategy keeps reading the scan.
  const fib = strategyLiveness(db, { accountId: '46130058', nowMs }).strategies.find(s => s.key === 'fib_confluence')
  assert.equal(fib.signalSource, 'scans')
  void getState
})

// --- S-3 fix round: "fewer bars than asked" is not "short history" ---------
//
// The request is bounded by a TIME window (ctrader-ws.js
// trendbarWindowStartMs) as well as a count, so a symbol that closes at
// weekends answers short with years of history behind it. This broker honours
// the window exactly as cTrader does: it returns every bar whose open lies in
// [fromTs, now], skipping closed hours, and none before `historyFrom[period]`.
const PERIOD_MS = { '1mo': 30 * 86_400_000, '1w': 7 * 86_400_000, '1d': 86_400_000, '4h': 4 * H, '1h': H, '30m': H / 2, '15m': H / 4, '5m': H / 12 }
/** FX: shut from Friday 21:00 UTC to Sunday 21:00 UTC. */
const fxClosed = (t) => {
  const d = new Date(t)
  const day = d.getUTCDay(), hr = d.getUTCHours()
  return day === 6 || (day === 0 && hr < 21) || (day === 5 && hr >= 21)
}
function windowedBroker({ closed = () => false, historyFrom = {} } = {}) {
  const fn = async (_h, _c, _s, _t, _a, _id, periods, count) => {
    const now = Date.now()
    const out = {}
    for (const p of periods) {
      const ms = PERIOD_MS[p]
      const fromTs = trendbarWindowStartMs(p, count, now)
      const got = []
      for (let t = Math.floor(now / ms) * ms; t >= fromTs; t -= ms) {
        if (historyFrom[p] != null && t < historyFrom[p]) break
        if (ms < 86_400_000 && closed(t)) continue
        const c = 100 + Math.sin(t / ms) * 2
        got.unshift({ t, o: c, h: c + 1, l: c - 1, c, v: 10 })
      }
      out[p] = got.slice(-count)
    }
    return out
  }
  return { fn }
}

test('S-3 fix: a weekend-gapped FX 1h answer is window-limited, NOT an impossible cell — EURUSD has years of 1h history', async (t) => {
  fresh(t)
  _setTrendbarFetcherForTests(windowedBroker({ closed: fxClosed }).fn)
  const spy = spyStrategy('ema_pullback', 450)
  await scanSymbolFib(CREDS, 'EURUSD', 7, { strategies: [spy.entry] })
  const v = barPathView()
  const h1 = spy.seen.find(s => s.tf === '1h')
  assert.ok(h1 && h1.n < 450, `the 19-day 1h window spans weekends, so fewer than 450 closed bars came back (got ${h1?.n})`)
  assert.ok(v.fetches.byPurpose.strategy_scan.short >= 1, 'the short answer is still counted as short')
  assert.ok(v.fetches.windowLimited >= 1, '…and as window-limited')
  assert.equal(v.fetches.byPurpose.strategy_scan.historyLimited, 0)
  assert.deepEqual(v.shortHistory.rows, [], 'no symbol × timeframe is reported as the broker\'s whole history')
  assert.deepEqual(impossibleDepthCells(v.shortHistory.rows, STRATEGY_REGISTRY), [], 'no cell is marked impossible')
})

test('S-3 fix: BTCUSD 1w answering one bar short of asked (the real production shape) is window-limited, NOT an impossible cell', async (t) => {
  fresh(t)
  // stubBroker's bars are contiguous up to "now" — a 24/7 symbol with no
  // closures, exactly like BTCUSD. `short: { '1w': 450 }` reproduces the
  // measured production read (asked 451, got 450): the broker simply has no
  // bar past the one it returned, a COUNT limit, not a history limit — the
  // window's own WINDOW_PAD_BARS pad is what puts the first returned bar
  // several weeks after the window's left edge, not the symbol running out
  // of history.
  const broker = stubBroker({ short: { '1w': 450 } })
  _setTrendbarFetcherForTests(broker.fn)
  const spy = spyStrategy('ema_pullback', 450)
  await scanSymbolFib(CREDS, 'BTCUSD', 12, { strategies: [spy.entry] })
  const v = barPathView()
  const w1 = spy.seen.find(s => s.tf === '1w')
  assert.equal(w1.n, 449, 'ema_pullback got one fewer than its 450-bar need on 1w')
  assert.equal(v.fetches.byPurpose.strategy_scan.historyLimited, 0, 'not the broker\'s whole history')
  assert.ok(v.fetches.windowLimited >= 1, 'counted as window-limited instead')
  assert.deepEqual(v.shortHistory.rows.filter(r => r.timeframe === '1w'), [], 'BTCUSD 1w is not reported as short history')
  assert.deepEqual(impossibleDepthCells(v.shortHistory.rows, STRATEGY_REGISTRY).filter(c => c.timeframe === '1w'), [], 'no impossible cell on 1w')
})

test('S-3 fix: BTCUSD 1mo whose first bar is far past the window start IS history-limited, and a later window-limited answer clears it', async (t) => {
  fresh(t)
  const M = PERIOD_MS['1mo']
  _setTrendbarFetcherForTests(windowedBroker({ historyFrom: { '1mo': Math.floor(Date.now() / M) * M - 189 * M } }).fn)
  const spy = spyStrategy('ema_pullback', 450)
  await scanSymbolFib(CREDS, 'BTCUSD', 12, { strategies: [spy.entry] })
  const v = barPathView()
  assert.deepEqual(v.shortHistory.rows.map(r => [r.symbol, r.timeframe, r.got]), [['BTCUSD', '1mo', 190]])
  assert.ok(v.shortHistory.rows[0].firstBarAt > v.shortHistory.rows[0].windowFrom, 'the row carries the evidence: its first bar and the window edge')
  assert.equal(v.fetches.byPurpose.strategy_scan.historyLimited, 1)
  const cells = impossibleDepthCells(v.shortHistory.rows, STRATEGY_REGISTRY)
  assert.deepEqual(cells.map(c => c.strategy).sort(), ['cup_handle', 'ema_pullback', 'inv_cup_handle'])
  // The same symbol × timeframe answering short only because of its window
  // supersedes the row — never a stale "impossible".
  const now = Date.now()
  recordBarFetch({ purpose: 'strategy_scan', symbol: 'BTCUSD', timeframe: '1mo', asked: 451, got: 440, firstBarT: now - 455 * M, fromTs: now - 456 * M, periodMs: M })
  assert.equal(barPathView().shortHistory.rows.length, 0)
})

test('S-3 fix: isHistoryLimited — the margin outlasts any closure and two periods; missing evidence is never history', () => {
  const D = 86_400_000
  const from = Date.UTC(2026, 8, 1)
  assert.equal(isHistoryLimited({ firstBarT: from + 3 * D, fromTs: from, periodMs: H }), false, 'a long weekend')
  assert.equal(isHistoryLimited({ firstBarT: from + 8 * D, fromTs: from, periodMs: H }), true, 'past the 7-day edge')
  assert.equal(isHistoryLimited({ firstBarT: from + 13 * D, fromTs: from, periodMs: 7 * D }), false, 'a weekly bar opens up to a week after an arbitrary edge')
  assert.equal(isHistoryLimited({ firstBarT: from + 55 * D, fromTs: from, periodMs: 30 * D }), false, 'a synthesised/monthly first bar within two periods')
  assert.equal(isHistoryLimited({ firstBarT: from + 30 * D, fromTs: null, periodMs: H }), false, 'no window edge: not measured, not history')
  assert.equal(isHistoryLimited({ firstBarT: null, fromTs: from, periodMs: H }), false, 'no bar: not history')
  assert.equal(HISTORY_EDGE_MS, 7 * D)
  assert.equal(WINDOW_PAD_BARS, 5)
})

// The margin must also clear the window's OWN pad (WINDOW_PAD_BARS periods
// beyond fetchCount, ctrader-ws.js planWindowStartMs) or a plain
// count-limited answer — the broker has no bars past what it just returned,
// nothing closed early — misreads as history on any period long enough for
// 5 periods to exceed HISTORY_EDGE_MS / two periods (weekly, monthly).
test('S-3 fix: isHistoryLimited clears the window\'s own 5-period pad — production BTCUSD cases, a young weekly series, and a daily weekend gap', () => {
  const D = 86_400_000

  // Measured 26-09-2026, GET /state/data-feed barPath.shortHistory: BTCUSD 1w
  // asked 451 got 450 — a COUNT-limited answer one bar short of asked. Its
  // first bar sits inside the window's own pad (the pad places the first bar;
  // it does not remove one), not the broker running out of history. Before this
  // fix the margin (14 days for a weekly period) did not clear the ~35-day
  // pad the window itself adds, so this read as history-limited.
  assert.equal(
    isHistoryLimited({ firstBarT: Date.UTC(2018, 1, 4, 22), fromTs: Date.UTC(2017, 11, 30), periodMs: 7 * D }),
    false,
    'BTCUSD 1w: a 36-day gap is ~5 padded weeks, not the broker\'s whole history — windowLimited, not historyLimited',
  )

  // Same measurement, BTCUSD 1mo: asked 451 got 190, decades of gap — the
  // true history-limited case that must stay marked after the fix.
  assert.equal(
    isHistoryLimited({ firstBarT: Date.UTC(2010, 5, 30, 21), fromTs: Date.UTC(1989, 3, 13), periodMs: 30 * D }),
    true,
    'BTCUSD 1mo: decades past the window edge — still the broker\'s whole history',
  )

  // A genuinely young weekly series: 100 of 451 bars, first bar ~351 weeks
  // (well past any window pad) after the window opened.
  const wFrom = Date.UTC(2020, 0, 1)
  assert.equal(
    isHistoryLimited({ firstBarT: wFrom + 351 * 7 * D, fromTs: wFrom, periodMs: 7 * D }),
    true,
    'a young symbol whose weekly history really is 100 bars deep',
  )

  // A daily weekend-closing symbol (EURUSD-shaped: fewer bars than asked
  // because the window spans weekends, years of history behind it) — the
  // gap a closure leaves is small next to the 12-day daily margin.
  const dFrom = Date.UTC(2026, 0, 1)
  assert.equal(
    isHistoryLimited({ firstBarT: dFrom + 4 * D, fromTs: dFrom, periodMs: D }),
    false,
    'a 4-day weekend/holiday gap on a daily period is window-limited, not history',
  )
})

test('S-3 fix: trendbarWindowStartMs is the request\'s own fromTimestamp — native, synthesised (base capped at 3,000), unknown', () => {
  const now = Date.UTC(2026, 8, 26, 3)
  assert.equal(trendbarWindowStartMs('1h', 451, now), now - H * 456)
  assert.equal(trendbarWindowStartMs('1mo', 451, now), now - 2_592_000_000 * 456)
  // 6h = 6 × 1h; 1,000 × 6 = 6,000 base bars, capped to 3,000.
  assert.equal(trendbarWindowStartMs('6h', 1000, now), now - H * 3005)
  assert.equal(trendbarWindowStartMs('nonsense', 10, now), null)
  assert.deepEqual(trendbarFetchPlan('6h', 1000), { period: '6h', base: '1h', code: 9, ms: H, fetchCount: 3000, factor: 6 })
})
