// V3 WEB-3 (8,989-A rows 5 and 7): balance and floating per hour, and ledger
// carry in / carry out, from OBSERVED broker balances only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordAccountHistory } from './account-history.js'
import { recordDepositCurrency } from './account-money.js'
import { balanceReader, BALANCE_EDGE_MAX_AGE_MS } from './balance-edges.js'
import { hourlyActivity } from './hourly-activity.js'
import { buildPerformancePopulations } from './performance-populations.js'
import { reportLedger } from '../shared/performance-populations.js'
import { missingBalanceLabel } from '../shared/balance-carry.js'

const MIN = 60_000, H = 3600_000
// Relative to the real clock: recordAccountHistory prunes by Date.now().
const T = Math.floor(Date.now() / H) * H
const DEMO = 'demo.ctraderapi.com', LIVE = 'live.ctraderapi.com'

// Each account's RECORDED deposit currency, written by the production writer
// (recordDepositCurrency) — the evidence WEB-7's pools read. 44 has none.
const RECORDED = { 11: 'USD', 22: 'USD', 33: 'SGD', 44: null }
function fixture(t, accounts = [['11', 0], ['22', 0], ['33', 1]], recorded = RECORDED) {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'account_history_pruned_ms', String(Date.now()))
  for (const [id, live] of accounts) db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, ?, 1)').run(id, live)
  const hostOf = id => accounts.find(a => a[0] === id)?.[1] ? LIVE : DEMO
  for (const [id] of accounts) {
    if (recorded[id]) assert.equal(recordDepositCurrency(db, { accountId: id, host: hostOf(id), depositAssetId: recorded[id] === 'SGD' ? 7 : 1, currency: recorded[id], receivedAt: T - 30 * H }), true)
  }
  const trader = (id, at, balance, currency = 'USD', extra = {}) => recordAccountHistory(db,
    { accountId: id, host: hostOf(id), source: 'broker_trader', receivedAt: at, currency, balance, ...extra })
  const equity = (id, at, balance, openPnl, currency = 'USD', extra = {}) => recordAccountHistory(db,
    { accountId: id, host: hostOf(id), source: 'broker_equity', receivedAt: at, currency, balance, openPnl,
      equity: balance + openPnl, balanceReceivedAt: at, pnlReceivedAt: at, ...extra })
  return { db, trader, equity }
}

test('an edge is the latest broker balance at or before it, within the tolerance, never one read after it', t => {
  const { db, trader } = fixture(t)
  trader('11', T - 20 * MIN, 100)
  trader('11', T - 10 * MIN, 110)
  trader('11', T + 30_000, 120) // read AFTER the edge: must not answer for it
  const r = balanceReader(db)
  assert.deepEqual(r.at('11', T), { status: 'observed', value: 110, currency: 'USD', at: T - 10 * MIN, source: 'broker_trader', ageMs: 10 * MIN })
  // The newest read (T+30 s) is one minute older than the tolerance at this
  // edge: a stated gap, not the older read carried forward.
  assert.deepEqual(balanceReader(db).at('11', T + 30_000 + BALANCE_EDGE_MAX_AGE_MS + MIN),
    { status: 'not_stored', reason: 'no_observation_near_edge', maxAgeMs: BALANCE_EDGE_MAX_AGE_MS })
  assert.equal(balanceReader(db).at('11', T + 30_000 + BALANCE_EDGE_MAX_AGE_MS).value, 120, 'exactly at the tolerance still counts')
  // Before the first stored balance: named as such, with where storage begins.
  assert.deepEqual(balanceReader(db).at('11', T - 21 * MIN), { status: 'not_stored', reason: 'before_balance_history', storedFrom: T - 20 * MIN })
  // An account that never stored a balance.
  assert.deepEqual(balanceReader(db).at('22', T), { status: 'not_stored', reason: 'no_balance_stored' })
})

