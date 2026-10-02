// node --test agent/services/balance-unit.test.js
//
// C·1 (02-10-2026): the stored balance is the broker's NATIVE money whatever the
// key says. These pin the LABELS only: the unit comes from broker-verified
// evidence, an unverified unit is said so, and no stored value changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { balanceUnit, moneyLabel } from './balance-unit.js'
import { fmtAccountLines, fmtStatus } from './telegram-control.js'
import { dailyStopReading } from './daily-stop-reading.js'

const T = Date.parse('2026-09-22T09:00:00Z')
const host = 'live.ctraderapi.com'
const withMoney = (db, id, ccy, balance, assetId = '14') => {
  if (ccy) recordDepositCurrency(db, { accountId: id, host, depositAssetId: assetId, currency: ccy, receivedAt: T })
  recordAccountMoney(db, { accountId: id, host, trader: { depositAssetId: Number(assetId), moneyDigits: 2 }, balance, receivedAt: T })
}

test('the unit is the broker-verified deposit currency; an unverified one is null, never a guess', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  withMoney(db, '11', 'SGD', 51.41)
  withMoney(db, '22', 'USD', 697.83, '15')
  withMoney(db, '33', null, 10)
  assert.deepEqual(balanceUnit(db, '11'), { currency: 'SGD', usdComparable: false, source: 'broker_verified' })
  assert.deepEqual(balanceUnit(db, '22'), { currency: 'USD', usdComparable: true, source: 'broker_verified' })
  assert.deepEqual(balanceUnit(db, '33'), { currency: null, usdComparable: null, source: 'unverified' })
  assert.deepEqual(balanceUnit(db, '99'), { currency: null, usdComparable: null, source: 'unverified' }, 'no observation at all')
  assert.equal(balanceUnit(db, null).currency, null)
})

test('labels: SGD is named, verified USD keeps the dollar sign, an unverified unit says so', () => {
  assert.equal(moneyLabel(51.41, { currency: 'SGD' }), 'SGD 51.41')
  assert.equal(moneyLabel(697.83, { currency: 'USD' }), '$697.83')
  assert.equal(moneyLabel(10, { currency: null }), '10.00 (currency unverified)')
  assert.equal(moneyLabel(10, null), '10.00 (currency unverified)')
  assert.equal(moneyLabel(null, { currency: 'SGD' }), '?')
})

test('the Telegram account lines label each balance in the account\'s own currency, and store nothing', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const [id, live] of [['11', 1], ['22', 0]]) db.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, 1, 'active')`).run(id, live)
  withMoney(db, '11', 'SGD', 51.41)
  withMoney(db, '22', 'USD', 697.83, '15')
  setState(db, 'acct:11:account_balance_usd', '51.41')
  setState(db, 'acct:22:account_balance_usd', '697.83')
  const lines = fmtAccountLines(db).join('\n')
  assert.match(lines, /11 LIVE · SGD 51\.41/)
  assert.match(lines, /22 demo · \$697\.83/)
  assert.doesNotMatch(lines, /\$51\.41/, 'SGD money is not printed as dollars')
  assert.equal(getState(db, 'acct:11:account_balance_usd'), '51.41', 'no stored value changed')
})

test('the daily-stop explanation names the % check in the account\'s own currency', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'acct:11:account_balance_usd', '51.41')
  const sgd = dailyStopReading(db, '11', { moneyCurrency: 'SGD' })
  assert.equal(sgd.binding, 'floor')
  assert.match(sgd.explain, /above SGD 1\.54 from the % check/, sgd.explain)
  assert.doesNotMatch(sgd.explain, /USD 1\.54/)
  assert.match(sgd.explain, /the USD 200\.00 floor binds/, 'the floor is configured in USD and stays USD')
  const usd = dailyStopReading(db, '11', { moneyCurrency: 'USD' })
  assert.match(usd.explain, /above USD 1\.54 from the % check/)
})

test('the Telegram status line prints the selected account\'s own balance in its own currency, not the last-refreshed global key', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  withMoney(db, '11', 'SGD', 51.41)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'acct:11:account_balance_usd', '51.41')
  setState(db, 'account_balance_usd', '43098.4')   // another account refreshed the legacy global key last
  const text = fmtStatus(db)
  assert.match(text, /balance: SGD 51\.41/, text)
  assert.doesNotMatch(text, /43098/, 'the borrowed global key is not shown')
  setState(db, 'ctrader_account_id', '')
  setState(db, 'account_balance_usd', '10')
  assert.match(fmtStatus(db), /balance: 10\.00 \(currency unverified\)/, 'no account named: the legacy key, honestly labelled')
})
