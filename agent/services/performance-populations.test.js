import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { buildPerformancePopulations, readPerformancePopulations, buildDecisionsDaily, buildLatestPrices, readDecisionsDaily, readLatestPrices, readStageMatrixStats, readDecisionAudit } from './performance-populations.js'
import { stageMatrixStats } from './stage-matrix.js'
import { getState } from '../db.js'
import { reportStats, reportLedger, sessionBuckets } from '../shared/performance-populations.js'
import { accountAnalytics } from './account-analytics.js'
import { auditDecisions } from './decision-audit.js'
const NOW = Date.UTC(2026, 8, 22, 12)
function setup(t, file = ':memory:') {
  const db = initDB(file); t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO trades(symbol,side,status,account_id,net_pnl,closed_at,closed_at_ms,
    entry_price,sl_price,tp_price,strategy,close_reason) VALUES(?, 'BUY','closed',?,?,NULL,?,100,99,102,'ema_cross','TP hit')`)
  return { db, add: ({ symbol = 'EURUSD', account = '11', pnl = 1, at = NOW - 1000 } = {}) => insert.run(symbol, account, pnl, at) }
}
test('full populations exceed the journal cap, retain unpriced closes and reconcile dimensions', t => {
  const { db, add } = setup(t)
  for (let i = 0; i < 251; i++) add({ pnl: 0.125 })
  add({ pnl: null }); add({ symbol: 'BTCUSD', pnl: -2.25 })
  const report = buildPerformancePopulations(db, { now: NOW })
  const total = reportStats(report, '30d', '11')
  assert.equal(total.n, 253); assert.equal(total.pricedN, 252)
  assert.equal(total.pnl, 29.125); assert.equal(total.unpricedN, 1)
  assert.equal(total.moneyState, 'partial_recorded_account_units')
  assert.equal(reportStats(report, '30d', '11', g => g.market === 'fx').pnl
    + reportStats(report, '30d', '11', g => g.market === 'crypto').pnl, total.pnl)
  assert.equal(reportStats(report, '30d', '11', g => g.strat === 'ema_cross').n, total.n)
  const ledger = reportLedger(report, '11').windows.find(w => w.key === '30d')
  assert.equal(ledger.carryIn, null); assert.equal(ledger.carryOut, null)
  assert.equal(ledger.trades, total.n); assert.equal(ledger.net, total.pnl)
})
test('unattributed records never enter a named account; different accounts retain counts without a money sum', t => {
  const { db, add } = setup(t)
  add({ pnl: 20 }); add({ account: '22', pnl: -5 }); add({ account: null, pnl: 1000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, '30d', '11').pnl, 20)
  assert.equal(reportStats(r, '30d', '22').pnl, -5)
  assert.equal(reportStats(r, '30d').n, 3)
  assert.equal(reportStats(r, '30d').pnl, null)
  assert.equal(reportStats(r, '30d').pf, null)
  assert.equal(reportStats(r, '30d').moneyState, 'unverified_cross_account_units')
  assert.equal(r.coverage.unattributedAccountN, 1)
})
test('zero, unpriced-only, malformed dates and report unavailability are distinct', t => {
  const { db, add } = setup(t)
  add({ pnl: null }); add({ at: null }); add({ at: NOW + 1 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, '30d', '11').pnl, null)
  assert.equal(reportStats(r, '30d', '11').n, 1)
  assert.equal(reportStats(r, '30d', '22').n, 0)
  assert.equal(reportStats(r, '30d', '22').pnl, 0)
  assert.equal(reportStats(null, '30d', '22').n, null)
  assert.equal(r.coverage.unknownCloseTimeN, 1); assert.equal(r.coverage.futureCloseTimeN, 1)
  assert.throws(() => buildPerformancePopulations(db, { now: NOW, maxGroups: 0 }), /group_bound/)
  assert.throws(() => buildPerformancePopulations(db, { now: NOW, deadlineMs: -1 }), /deadline/)
})
test('session statistics and winners use the whole population; rankings remain within an account', t => {
  const { db, add } = setup(t)
  for (let i = 1; i <= 150; i++) add({ pnl: i, at: NOW - 3600000 })
  add({ account: '22', pnl: 10000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(reportStats(r, 'session:EUR', '11').median, 75.5)
  assert.equal(reportStats(r, 'session:EUR', '11').n, 150)
  assert.equal(r.bestByAccount['11'].win[0].pnl, 150)
  assert.equal(r.bestByAccount['11'].lag[0].pnl, 1)
  assert.equal(r.bestByAccount['22'].win[0].pnl, 10000)
})
test('disk report runs in a coalesced read-only worker and leaves order state untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'performance-populations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db, add } = setup(t, join(dir, 'fixture.db')); add({ at: Date.now() - 1000 })
  const a = readPerformancePopulations(db), b = readPerformancePopulations(db)
  assert.equal(a, b)
  const report = await a
  assert.equal(report.status, 'complete'); assert.equal(reportStats(report, '30d', '11').n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})
test('reporting analytics expose unpriced coverage and isolate currencies without changing gate defaults', t => {
  const { db, add } = setup(t)
  add({ pnl: 10 }); add({ pnl: null }); add({ account: '22', pnl: -5 }); add({ account: null, pnl: 100 })
  const a = accountAnalytics(db, { now: NOW, accountId: '11', unstamped: 'exclude', reporting: true })
  assert.equal(a.net, 10); assert.equal(a.closedTrades, 2); assert.equal(a.unpricedTrades, 1)
  const all = accountAnalytics(db, { now: NOW, reporting: true })
  assert.equal(all.net, null); assert.equal(all.profitFactor, null); assert.equal(all.profitFactorInfinite, false)
  // Legacy callers have an unchanged policy until their own risk decision.
  assert.equal(accountAnalytics(db, { now: NOW }).net, 105)
})


test('decisions, prices and stage statistics preserve exact output in read-only workers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'state-report-isolation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db } = setup(t, join(dir, 'fixture.db'))
  const at = new Date().toISOString()
  const risk = db.prepare(`INSERT INTO risk_events
    (symbol,side,approved,proposal_json,account_id,created_at,repeat_count)
    VALUES(?,'BUY',?,'{}',?,?,?)`)
  risk.run('EURUSD', 1, '11', at, 1)
  risk.run('EURUSD', 0, '22', at, 3)
  risk.run('EURUSD', 0, null, at, 2)
  const scan = db.prepare(`INSERT INTO scans
    (symbol,bias,confidence,timeframe,price,scanned_at) VALUES(?,?,?,?,?,?)`)
  scan.run('EURUSD', 'long', 7, '1h', 1.1, at)
  scan.run('EURUSD', 'short', 8, '1h', 1.2, at)
  scan.run('GBPUSD', 'long', 6, '1h', 1.3, at)

  const directDecisions = buildDecisionsDaily(db, { days: 1, accountId: '11' })
  const directPrices = buildLatestPrices(db)
  const directStage = stageMatrixStats(db, getState)
  assert.deepEqual(await readDecisionsDaily(db, { days: 1, accountId: '11' }), directDecisions)
  assert.deepEqual(await readLatestPrices(db), directPrices)
  assert.deepEqual(await readStageMatrixStats(db), directStage)
  assert.equal(directDecisions.reduce((n, r) => n + r.approved + r.vetoed_distinct, 0), 2)
  assert.equal(directPrices.EURUSD.price, 1.2)
  assert.equal(directPrices.GBPUSD.price, 1.3)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})


test('post-decision audit preserves the synchronous verdict in a read-only worker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-audit-isolation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { db } = setup(t, join(dir, 'fixture.db'))
  const at = new Date().toISOString()
  db.prepare(`INSERT INTO decision_log(symbol,stage,decision,reason,account_id,created_at)
    VALUES('EURUSD','stage_matrix','skip','strategy','11',?)`).run(at)
  const nowMs = Date.now()
  const direct = auditDecisions(db, { marketOpen: true, now: new Date(nowMs) })
  const isolated = await readDecisionAudit(db, { marketOpen: true, nowMs })
  assert.deepEqual(isolated, direct)
  assert.equal(isolated.verdict, 'blocked')
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

// V3 WEB-6: session buckets are each exchange's regular cash hours in its own
// zone. Every close below lands in a different bucket under the old fixed UTC
// table, so these go red if the report falls back to minute-of-day ranges.
test('session buckets follow ASX onto AEDT and keep TSE lunch out (Mon 5 Oct 2026, SGT day)', t => {
  const { db, add } = setup(t)
  const now = Date.parse('2026-10-05T04:00:00Z')   // 12:00 SGT/HKT, 15:00 AEDT, 13:00 JST
  add({ pnl: 5, at: Date.parse('2026-10-04T23:30:00Z') })   // Mon 10:30 AEDT: ASX only (old table: OFF)
  add({ pnl: -2, at: Date.parse('2026-10-05T02:45:00Z') })  // 13:45 AEDT, 10:45 SGT/HKT, 11:45 JST lunch
  add({ pnl: 1, at: Date.parse('2026-10-04T18:00:00Z') })   // Sunday in London/New York, pre-open Monday in Asia: OFF
  const r = buildPerformancePopulations(db, { now, timeZone: 'Asia/Singapore' })
  const n = key => reportStats(r, `session:${key}`, '11').n
  assert.deepEqual(['SYD (ASX)', 'SG', 'HK', 'JPN', 'EUR', 'NY', 'OFF', 'ALL'].map(n), [2, 1, 1, 0, 0, 0, 1, 3])
  assert.equal(reportStats(r, 'session:SYD (ASX)', '11').pnl, 3)
  const w = key => r.windows.find(x => x.key === `session:${key}`).session
  assert.deepEqual(w('SYD (ASX)').intervals, [{ date: '2026-10-05', from: Date.parse('2026-10-04T23:00:00Z'), to: Date.parse('2026-10-05T05:00:00Z') }])
  // 04:00 UTC is 12:00 HKT, HKEX's lunch; TSE's afternoon opened at 12:30 JST.
  assert.deepEqual(['SYD (ASX)', 'SG', 'HK', 'JPN', 'EUR', 'NY'].map(k => w(k).openNow), [true, true, false, true, false, false])
  assert.deepEqual(r.sessionWindow, { from: Date.parse('2026-10-04T16:00:00Z'), to: now, weekend: false,
    source: 'exchange_cash_hours_iana_dst', exceptions: 'holidays_and_early_closes_not_applied' })
})

test('session buckets follow London and New York off summer time (Mon 2 Nov 2026, New York day)', t => {
  const { db, add } = setup(t)
  const now = Date.parse('2026-11-02T21:30:00Z')
  add({ at: Date.parse('2026-11-02T14:00:00Z') })   // 14:00 GMT, 09:00 EST: London only (old table: both)
  add({ at: Date.parse('2026-11-02T16:45:00Z') })   // 16:45 GMT, 11:45 EST: New York only
  add({ at: Date.parse('2026-11-02T20:30:00Z') })   // 15:30 EST: New York (old table: OFF)
  const r = buildPerformancePopulations(db, { now, timeZone: 'America/New_York' })
  const n = key => reportStats(r, `session:${key}`, '11').n
  assert.deepEqual(['EUR', 'NY', 'OFF', 'ALL'].map(n), [1, 2, 0, 3])
  assert.equal(r.windows.find(x => x.key === 'session:NY').session.openNow, false, '16:30 EST is after the close')
})

test('the card rows come from the report: open-now, intervals, hints, and nothing invented without them', t => {
  const { db, add } = setup(t)
  add({ pnl: 5, at: Date.parse('2026-10-04T23:30:00Z') })
  add({ account: '22', pnl: 7, at: Date.parse('2026-10-04T23:40:00Z') })
  const r = buildPerformancePopulations(db, { now: Date.parse('2026-10-05T04:00:00Z'), timeZone: 'Asia/Singapore' })
  const rows = sessionBuckets(r, '11')
  assert.equal(rows.source, 'exchange_cash_hours_iana_dst')
  assert.equal(rows.exceptions, 'holidays_and_early_closes_not_applied')
  const syd = rows.buckets.find(b => b.key === 'SYD (ASX)'), ny = rows.buckets.find(b => b.key === 'NY')
  assert.equal(syd.n, 1); assert.equal(syd.sum, 5); assert.equal(syd.open, true); assert.equal(ny.open, false)
  assert.match(syd.hint, /2026-10-05 23:00–05:00 UTC/)
  assert.deepEqual(rows.buckets.map(b => b.twin), [null, null, null, null, null, null])
  // Across two accounts the count stands and the money is withheld, not zeroed.
  const all = sessionBuckets(r, 'all').buckets.find(b => b.key === 'SYD (ASX)')
  assert.equal(all.n, 2); assert.equal(all.sum, null); assert.equal(all.high, null)
  // No report, or a report from a server without intervals: no open reading.
  const none = sessionBuckets(null)
  assert.equal(none.source, null)
  assert.deepEqual(none.buckets.map(b => [b.open, b.intervals, b.n]), Array(6).fill([null, null, null]))
  const legacy = { ...r, windows: r.windows.map(x => x.session ? { ...x, session: { key: x.session.key } } : x),
    sessionWindow: { ...r.sessionWindow, source: 'fixed_UTC_reporting_buckets_not_market_status' } }
  const old = sessionBuckets(legacy, '11')
  assert.deepEqual(old.buckets.map(b => b.open), Array(6).fill(null))
  assert.equal(old.source, 'fixed_UTC_reporting_buckets_not_market_status')
  // Identical intervals are flagged as a pair, in both directions.
  const sydIntervals = r.windows.find(y => y.key === 'session:SYD (ASX)').session.intervals
  const twinned = { ...r, windows: r.windows.map(x => x.key === 'session:JPN'
    ? { ...x, session: { ...x.session, intervals: sydIntervals } } : x) }
  const tw = sessionBuckets(twinned, '11').buckets
  assert.equal(tw.find(b => b.key === 'JPN').twin, 'SYD (ASX)'); assert.equal(tw.find(b => b.key === 'SYD (ASX)').twin, 'JPN')
  assert.equal(tw.find(b => b.key === 'NY').twin, null)
})