test('a balance read before the edge but written just after it answers for the edge; its read time is what counts', t => {
  const { db, equity } = fixture(t)
  // broker_equity rows are written up to 60 s after the trader read.
  equity('11', T + 40_000, 500, 3, 'USD', { balanceReceivedAt: T - 5_000 })
  const edge = balanceReader(db).at('11', T)
  assert.equal(edge.status, 'observed'); assert.equal(edge.value, 500); assert.equal(edge.at, T - 5_000)
})

test('unusable observations never become a balance: error, no currency, unknown read time, wrong host', t => {
  const { db, trader } = fixture(t)
  trader('11', T - 14 * MIN, 900) // the only usable one
  trader('11', T - 4 * MIN, 1, 'USD', { error: 'broker 502' })
  trader('11', T - 3 * MIN, 2, null)
  recordAccountHistory(db, { accountId: '11', host: DEMO, source: 'broker_snapshot', receivedAt: T - 2 * MIN, currency: 'USD', balance: 3, balanceReceivedAt: null })
  recordAccountHistory(db, { accountId: '11', host: LIVE, source: 'broker_trader', receivedAt: T - 1 * MIN, currency: 'USD', balance: 4 })
  const edge = balanceReader(db).at('11', T)
  assert.equal(edge.value, 900)
  assert.equal(edge.at, T - 14 * MIN)
})

test('a row received inside the window whose balance was READ before it is not an observation at the edge', t => {
  const { db } = fixture(t)
  // Received one minute before the edge, but the broker balance it carries was
  // read twenty minutes before it: older than the tolerance, so it cannot
  // answer for the edge even though the SQL window (by received time) holds it.
  recordAccountHistory(db, { accountId: '11', host: DEMO, source: 'broker_snapshot', receivedAt: T - 1 * MIN,
    currency: 'USD', balance: 777, balanceReceivedAt: T - 20 * MIN })
  const r = balanceReader(db)
  assert.equal(r.account('11').historyStartsAt, T - 20 * MIN, 'storage covers the edge, so the gap is not "before history"')
  assert.deepEqual(r.at('11', T), { status: 'not_stored', reason: 'no_observation_near_edge', maxAgeMs: BALANCE_EDGE_MAX_AGE_MS })
})

test('valued rows that fail the read check never hide a usable balance behind them', t => {
  const { db } = fixture(t)
  // Ten rows the SQL filter accepts (balance, currency, a non-null read time)
  // but whose read time is not an integer, on each side of one usable read.
  const bad = at => recordAccountHistory(db, { accountId: '11', host: DEMO, source: 'broker_snapshot', receivedAt: at,
    currency: 'USD', balance: 1, balanceReceivedAt: 'not-a-time' })
  for (let i = 0; i < 10; i++) bad(T - 60 * MIN + i * MIN)
  recordAccountHistory(db, { accountId: '11', host: DEMO, source: 'broker_trader', receivedAt: T - 30 * MIN, currency: 'USD', balance: 4321 })
  for (let i = 0; i < 10; i++) bad(T - 20 * MIN + i * MIN)
  const r = balanceReader(db)
  // The currency is the RECORDED deposit currency (V3 WEB-3m), not read off a stored balance.
  assert.deepEqual(r.account('11'), { accountId: '11', host: DEMO, registered: true, currency: 'USD', currencyReason: null, historyStartsAt: T - 30 * MIN, balanceReason: null })
  assert.equal(r.at('11', T - 20 * MIN).value, 4321)
})

