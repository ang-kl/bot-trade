// node --test agent/services/account-equity.test.js
//
// The unowned balance, fixed at the source. See account-equity.js's header for
// the measurement that prompted it: 43002148 and 43069009 both reporting the
// selected account's 35,319.80 because neither had a balance of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { stampAccountEquity, accountsMissingEquity } from './account-equity.js'
import { getAccountBalance, getAccountLeverage, DEFAULT_RISK_CONFIG } from './risk.js'
import { effectiveCapUsd } from './loss-cap.js'

const CREDS = { host: 'demo', clientId: 'i', clientSecret: 's', accessToken: 't' }

function db0(accounts = []) {
  const db = initDB(':memory:')
  for (const [id, isLive] of accounts) {
    db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,?,'active')`)
      .run(String(id), isLive ? 1 : 0)
  }
  return db
}

// A stand-in for lib/ctrader-ws.js — the two functions the stamper uses.
function fakeWs(byAccount) {
  return {
    wsGetTrader: async (_h, _ci, _cs, _at, accountId) => {
      const t = byAccount[String(accountId)]
      if (t instanceof Error) throw t
      return t
    },
    traderBalance: (trader) => trader?.balance ?? null,
  }
}

test('stamps an account under ITS OWN key, never the unowned global', async () => {
  const db = db0([['43002148', false]])
  setState(db, 'account_balance_usd', '35319.8')   // the selected account's, already there

  const r = await stampAccountEquity(db, CREDS, '43002148', {
    ws: fakeWs({ '43002148': { balance: 688.17, leverageInCents: 20000 } }),
    setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v),
  })

  assert.deepEqual({ balance: r.balance, leverage: r.leverage, error: r.error },
    { balance: 688.17, leverage: 200, error: null })
  assert.equal(getState(db, 'acct:43002148:account_balance_usd'), '688.17')
  assert.equal(getState(db, 'account_balance_usd'), '35319.8',
    'the legacy global means "the selected account" — a sweep must not overwrite it')
})

test('THE POINT: once stamped, the account stops inheriting somebody else\'s equity', async () => {
  const db = db0([['46130058', false], ['43002148', false]])
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'account_balance_usd', '35319.8')

  // Before: the production symptom.
  assert.equal(getAccountBalance(db, '43002148'), 35319.8)

  await stampAccountEquity(db, CREDS, '43002148', {
    ws: fakeWs({ '43002148': { balance: 688.17, leverageInCents: 20000 } }),
    setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v),
  })

  // After: its own number, and the selected account is untouched.
  assert.equal(getAccountBalance(db, '43002148'), 688.17)
  assert.equal(getAccountBalance(db, '46130058'), 35319.8)
  assert.equal(getAccountLeverage(db, DEFAULT_RISK_CONFIG, '43002148'), 200)

  // And the safety consequence closes with it: the % cap is priced against
  // real equity instead of being ~51x too permissive to ever bind.
  assert.equal(effectiveCapUsd({ maxLossPctOfBalance: 3 }, getAccountBalance(db, '43002148')),
    688.17 * 0.03)
})

test('a broker failure on one account is reported, not thrown — the sweep continues', async () => {
  const db = db0([['A', false], ['B', false]])
  const set = (d, id, k, v) => setState(d, `acct:${id}:${k}`, v)
  const ws = fakeWs({ A: new Error('CH_ACCESS_TOKEN_INVALID'), B: { balance: 100, leverageInCents: 10000 } })

  const a = await stampAccountEquity(db, CREDS, 'A', { ws, setAccountState: set })
  const b = await stampAccountEquity(db, CREDS, 'B', { ws, setAccountState: set })

  assert.match(a.error, /CH_ACCESS_TOKEN_INVALID/)
  assert.equal(a.balance, null)
  assert.equal(b.balance, 100, 'the next account still stamps')
})

test('an unusable balance is NOT stamped — a present-but-useless key reads as covered', async () => {
  // 0, null and NaN all fail getAccountBalance's `> 0` check, so writing them
  // would leave the key present while the reader still falls through to the
  // global — coverage that looks complete and is not.
  const db = db0([['A', false]])
  const set = (d, id, k, v) => setState(d, `acct:${id}:${k}`, v)
  for (const balance of [0, null, undefined, NaN, -5]) {
    const r = await stampAccountEquity(db, CREDS, 'A', {
      ws: fakeWs({ A: { balance, leverageInCents: 0 } }), setAccountState: set,
    })
    assert.equal(r.balance, null, `balance ${balance} must not be stamped`)
    assert.equal(getState(db, 'acct:A:account_balance_usd'), null)
  }
})

test('accountsMissingEquity names exactly the accounts that would read the global', async () => {
  const db = db0([['46130058', false], ['43002148', true], ['47790949', false]])
  setState(db, 'acct:47790949:account_balance_usd', '45312.41')

  const before = accountsMissingEquity(db, getState)
  assert.deepEqual(before.map(a => a.accountId), ['43002148', '46130058'])
  assert.equal(before.find(a => a.accountId === '43002148').isLive, true, 'live accounts are flagged as such')

  await stampAccountEquity(db, CREDS, '43002148', {
    ws: fakeWs({ '43002148': { balance: 688.17, leverageInCents: 0 } }),
    setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v),
  })
  assert.deepEqual(accountsMissingEquity(db, getState).map(a => a.accountId), ['46130058'])
})
