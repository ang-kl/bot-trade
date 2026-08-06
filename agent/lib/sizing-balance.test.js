// node --test agent/lib/sizing-balance.test.js
//
// THE REGRESSION THIS PINS, in the owner's own numbers (2026-08-06):
// the same 5,000-unit 0003.HK position on a USD 46,073 account and a USD 1,984
// account, risking USD 149 on both — 0.3% of one and 7.5× the other's budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { sizingBalance, riskBudgetMultiple, overBudget } from './sizing-balance.js'

const fresh = () => initDB(':memory:')

test('an account with its own stamped balance sizes against that balance', () => {
  const db = fresh()
  setState(db, 'acct:43097342:account_balance_usd', '1983.52')
  const r = sizingBalance(db, '43097342')
  assert.deepEqual(r, { balance: 1983.52, source: 'account', ok: true, accountId: '43097342', reason: null })
})

test('an account with NO stamped balance must not borrow another account\'s', () => {
  // THE HAZARD. The legacy global key is "whatever account refreshed it last".
  // Sizing 43097342 against 46130058's equity multiplies every configured risk
  // percentage by 23 — and every downstream number is computed from the same
  // wrong balance, so they all agree with each other.
  const db = fresh()
  setState(db, 'account_balance_usd', '46072.92')   // the big account refreshed last
  const r = sizingBalance(db, '43097342')
  assert.equal(r.ok, false, 'must NOT be usable for sizing')
  assert.equal(r.source, 'legacy')
  assert.equal(r.balance, 46072.92, 'the value is still reported — the caller must see what it refused')
  assert.match(r.reason, /belongs to whichever account refreshed it last/)
})

test('no balance at all is refused, and says so differently from a borrowed one', () => {
  const db = fresh()
  const r = sizingBalance(db, '43097342')
  assert.equal(r.ok, false)
  assert.equal(r.source, 'none')
  assert.equal(r.balance, null)
  assert.match(r.reason, /no balance recorded for account 43097342/)
})

test('with no account named, the SELECTED account\'s own stamp is used', () => {
  const db = fresh()
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'acct:46130058:account_balance_usd', '46072.92')
  setState(db, 'account_balance_usd', '1.23')     // stale legacy value must lose
  const r = sizingBalance(db)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'selected')
  assert.equal(r.balance, 46072.92)
  assert.equal(r.accountId, '46130058')
})

test('a zero or malformed stamp is treated as absent, not as a balance of zero', () => {
  const db = fresh()
  setState(db, 'acct:43097342:account_balance_usd', '0')
  const r = sizingBalance(db, '43097342')
  assert.equal(r.ok, false)
  setState(db, 'acct:43097342:account_balance_usd', 'not-a-number')
  assert.equal(sizingBalance(db, '43097342').ok, false)
})

// ---------------------------------------------------------------------------
// The multiple — the number that makes the finding legible
// ---------------------------------------------------------------------------

test('riskBudgetMultiple reproduces the owner\'s two readings exactly', () => {
  // 0003.HK, USD 149 at risk, on each account's own 1% budget.
  assert.equal(riskBudgetMultiple(148.72, 46072.92 * 0.01), 0.32)
  assert.equal(riskBudgetMultiple(148.72, 1983.52 * 0.01), 7.5)
})

test('overBudget tolerates a volume step, not a multiple', () => {
  const budget = 19.84
  assert.equal(overBudget(148.72, budget), true, 'the 7.5x case must flag')
  assert.equal(overBudget(20.5, budget), false, 'a broker minimum lot landing 3% over is not a defect')
  assert.equal(overBudget(22.5, budget), true, '13% over is past the slack')
  assert.equal(overBudget(19.84, budget), false)
})

test('an unusable budget yields null rather than a confident ratio', () => {
  assert.equal(riskBudgetMultiple(100, 0), null)
  assert.equal(riskBudgetMultiple(100, null), null)
  assert.equal(riskBudgetMultiple(null, 100), null)
  assert.equal(overBudget(100, 0), false, 'and cannot flag on a budget it does not know')
})

// ---------------------------------------------------------------------------
// The risk gate records whose balance it used
// ---------------------------------------------------------------------------

test('every verdict says whether the balance belonged to the account it sized', async () => {
  const { evaluateTrade } = await import('../services/risk.js')
  const db = fresh()
  setState(db, 'account_balance_usd', '46072.92')          // the big account refreshed last
  const proposal = { symbol: 'EURUSD', bias: 'long', entry: 1.1, sl: 1.09, tp1: 1.13, accountId: '43097342' }

  const borrowed = evaluateTrade(db, proposal)
  assert.equal(borrowed.checks.balance_source, 'legacy')
  assert.equal(borrowed.checks.balance_is_account_scoped, false)
  assert.match(borrowed.checks.balance_scope_warning, /43097342/)

  setState(db, 'acct:43097342:account_balance_usd', '1983.52')
  const owned = evaluateTrade(db, proposal)
  assert.equal(owned.checks.balance_source, 'account')
  assert.equal(owned.checks.balance_is_account_scoped, true)
  assert.equal(owned.checks.balance_scope_warning, undefined)
})