test('the hourly card carries observed open/close balance and the last floating reading of each hour', t => {
  const { db, trader, equity } = fixture(t)
  for (let at = T - 26 * H; at <= T; at += 3 * MIN) trader('11', at, 1000 + Math.floor((at - (T - 26 * H)) / H))
  equity('11', T - 2 * H + 10 * MIN, 1024, -7.5)
  equity('11', T - 2 * H + 50 * MIN, 1024, -2.25) // the later reading in the hour wins
  const r = hourlyActivity(db, { all: false, accountId: '11', explicit: true }, { to: T, nowMs: T })
  assert.equal(r.balanceReconstruction, 'observed_broker_balance_at_edges')
  assert.equal(r.balanceHistory.status, 'complete')
  const last = r.rows[23], prev = r.rows[22]
  // Hour [T-1h, T): opened at the balance read at T-1h, closed at the read at T.
  assert.equal(last.openBal, 1025); assert.equal(last.closeBal, 1026)
  assert.equal(last.balance.close.groups[0].oldestAt, T)
  for (let i = 1; i < 24; i++) assert.equal(r.rows[i].openBal, r.rows[i - 1].closeBal, `hour ${i} opens where hour ${i - 1} closed`)
  assert.equal(prev.floating, -2.25)
  assert.equal(prev.balance.floating.groups[0].oldestAt, T - 2 * H + 50 * MIN)
  assert.equal(last.floating, null, 'no floating reading in the hour is not a zero')
  assert.equal(last.balance.floating.groups[0].reason, 'no_floating_reading')
})

test('hours before the stored balance history say so, with the time storage begins', t => {
  const { db, trader } = fixture(t)
  for (let at = T - 5 * H - 17 * MIN; at <= T; at += 3 * MIN) trader('11', at, 50)
  const r = hourlyActivity(db, { all: false, accountId: '11', explicit: true }, { to: T, nowMs: T })
  const early = r.rows[0].balance.open.groups[0]
  assert.equal(r.rows[0].openBal, null)
  assert.equal(early.reason, 'before_balance_history')
  assert.equal(early.storedFrom, T - 5 * H - 17 * MIN)
  assert.equal(r.rows[23].closeBal, 50)
})

test('all accounts: per currency, summed only when every account of the currency was read, never across currencies', t => {
  const { db, trader } = fixture(t, [['11', 0], ['22', 0], ['33', 1], ['44', 0]])
  for (let at = T - 26 * H; at <= T; at += 3 * MIN) {
    trader('11', at, 100)
    trader('33', at, 50, 'SGD')
    if (at <= T - 3 * H) trader('22', at, 200) // stops being read 3 h ago
  }
  // 44 has no recorded deposit currency, so it is in no currency group.
  const r = hourlyActivity(db, { all: true, explicit: true }, { to: T, nowMs: T })
  const early = r.rows[10].balance.close, late = r.rows[23].balance.close
  assert.equal(r.rows[10].closeBal, null, 'two currencies and an unknown account: no single total')
  assert.deepEqual(early.groups.map(g => [g.currency, g.value, g.accounts]), [['SGD', 50, 1], ['USD', 300, 2]])
  assert.equal(early.unknownCurrencyAccounts, 1)
  const usd = late.groups.find(g => g.currency === 'USD')
  assert.equal(usd.value, null, 'one USD account unread at the edge: no USD total')
  assert.equal(usd.observedAccounts, 1); assert.equal(usd.reason, 'no_observation_near_edge')
  assert.deepEqual(usd.missingAccounts, ['22'], 'the account holding the USD total open is named')
  assert.deepEqual(late.unknownAccounts, ['44'], 'the account with no recorded currency is named')
  assert.equal(late.unknownReason, 'deposit_currency_not_recorded')
  assert.deepEqual(late.groups.find(g => g.currency === 'SGD').missingAccounts, [])
  assert.equal(late.groups.find(g => g.currency === 'SGD').value, 50)
})

