import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { hourlyActivity } from './hourly-activity.js'
import { activityEvidence } from '../../src/lib/hourly-activity.js'
import { rollingSplits } from '../../src/lib/currency-money.js'
import { rollingHourWindows } from '../../src/lib/hourly-order.js'
import { recordDepositCurrency } from './account-money.js'
const to = Date.parse('2026-09-22T09:00:00Z'), from = to - 86400_000
const scope = { all: false, accountId: '11', explicit: true }
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  const insert = db.prepare("INSERT INTO trades (symbol,status,account_id,opened_at,closed_at,net_pnl) VALUES ('EURUSD','closed',?,?,?,?)")
  return { db, add: (id = '11', at = to - 1, pnl = 2) => insert.run(id, new Date(from).toISOString(), typeof at === 'number' ? new Date(at).toISOString() : at, pnl),
    read: (s = scope) => hourlyActivity(db, s, { to, nowMs: to }) }
}
test('all closes are counted beyond journal paging, including missing P&L', t => {
  const { db, add, read } = fixture(t)
  db.transaction(() => { for (let i = 0; i < 1205; i++) add() })()
  add('11', to - 1, null)
  const r = read()
  assert.equal(r.closedN, 1206); assert.equal(r.pricedN, 1205)
  assert.equal(r.net, null); assert.equal(r.moneyByAccount[0].recordedNet, 2410)
  assert.ok(activityEvidence(r, { accountId: '11', to, nowMs: to }))
})
test('different accounts and legacy rows retain their own amounts without mixing unknown currencies', t => {
  const { add, read } = fixture(t)
  add('11'); add('22', to - 1, 300); add(null, to - 1, 5)
  const r = read({ all: true })
  assert.equal(r.closedN, 3); assert.equal(r.net, null)
  assert.equal(r.moneyByAccount.length, 3)
  assert.equal(read().closedN, 2, 'NULL-account convention is explicit')
})
test('close boundaries are half-open, missing dates remain unknown, empty is verified zero', t => {
  const { add, read } = fixture(t)
  assert.equal(read().closedN, 0); assert.equal(read().net, 0)
  for (const at of [from - 1, from, from + 3600_000, to - 1, to, null]) add('11', at)
  const r = read()
  assert.equal(r.closedN, 3); assert.equal(r.unknownCloseTimeN, 1)
  assert.deepEqual([r.rows[0].closedN, r.rows[1].closedN, r.rows[23].closedN], [1, 1, 1])
  assert.equal(activityEvidence({ ...r, closedN: 0 }, { accountId: '11', to, nowMs: to }), null)
  assert.equal(activityEvidence(r, { accountId: '22', to, nowMs: to }), null)
})

