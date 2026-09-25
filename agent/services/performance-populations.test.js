import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { buildPerformancePopulations, readPerformancePopulations, buildDecisionsDaily, buildLatestPrices, readDecisionsDaily, readLatestPrices, readStageMatrixStats, readDecisionAudit } from './performance-populations.js'
import { stageMatrixStats } from './stage-matrix.js'
import { getState } from '../db.js'
import { reportStats, reportLedger, reportCurrency, reportCurrencyStats, reportUnpooled, populationStats, emptyPopulation, sessionBuckets } from '../shared/performance-populations.js'
import { recordDepositCurrency } from './account-money.js'
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
// WEB-7 (8,989-A rows 8-9): money is pooled per recorded deposit currency and
// never across two. The evidence is written by the production writer, so a
// drift in its state key fails here rather than silently emptying the pool.
function registerCurrencies(db) {
  const acct = db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)')
  for (const [id, live] of [['11', 0], ['22', 0], ['33', 1], ['44', 0], ['55', 0]]) acct.run(id, live)
  const demo = 'demo.ctraderapi.com', live = 'live.ctraderapi.com'
  assert.equal(recordDepositCurrency(db, { accountId: '11', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '22', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '33', host: live, depositAssetId: 7, currency: 'SGD', receivedAt: NOW - 5000 }), true)
  // Evidence for the other host is not this account's currency.
  assert.equal(recordDepositCurrency(db, { accountId: '44', host: live, depositAssetId: 1, currency: 'USD', receivedAt: NOW - 5000 }), true)
}
test('the report names each account deposit currency from broker evidence on its own host, never a default', t => {
  const { db, add } = setup(t)
  registerCurrencies(db); add({ pnl: 1 })
  const r = buildPerformancePopulations(db, { now: NOW })
  assert.equal(r.currencyByAccount['11'].currency, 'USD')
  assert.equal(r.currencyByAccount['11'].source, 'broker_asset_list')
  assert.equal(r.currencyByAccount['33'].currency, 'SGD')
  assert.deepEqual(r.currencyByAccount['44'], { currency: null, reason: 'deposit_currency_evidence_mismatch' })
  assert.deepEqual(r.currencyByAccount['55'], { currency: null, reason: 'deposit_currency_not_recorded' })
  assert.equal(reportCurrency(r, '44'), null)
  assert.equal(reportCurrency(r, null), null)
  assert.equal(reportCurrency(r, '99'), null)
})
test('money pools within one recorded currency, never across currencies, and a partial pool says so', t => {
  const { db, add } = setup(t)
  registerCurrencies(db)
  add({ account: '11', pnl: 20 }); add({ account: '22', pnl: -5 }); add({ account: '33', pnl: 7 })
  add({ account: '44', pnl: 100 }); add({ account: null, pnl: 1000 })
  const r = buildPerformancePopulations(db, { now: NOW })
  const usd = reportCurrencyStats(r, '30d', 'USD')
  assert.equal(usd.pnl, 15); assert.equal(usd.n, 2); assert.equal(usd.currency, 'USD')
  assert.equal(usd.moneyState, 'recorded_currency_units')
  assert.equal(reportCurrencyStats(r, '30d', 'SGD').pnl, 7)
  // The account without evidence and the unstamped close are in no currency.
  assert.equal(reportCurrencyStats(r, '30d', 'USD', g => g.accountId === '44').n, 0)
  // The pre-existing all-accounts rule is unchanged: no cross-account sum.
  assert.equal(reportStats(r, '30d').pnl, null)
  assert.equal(reportStats(r, '30d').moneyState, 'unverified_cross_account_units')
  assert.equal(reportStats(r, '30d', '11').moneyState, 'recorded_account_units')
  add({ account: '22', pnl: null })
  const partial = reportCurrencyStats(buildPerformancePopulations(db, { now: NOW }), '30d', 'USD')
  assert.equal(partial.pnl, 15); assert.equal(partial.n, 3); assert.equal(partial.pricedN, 2)
  assert.equal(partial.moneyState, 'partial_recorded_currency_units')
})
// V3 WEB-5 (8,989-A row 7): the ledger's all-accounts windows carry one line
// per recorded deposit currency, and the closes in no currency apart.
test('the all-accounts ledger splits money per currency, never sums across, and names the closes in no currency', t => {
  const { db, add } = setup(t)
  registerCurrencies(db)
  add({ account: '11', pnl: 20 }); add({ account: '22', pnl: -5 }); add({ account: '33', pnl: 7 })
  add({ account: '44', pnl: 100 }); add({ account: null, pnl: 1000 }); add({ account: '33', symbol: 'BTCUSD', pnl: null })
  const r = buildPerformancePopulations(db, { now: NOW })
  const w = reportLedger(r, 'all').windows.find(x => x.key === '30d')
  // The window's own figure is still not pooled across accounts.
  assert.equal(w.net, null); assert.equal(w.moneyState, 'unverified_cross_account_units'); assert.equal(w.trades, 6)
  assert.deepEqual(w.byCurrency.map(c => [c.currency, c.net, c.trades, c.pricedTrades, c.moneyState]),
    [['SGD', 7, 2, 1, 'partial_recorded_currency_units'], ['USD', 15, 2, 2, 'recorded_currency_units']])
  assert.deepEqual([w.unpooled.trades, w.unpooled.pricedTrades], [2, 2])
  assert.deepEqual([...w.unpooled.accountIds].sort(), ['44', null].sort())
  // Pools + unpooled reconcile to the window, and no line is a cross-currency sum.
  assert.equal(w.byCurrency.reduce((n, c) => n + c.trades, w.unpooled.trades), w.trades)
  for (const crossSum of [22, 122, 1122, 1015, 1007]) assert.ok(!w.byCurrency.some(c => c.net === crossSum), `no cross-currency sum ${crossSum}`)
  // Markets split the same way.
  assert.deepEqual(w.markets.fx.byCurrency.map(c => [c.currency, c.net, c.trades]), [['SGD', 7, 1], ['USD', 15, 2]])
  assert.deepEqual(w.markets.crypto.byCurrency.map(c => [c.currency, c.net, c.trades, c.moneyState]), [['SGD', null, 1, 'unavailable']])
  assert.equal(w.markets.crypto.unpooled.trades, 0)
  // One account needs no split: its figure is already one currency's.
  const one = reportLedger(r, '11').windows.find(x => x.key === '30d')
  assert.equal(one.net, 20); assert.equal(one.byCurrency, undefined); assert.equal(one.unpooled, undefined)
  // A report with no currency evidence (an older agent) splits nothing.
  const bare = reportLedger({ ...r, currencyByAccount: undefined }, 'all').windows.find(x => x.key === '30d')
  assert.deepEqual(bare.byCurrency, []); assert.equal(bare.unpooled.trades, 6)
})
// WEB-5 fix round (checker nit 2): reportLedger partitions each window's
// groups by currency once instead of re-filtering every group per currency,
// per market. The partitioned split must equal the per-currency reference
// (reportCurrencyStats, reportUnpooled) figure for figure, in every window and
// market — including closes with no account, an account with no recorded or a
// malformed currency, empty groups, and currencies interleaved in the list.
test('the partitioned ledger split equals the per-currency reference in every window and market', () => {
  const g = (accountId, market, net, { n = 1, pricedN = 1 } = {}) => ({ accountId, market, sym: 'X', strat: 's',
    stats: { ...emptyPopulation(), n, pricedN, wins: net > 0 ? pricedN : 0, net, gw: Math.max(0, net), gl: Math.max(0, -net), tp: net > 0 ? 1 : 0, sl: net < 0 ? 1 : 0 } })
  const groups = [g('11', 'fx', 20.1), g('33', 'fx', 7.3), g('22', 'stock', -5.7), g(null, 'fx', 1000), g('44', 'fx', 100),
    g('55', 'metal', 3), g('11', 'metal', 0.3, { n: 3, pricedN: 2 }), g('33', 'stock', 0, { n: 2, pricedN: 0 }),
    g('22', 'fx', 0, { n: 0, pricedN: 0 }), g('66', 'fx', -1.1), g('33', 'metal', -2.2)]
  const r = { status: 'complete', lastCloseByAccount: {}, markets: ['fx', 'stock', 'metal', 'crypto'],
    currencyByAccount: { 11: { currency: 'USD' }, 22: { currency: 'USD' }, 33: { currency: 'SGD' }, 44: { currency: null }, 55: { currency: 'usd' }, 66: { currency: 'EUR' } },
    windows: [{ key: 'a', label: 'A', from: 0, to: 1, ledger: true, groups },
      { key: 'b', label: 'B', from: 0, to: 1, ledger: true, groups: groups.slice(3) },
      { key: 'c', label: 'C', from: 0, to: 1, ledger: true, groups: [] }] }
  const pick = s => [s.currency, s.net, s.trades, s.pricedTrades, s.winPct, s.pf, s.pfInfinite, s.tp, s.sl, s.payoffRatio, s.moneyState]
  const ref = (key, predicate) => ({
    byCurrency: ['EUR', 'SGD', 'USD'].map(c => ({ c, s: reportCurrencyStats(r, key, c, predicate) })).filter(x => x.s.n > 0)
      .map(({ c, s }) => [c, s.pnl, s.n, s.pricedN, s.wr, s.pf, s.pfInfinite, s.tp, s.sl, s.payoff, s.moneyState]),
    unpooled: reportUnpooled(r, key, predicate),
  })
  const ledger = reportLedger(r, 'all')
  assert.deepEqual(ledger.windows.map(w => w.key), ['a', 'b', 'c'])
  let compared = 0
  for (const w of ledger.windows) {
    for (const [cell, predicate] of [[w, () => true], ...r.markets.map(m => [w.markets[m], x => x.market === m])]) {
      const want = ref(w.key, predicate)
      assert.deepEqual(cell.byCurrency.map(pick), want.byCurrency, `${w.key} byCurrency`)
      assert.deepEqual(cell.unpooled, want.unpooled, `${w.key} unpooled`)
      compared += cell.byCurrency.length
    }
  }
  // The comparison reached real pools, not only empty ones.
  assert.ok(compared >= 10, `compared ${compared} pools`)
  const a = ledger.windows[0]
  assert.deepEqual(a.byCurrency.map(c => [c.currency, c.trades]), [['EUR', 1], ['SGD', 4], ['USD', 5]])
  assert.deepEqual([a.unpooled.trades, [...a.unpooled.accountIds].sort()], [3, ['44', '55', null].sort()])
})
test('a pool whose groups span two currencies adds nothing, whatever the caller filtered', () => {
  const g = (accountId, net) => ({ accountId, stats: { ...emptyPopulation(), n: 1, pricedN: 1, net, gw: Math.max(0, net), gl: Math.max(0, -net) } })
  const currencyOf = id => ({ 11: 'USD', 22: 'USD', 33: 'SGD' })[id] ?? null
  const mixed = populationStats([g('11', 20), g('33', 7)], { currency: 'USD', currencyOf })
  assert.equal(mixed.pnl, null); assert.equal(mixed.moneyState, 'unverified_cross_account_units'); assert.equal(mixed.currency, null)
  assert.equal(populationStats([g('11', 20), g(null, 1)], { currency: 'USD', currencyOf }).pnl, null)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'usd', currencyOf }).pnl, null)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'USD', currencyOf }).pnl, 15)
  assert.equal(populationStats([g('11', 20), g('22', -5)], { currency: 'USD' }).pnl, null)
  assert.equal(reportCurrencyStats({ status: 'complete', windows: [{ key: '30d', groups: [] }] }, '30d', null).state, 'unavailable')
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