test('ledger carry in / carry out come from the observed balances at the window edges', t => {
  const { db, trader } = fixture(t, [['11', 0], ['33', 1]])
  const start = T - 20 * H
  for (let at = start; at <= T; at += 3 * MIN) {
    trader('11', at, 1000 + Math.floor((at - start) / H))
    trader('33', at, 70, 'SGD')
  }
  const report = buildPerformancePopulations(db, { now: T })
  assert.equal(report.balanceEdges.status, 'complete')
  const one = Object.fromEntries(reportLedger(report, '11').windows.map(w => [w.key, w]))
  assert.equal(one['1h'].carryIn, 1019); assert.equal(one['1h'].carryOut, 1020); assert.equal(one['1h'].carryCurrency, 'USD')
  assert.equal(one['12h'].carryIn, 1008)
  // 30D starts before storage: no carry in, and the reason names the start.
  assert.equal(one['30d'].carryIn, null)
  assert.equal(one['30d'].carry.in.groups[0].reason, 'before_balance_history')
  assert.equal(one['30d'].carry.in.groups[0].storedFrom, start)
  assert.equal(one['30d'].carryOut, 1020)
  // All accounts: SGD and USD stay apart.
  const all = reportLedger(report, 'all').windows.find(w => w.key === '1h')
  assert.equal(all.carryIn, null)
  assert.deepEqual(all.carry.out.groups.map(g => [g.currency, g.value]), [['SGD', 70], ['USD', 1020]])
})

test('no stored balance leaves every carry null with a reason; a failed read is unavailable, not zero', t => {
  const { db } = fixture(t, [['11', 0], ['44', 0]])
  const report = buildPerformancePopulations(db, { now: T })
  const w = reportLedger(report, '11').windows.find(x => x.key === '4h')
  assert.equal(w.carryIn, null); assert.equal(w.carryOut, null)
  // 11 has a recorded currency but no stored balance: its USD group says so.
  assert.deepEqual(w.carry.in.groups.map(g => [g.currency, g.value, g.reason]), [['USD', null, 'no_balance_stored']])
  assert.equal(w.carry.in.unknownCurrencyAccounts, 0)
  // 44 has no recorded deposit currency: in no group, and the reason says why.
  const none = reportLedger(report, '44').windows.find(x => x.key === '4h')
  assert.deepEqual(none.carry.in.groups, [])
  assert.equal(none.carry.in.unknownCurrencyAccounts, 1)
  assert.equal(none.carry.in.unknownReason, 'deposit_currency_not_recorded')
  const broken = reportLedger({ ...report, balanceEdges: { status: 'unavailable', reason: 'balance_history_read_failed' } }, '11').windows[0]
  assert.equal(broken.carryIn, null)
  assert.deepEqual(broken.carry, { status: 'unavailable', reason: 'balance_history_read_failed', in: null, out: null })
})