// V3 WEB-5 (8,989-A rows 5 and 7; owner default 25-09-2026): recorded money is
// pooled per broker deposit currency and never summed across currencies. The
// currency evidence is written by the production writer, so a drift in its
// state key empties the pools here instead of passing silently.
function registerCurrencies(db) {
  const acct = db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)')
  for (const [id, live] of [['11', 0], ['22', 0], ['33', 1], ['44', 0]]) acct.run(id, live)
  const demo = 'demo.ctraderapi.com', live = 'live.ctraderapi.com'
  assert.equal(recordDepositCurrency(db, { accountId: '11', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: to - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '22', host: demo, depositAssetId: 1, currency: 'USD', receivedAt: to - 5000 }), true)
  assert.equal(recordDepositCurrency(db, { accountId: '33', host: live, depositAssetId: 7, currency: 'SGD', receivedAt: to - 5000 }), true)
  // Evidence recorded for the other host is not this account's currency.
  assert.equal(recordDepositCurrency(db, { accountId: '44', host: live, depositAssetId: 1, currency: 'USD', receivedAt: to - 5000 }), true)
}
test('all accounts: money pools within one deposit currency, never across; unrecorded and unattributed closes are in no pool', t => {
  const { db, add, read } = fixture(t)
  registerCurrencies(db)
  const hour = to - 1
  add('11', hour, 20); add('22', hour, -5); add('33', hour, 7); add('44', hour, 100); add(null, hour, 1000)
  const r = read({ all: true })
  assert.equal(r.net, null, 'no single figure across accounts')
  assert.deepEqual(r.moneyByCurrency.map(c => [c.currency, c.recordedNet, c.closedN, c.pricedN, c.moneyState]),
    [['SGD', 7, 1, 1, 'recorded_currency_units'], ['USD', 15, 2, 2, 'recorded_currency_units']])
  assert.deepEqual(r.moneyByCurrency.find(c => c.currency === 'USD').accountIds.sort(), ['11', '22'])
  assert.equal(r.unpooled.closedN, 2)
  assert.deepEqual([...r.unpooled.accountIds].sort(), ['44', null].sort())
  // Every account carries its own recorded unit; none is defaulted.
  const ccy = Object.fromEntries(r.moneyByAccount.map(a => [a.accountId ?? 'legacy', a.currency]))
  assert.deepEqual(ccy, { 11: 'USD', 22: 'USD', 33: 'SGD', 44: null, legacy: null })
  // The hour carries the same split, and nothing adds SGD to USD.
  const row = r.rows[23]
  assert.deepEqual(row.moneyByCurrency.map(c => [c.currency, c.recordedNet]), [['SGD', 7], ['USD', 15]])
  assert.equal(row.unpooled.closedN, 2)
  const sums = [r, row].flatMap(x => x.moneyByCurrency.map(c => c.recordedNet))
  for (const crossSum of [22, 122, 1122, 1022]) assert.ok(!sums.includes(crossSum), `no cross-currency sum ${crossSum}`)
  assert.equal(r.currencyPolicy, 'pool_within_one_recorded_deposit_currency_never_across')
  assert.ok(activityEvidence(r, { accountId: 'all', to, nowMs: to }))
})
test('a currency with only unpriced closes has no figure, a partial pool says so, one account is still one pool', t => {
  const { db, add, read } = fixture(t)
  registerCurrencies(db)
  add('11', to - 1, 2); add('11', to - 1, null); add('33', from + 1, null)
  const r = read({ all: true })
  const usd = r.moneyByCurrency.find(c => c.currency === 'USD'), sgd = r.moneyByCurrency.find(c => c.currency === 'SGD')
  assert.deepEqual([usd.recordedNet, usd.pricedN, usd.closedN, usd.moneyState], [2, 1, 2, 'partial_recorded_currency_units'])
  assert.deepEqual([sgd.recordedNet, sgd.pricedN, sgd.closedN, sgd.moneyState], [null, 0, 1, 'unavailable'])
  assert.deepEqual(r.rows[0].moneyByCurrency.map(c => [c.currency, c.recordedNet]), [['SGD', null]])
  assert.deepEqual(r.rows[1].moneyByCurrency, [])
  // A single account scope keeps its own figure and its currency.
  const one = read()
  assert.deepEqual(one.moneyByCurrency.map(c => [c.currency, c.recordedNet, c.closedN]), [['USD', 2, 2]])
  assert.equal(one.moneyByAccount[0].currency, 'USD')
})
test('the browser shows a per-currency split only when it reconciles to the closes it splits', t => {
  const { db, add, read } = fixture(t)
  registerCurrencies(db)
  add('11', to - 1, 20); add('33', to - 1, 7); add('44', to - 1, 1)
  const r = read({ all: true })
  const opts = { accountId: 'all', to, nowMs: to }
  assert.ok(activityEvidence(r, opts))
  const clone = () => structuredClone(r)
  // An older server without the split is still evidence (no lines, nothing invented).
  const old = clone(); delete old.moneyByCurrency; delete old.unpooled
  for (const h of old.rows) { delete h.moneyByCurrency; delete h.unpooled }
  assert.ok(activityEvidence(old, opts))
  const lost = clone(); lost.moneyByCurrency[0].closedN += 1
  assert.equal(activityEvidence(lost, opts), null, 'a pool that does not reconcile is not shown')
  const hourLost = clone(); hourLost.rows[23].unpooled.closedN = 0
  assert.equal(activityEvidence(hourLost, opts), null, 'an hour whose split does not reconcile is not shown')
  const dup = clone(); dup.moneyByCurrency[1].currency = dup.moneyByCurrency[0].currency
  assert.equal(activityEvidence(dup, opts), null, 'one currency twice is not a split')
  const zero = clone(); zero.moneyByCurrency[0].pricedN = 0
  assert.equal(activityEvidence(zero, opts), null, 'a figure with no priced close is invented')
})
// WEB-5 fix round (checker blocker 1): the rolling 24-hour card's money lines
// come from ONE helper that both of the page's memos call. Exercised here from
// a real all-accounts response through the browser's own evidence check and
// the page's own hour slots, not from hand-built rows.
test('the rolling card reads one line per currency for the day and for each hour from an all-accounts response', t => {
  const { db, add, read } = fixture(t)
  registerCurrencies(db)
  const last = to - 1, first = from + 1, mid = from + 5 * 3600_000 + 1
  add('11', last, 20); add('22', last, -5); add('33', last, 7); add('44', last, 100)
  add('33', first, 2.5)
  add('11', mid, 4); add('11', mid, 1)
  const opts = { accountId: 'all', to, nowMs: to }
  const evidence = activityEvidence(read({ all: true }), opts)
  assert.ok(evidence)
  const slots = rollingHourWindows(to, 24)
  const { today, hours } = rollingSplits(evidence, slots)
  const view = s => s && [s.lines.map(l => [l.currency, l.net, l.trades]), s.unpooled?.trades ?? 0]
  // The day: each currency pooled within itself, the no-currency close counted in no line.
  assert.deepEqual(view(today), [[['SGD', 9.5, 2], ['USD', 20, 4]], 1])
  assert.equal(hours.length, 24)
  // The newest hour spans three accounts and two currencies: never one sum.
  assert.deepEqual(view(hours[23]), [[['SGD', 7, 1], ['USD', 15, 2]], 1])
  // An hour whose closes are all one account's still names its currency in the
  // all-accounts view (checker nit 1), and an empty hour has nothing to split.
  assert.deepEqual(view(hours[0]), [[['SGD', 2.5, 1]], 0])
  assert.deepEqual(view(hours[5]), [[['USD', 5, 2]], 0])
  assert.equal(hours.filter(Boolean).length, 3)
  for (const s of [today, ...hours].filter(Boolean)) {
    for (const crossSum of [16.5, 22, 29.5, 122, 129.5]) assert.ok(!s.lines.some(l => l.net === crossSum), `no cross-currency sum ${crossSum}`)
  }
  // One account's own scope keeps a whole figure bare, as before WEB-5.
  const one = activityEvidence(read(), { accountId: '11', to, nowMs: to })
  const mine = rollingSplits(one, slots)
  assert.equal(one.net, 25); assert.equal(mine.today, null); assert.equal(mine.hours[5], null)
  // No evidence, no lines — never an invented zero.
  assert.deepEqual(rollingSplits(null, slots), { today: null, hours: slots.map(() => null) })
})
