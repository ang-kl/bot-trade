// Whose balance is this? The question the Trade header could not answer.
//
// Owner, 04-08-2026, with a screenshot: "conflicting account numbers … cause
// the user distrust the page information". The header printed
//     Account: DEMO 5306502   $1,370.44
// and $1,370.44 belonged to 5067353. getAccountBalance(db, null) fell through
// to the LEGACY GLOBAL key — a number written by whichever account refreshed
// last, owned by nobody.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { getAccountBalance, getAccountLeverage, DEFAULT_RISK_CONFIG } from './risk.js'

let db
beforeEach(() => { db = initDB(':memory:') })

test('no account named resolves to the SELECTED account, not an unowned global', () => {
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'acct:47790949:account_balance_usd', '48921.88')
  setState(db, 'acct:43097342:account_balance_usd', '1370.44')
  // The legacy key still holds the other account's number — the exact trap.
  setState(db, 'account_balance_usd', '1370.44')
  assert.equal(getAccountBalance(db), 48921.88)
  assert.equal(getAccountBalance(db, '43097342'), 1370.44)
})

test('the legacy global key survives ONLY when there is no selected account', () => {
  setState(db, 'account_balance_usd', '1370.44')
  assert.equal(getAccountBalance(db), 1370.44, 'single-account era is unchanged')
})

test('a selected account with no stamped balance returns unavailable rather than a foreign global', () => {
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'account_balance_usd', '500')
  assert.equal(getAccountBalance(db), null)
  setState(db, 'account_balance_usd', '50000')
  assert.equal(getAccountBalance(db), null)
})

test('selected zero, malformed and negative readings never borrow a global balance', () => {
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'account_balance_usd', '50000')
  for (const [raw, expected] of [['0', 0], ['', null], ['bad', null], ['-1', null], ['Infinity', null], ['25.5', 25.5]]) {
    setState(db, 'acct:47790949:account_balance_usd', raw)
    assert.equal(getAccountBalance(db), expected, raw)
    assert.equal(getAccountBalance(db, '47790949'), expected, raw)
  }
})

test('leverage resolves selected ownership and never borrows a global value for another account', () => {
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'acct:47790949:account_leverage', '200')
  setState(db, 'account_leverage', '25')
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG), 200)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '43097342'), 100, 'missing own value uses the unchanged default, not global 25')
  setState(db, 'account_leverage', '1000')
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '43097342'), 100, 'another account cannot alter this assumption')
  setState(db, 'acct:43097342:account_leverage', '50')
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '43097342'), 50)
})


// B5 (18-09-2026): an account NAMED by the caller reads only its own key.
test('B5: a named account with no stamp returns null — never the shared global', () => {
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'acct:47790949:account_balance_usd', '48921.88')
  setState(db, 'account_balance_usd', '48921.88')
  assert.equal(getAccountBalance(db, '43097342'), null, 'no stamp for …7342 → null, not …0949\'s 48,921.88')
})

test('B5: a named account stamped 0 reads 0 — an unfunded account has no budget', () => {
  setState(db, 'acct:43002148:account_balance_usd', '0')
  setState(db, 'account_balance_usd', '45837.59')
  assert.equal(getAccountBalance(db, '43002148'), 0)
})