// V3 WEB-3m: the balance columns and the carry use the SAME currency evidence
// and pooling rule as WEB-7's pools — the recorded deposit currency
// (currencyByAccount / reportCurrency) — and a two-currency All view never
// sums across currencies in any WEB-3 row.
test('two currencies on All: every hourly and ledger row keeps SGD and USD apart, keyed on the recorded currency, never a stamp', t => {
  const { db, trader, equity } = fixture(t, [['11', 0], ['22', 0], ['33', 1]])
  for (let at = T - 26 * H; at <= T; at += 3 * MIN) {
    trader('11', at, 100)
    trader('22', at, 200)
    trader('33', at, 50, 'SGD')
  }
  for (let at = T - 24 * H + 30 * MIN; at < T; at += H) {
    equity('11', at, 100, -5)
    equity('22', at, 200, -2)
    equity('33', at, 50, 1.7, 'SGD')
  }
  const r = hourlyActivity(db, { all: true, explicit: true }, { to: T, nowMs: T })
  const report = buildPerformancePopulations(db, { now: T })
  const ledger = reportLedger(report, 'all').windows.filter(w => w.carry?.status === 'observed_broker_balance')
  assert.equal(r.rows.length, 24); assert.ok(ledger.length >= 4, 'the rolling ledger windows are covered')
  // The currency every row keys on is the report's own recorded currency.
  assert.deepEqual(r.balanceHistory.accounts.map(a => [a.accountId, a.currency]), Object.entries(report.currencyByAccount).map(([id, c]) => [id, c.currency]))
  const crossSums = [150, 250, 350, -3.3, -0.3, -5.3]
  const sets = [...r.rows.flatMap(h => [h.balance.open, h.balance.close, h.balance.floating]),
    ...ledger.flatMap(w => [w.carry.in, w.carry.out]).filter(set => set.groups.every(g => g.value != null))]
  assert.ok(sets.length > 60)
  for (const set of sets) {
    assert.equal(set.total, null, 'no single total across two currencies')
    for (const g of set.groups) assert.ok(!crossSums.some(x => Math.abs(x - g.value) < 1e-9), `${g.currency} ${g.value} is a cross-currency sum`)
  }
  assert.deepEqual(r.rows[23].balance.close.groups.map(g => [g.currency, g.value, g.accounts]), [['SGD', 50, 1], ['USD', 300, 2]])
  assert.deepEqual(r.rows[22].balance.floating.groups.map(g => [g.currency, g.value]), [['SGD', 1.7], ['USD', -7]])
  assert.deepEqual(ledger.find(w => w.key === '1h').carry.out.groups.map(g => [g.currency, g.value]), [['SGD', 50], ['USD', 300]])

  // A read stamped in another currency than the account's recorded one never
  // moves the account into that currency: 22 is recorded USD, so a stray
  // SGD-stamped read neither joins the SGD total (the old stamp-keyed rule
  // would have made it 250) nor counts as USD.
  // At this edge 11 and 33 have fresh reads, and 22's only read inside the
  // tolerance is the stray SGD-stamped one (its USD reads are 19 min old).
  trader('22', T + 5 * MIN, 999, 'SGD')
  trader('11', T + 15 * MIN, 100); trader('33', T + 15 * MIN, 50, 'SGD')
  const edge = T + 19 * MIN
  assert.deepEqual(balanceReader(db).at('22', edge), { status: 'not_stored', reason: 'observation_currency_mismatch', maxAgeMs: BALANCE_EDGE_MAX_AGE_MS })
  const later = hourlyActivity(db, { all: true, explicit: true }, { to: edge, nowMs: edge }).rows[23].balance.close
  assert.deepEqual(later.groups.map(g => [g.currency, g.value, g.reason]), [['SGD', 50, null], ['USD', null, 'observation_currency_mismatch']])
  assert.deepEqual(later.groups.find(g => g.currency === 'USD').missingAccounts, ['22'])
})

// V3 WEB-3m fix round (checker B1). An account recorded in one currency whose
// every stored read is stamped in another stored thousands of balances: "not
// stored" would be false. Every WEB-3 reader gives the same reason for it.
test('an account whose every stored read carries another currency reads "read not in <recorded>", never "not stored", on every WEB-3 surface', t => {
  const { db, trader, equity } = fixture(t, [['11', 0], ['33', 1]])
  // 33 is recorded SGD (RECORDED above); every read of it is stamped USD.
  for (let at = T - 26 * H; at <= T; at += 3 * MIN) { trader('11', at, 100); trader('33', at, 50) }
  for (let at = T - 24 * H + 30 * MIN; at < T; at += H) equity('33', at, 50, 1.5)
  const r = balanceReader(db)
  assert.equal(r.account('33').historyStartsAt, null, 'no balance in its recorded currency: no history in its unit')
  assert.equal(r.account('33').balanceReason, 'observation_currency_mismatch')
  assert.deepEqual(r.at('33', T), { status: 'not_stored', reason: 'observation_currency_mismatch' })
  // One account: the balance cell and the floating column give the SAME reason.
  const one = hourlyActivity(db, { all: false, accountId: '33', explicit: true }, { to: T, nowMs: T })
  const close = one.rows[23].balance.close
  assert.deepEqual(close.groups.map(g => [g.currency, g.value, g.reason]), [['SGD', null, 'observation_currency_mismatch']])
  assert.equal(missingBalanceLabel(close.groups[0]), 'read not in SGD')
  assert.equal(one.rows[22].balance.floating.groups[0].reason, 'observation_currency_mismatch')
  assert.equal(one.balanceHistory.accounts[0].historyStartsAt, null)
  // All accounts: USD pooled from 11 alone, SGD held open with the same reason.
  const all = hourlyActivity(db, { all: true, explicit: true }, { to: T, nowMs: T }).rows[23].balance.close
  assert.deepEqual(all.groups.map(g => [g.currency, g.value, g.reason]), [['SGD', null, 'observation_currency_mismatch'], ['USD', 100, null]])
  assert.equal(all.total, null)
  // The ledger carry reads the same reason.
  const report = buildPerformancePopulations(db, { now: T })
  const w = reportLedger(report, '33').windows.find(x => x.key === '1h')
  assert.deepEqual(w.carry.out.groups.map(g => [g.currency, g.value, g.reason]), [['SGD', null, 'observation_currency_mismatch']])
  assert.equal(w.carryOut, null)
})

