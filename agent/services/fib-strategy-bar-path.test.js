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
import { barPathView, recordBarFetch, recordScanPass, _resetBarPathCountersForTests } from '../lib/bar-path-counters.js'
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