test('rows in another currency that are not a usable balance do not make an account "read not in" its currency', t => {
  const { db, trader } = fixture(t, [['11', 0], ['33', 1]])
  // 33 (recorded SGD) has only USD-stamped rows that cannot be a balance:
  // an errored read and a read with no known read time.
  trader('33', T - 10 * MIN, 50, 'USD', { error: 'broker 502' })
  trader('33', T - 5 * MIN, 50, 'USD', { balanceReceivedAt: 'not-a-time' })
  const r = balanceReader(db)
  assert.equal(r.account('33').balanceReason, 'no_balance_stored')
  assert.deepEqual(r.at('33', T), { status: 'not_stored', reason: 'no_balance_stored' })
  // A usable USD-stamped read after them turns it into a currency mismatch.
  trader('33', T - 1 * MIN, 50, 'USD')
  assert.equal(balanceReader(db).at('33', T).reason, 'observation_currency_mismatch')
  // And a first read in its recorded currency starts its history there.
  trader('33', T + 1 * MIN, 70, 'SGD')
  const later = balanceReader(db)
  assert.equal(later.account('33').historyStartsAt, T + 1 * MIN)
  assert.equal(later.account('33').balanceReason, null)
  assert.equal(later.at('33', T + 2 * MIN).value, 70)
  assert.equal(later.at('33', T).reason, 'before_balance_history')
})

test('the carry\'s currency is the report\'s currencyByAccount: without it nothing is pooled (the wiring)', t => {
  const { db, trader } = fixture(t, [['11', 0], ['33', 1]])
  for (let at = T - 3 * H; at <= T; at += 3 * MIN) { trader('11', at, 100); trader('33', at, 50, 'SGD') }
  const report = buildPerformancePopulations(db, { now: T })
  assert.deepEqual(reportLedger(report, 'all').windows.find(w => w.key === '1h').carry.in.groups.map(g => [g.currency, g.value]), [['SGD', 50], ['USD', 100]])
  // The same edges with no recorded currencies: every account is in no group.
  const bare = reportLedger({ ...report, currencyByAccount: {} }, 'all').windows.find(w => w.key === '1h')
  assert.deepEqual(bare.carry.in.groups, [])
  assert.equal(bare.carry.in.unknownCurrencyAccounts, 2)
  assert.equal(bare.carryIn, null)
})

// V3 WEB-5m (the WEB-3 / WEB-5 / WEB-7 merge): ONE currency source and ONE
// pooling rule. On All, the recorded-money pools (WEB-5), the balance columns
// (WEB-3) and the ledger's net lines and carry name every account by the SAME
// recorded deposit currency — the report's currencyByAccount — and no row
// sums two currencies. 22 is recorded USD while every balance read of it is
// stamped SGD: its money stays in USD and its balance holds the USD total open
// ("read not in USD"); neither ever joins SGD. 44 has no recorded currency:
// its money and its balance are in no currency, and named.
test('one currency source on All: money pools, balance columns, ledger net and carry all key on the recorded currency', t => {
  const { db, trader } = fixture(t, [['11', 0], ['22', 0], ['33', 1], ['44', 0]])
  for (let at = T - 3 * H; at <= T; at += 3 * MIN) { trader('11', at, 100); trader('22', at, 200, 'SGD'); trader('33', at, 50, 'SGD'); trader('44', at, 10) }
  const close = db.prepare(`INSERT INTO trades(symbol,side,status,account_id,net_pnl,closed_at,closed_at_ms,
    entry_price,sl_price,tp_price,strategy,close_reason) VALUES('EURUSD','BUY','closed',?,?,?,?,100,99,102,'ema_cross','TP hit')`)
  const closedAt = T - 10 * MIN
  for (const [id, pnl] of [['11', 20], ['22', -5], ['33', 7], ['44', 100]]) close.run(id, pnl, new Date(closedAt).toISOString(), closedAt)
  const r = hourlyActivity(db, { all: true, explicit: true }, { to: T, nowMs: T })
  const report = buildPerformancePopulations(db, { now: T })
  const recorded = Object.fromEntries(Object.entries(report.currencyByAccount).map(([id, c]) => [id, c.currency]))
  assert.deepEqual(recorded, { 11: 'USD', 22: 'USD', 33: 'SGD', 44: null })
  // Every surface names each account by that one map.
  assert.deepEqual(Object.fromEntries(r.moneyByAccount.map(a => [a.accountId, a.currency])), recorded)
  assert.deepEqual(Object.fromEntries(r.balanceHistory.accounts.map(a => [a.accountId, a.currency])), recorded)
  // Money: USD is 11 + 22, SGD is 33, 44 is in no pool.
  const hour = r.rows[23]
  for (const set of [r, hour]) {
    assert.deepEqual(set.moneyByCurrency.map(c => [c.currency, c.recordedNet, [...c.accountIds].sort(), c.moneyState]),
      [['SGD', 7, ['33'], 'recorded_currency_units'], ['USD', 15, ['11', '22'], 'recorded_currency_units']])
    assert.deepEqual(set.unpooled.accountIds, ['44'])
  }
  // Balance: the same currencies; 22's SGD-stamped reads hold USD open and
  // never join SGD (250).
  assert.deepEqual(hour.balance.close.groups.map(g => [g.currency, g.value, g.reason, g.missingAccounts]),
    [['SGD', 50, null, []], ['USD', null, 'observation_currency_mismatch', ['22']]])
  assert.deepEqual(hour.balance.close.unknownAccounts, ['44'])
  // Ledger: net lines and carry groups on the same currencies.
  const w = reportLedger(report, 'all').windows.find(x => x.key === '1h')
  assert.deepEqual(w.byCurrency.map(c => [c.currency, c.net, c.trades, c.moneyState]),
    [['SGD', 7, 1, 'recorded_currency_units'], ['USD', 15, 2, 'recorded_currency_units']])
  assert.deepEqual(w.unpooled.accountIds, ['44'])
  assert.deepEqual(w.carry.out.groups.map(g => [g.currency, g.value]), [['SGD', 50], ['USD', null]])
  assert.deepEqual(w.carry.out.unknownAccounts, ['44'])
  assert.equal(w.net, null); assert.equal(w.carryOut, null)
  const moneyFigures = [...r.moneyByCurrency, ...hour.moneyByCurrency].map(c => c.recordedNet).concat(w.byCurrency.map(c => c.net))
  const balanceFigures = [...hour.balance.close.groups, ...w.carry.out.groups].map(g => g.value)
  for (const x of [22, 122, 2, 250, 350, 360]) {
    assert.ok(!moneyFigures.includes(x), `no cross-currency money sum ${x}`)
    assert.ok(!balanceFigures.includes(x), `no cross-currency balance sum ${x}`)
  }
})
