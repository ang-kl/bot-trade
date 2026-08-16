// node --test agent/services/account-equity.test.js
//
// The unowned balance, fixed at the source. See account-equity.js's header for
// the measurement that prompted it: 43002148 and 43069009 both reporting the
// selected account's 35,319.80 because neither had a balance of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { stampAccountEquity, accountsMissingEquity, sweepCrossSideEquity } from './account-equity.js'
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

// ---------------------------------------------------------------------------
// CROSS-SIDE, READ-ONLY. The loop runs one side at a time, so the other
// side's accounts never had their balance read — and an unstamped account
// answers out of the unowned global.
//
// Measured 2026-08-16 with the session on demo: all three live accounts showed
// lastReconcileAt None, and two of them reported the selected DEMO account's
// 35,319.80 via /state/profit-ratchet while /state/account-engineering showed
// None for the very same accounts.
// ---------------------------------------------------------------------------

test('sweeps only the OTHER side, and stamps each on ITS OWN host', async () => {
  const db = db0([['46130058', false], ['47790949', false], ['43002148', true], ['43069009', true]])
  const hostsAsked = []
  const ws = {
    wsGetTrader: async (host, _ci, _cs, _at, accountId) => {
      hostsAsked.push([String(accountId), host])
      return { balance: { '43002148': 688.17, '43069009': 1234.5 }[String(accountId)], leverageInCents: 30000 }
    },
    traderBalance: (t) => t?.balance ?? null,
  }
  const r = await sweepCrossSideEquity(db, { clientId: 'i', clientSecret: 's', accessToken: 't' }, {
    isLive: false,   // session is DEMO → sweep the LIVE accounts
    deps: { ws, setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v) },
  })

  assert.deepEqual({ swept: r.swept, stamped: r.stamped, failed: r.failed }, { swept: 2, stamped: 2, failed: 0 })
  assert.deepEqual(hostsAsked.map(h => h[0]).sort(), ['43002148', '43069009'],
    'demo accounts are the session\'s own side and must NOT be swept here')
  assert.ok(hostsAsked.every(([, host]) => host === 'live.ctraderapi.com'),
    'a live account is only reachable on the live host')
  assert.equal(getState(db, 'acct:43002148:account_balance_usd'), '688.17')
  assert.equal(getState(db, 'acct:43069009:account_balance_usd'), '1234.5')
})

test('THE POINT: the live accounts stop inheriting the demo account\'s balance', async () => {
  const db = db0([['46130058', false], ['43002148', true], ['43069009', true]])
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'account_balance_usd', '35319.8')

  // The production symptom, before.
  assert.equal(getAccountBalance(db, '43002148'), 35319.8)
  assert.equal(getAccountBalance(db, '43069009'), 35319.8)

  await sweepCrossSideEquity(db, {}, {
    isLive: false,
    deps: {
      ws: fakeWs({ '43002148': { balance: 688.17, leverageInCents: 0 },
                   '43069009': { balance: 1234.5, leverageInCents: 0 } }),
      setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v),
    },
  })

  assert.equal(getAccountBalance(db, '43002148'), 688.17)
  assert.equal(getAccountBalance(db, '43069009'), 1234.5)
  assert.notEqual(getAccountBalance(db, '43002148'), getAccountBalance(db, '43069009'),
    'and they no longer agree with each other, which was the tell')
  assert.equal(getState(db, 'account_balance_usd'), '35319.8', 'the global is still the selected account\'s')
})

test('one unreachable account does not stop the others, and is counted as failed', async () => {
  const db = db0([['DEMO', false], ['L1', true], ['L2', true]])
  const r = await sweepCrossSideEquity(db, {}, {
    isLive: false,
    deps: {
      ws: fakeWs({ L1: new Error('CH_ACCESS_TOKEN_INVALID'), L2: { balance: 50, leverageInCents: 0 } }),
      setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v),
    },
  })
  assert.deepEqual({ swept: r.swept, stamped: r.stamped, failed: r.failed }, { swept: 2, stamped: 1, failed: 1 })
  assert.equal(getState(db, 'acct:L2:account_balance_usd'), '50')
})

test('a LIVE session sweeps the DEMO accounts — the rule is "other side", not "live"', async () => {
  const db = db0([['LIVEACC', true], ['DEMOACC', false]])
  const hosts = []
  const ws = {
    wsGetTrader: async (host, _a, _b, _c, id) => { hosts.push([String(id), host]); return { balance: 7, leverageInCents: 0 } },
    traderBalance: (t) => t?.balance ?? null,
  }
  const r = await sweepCrossSideEquity(db, {}, {
    isLive: true,
    deps: { ws, setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v) },
  })
  assert.equal(r.swept, 1)
  assert.deepEqual(hosts, [['DEMOACC', 'demo.ctraderapi.com']])
})

test('disabled accounts are never touched', async () => {
  const db = db0([['DEMO', false], ['LIVE_ON', true]])
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES ('LIVE_OFF',0,1,'active')`).run()
  const seen = []
  const ws = {
    wsGetTrader: async (_h, _a, _b, _c, id) => { seen.push(String(id)); return { balance: 1, leverageInCents: 0 } },
    traderBalance: (t) => t?.balance ?? null,
  }
  await sweepCrossSideEquity(db, {}, { isLive: false, deps: { ws, setAccountState: (d, id, k, v) => setState(d, `acct:${id}:${k}`, v) } })
  assert.deepEqual(seen, ['LIVE_ON'], 'an account the owner disabled must not be probed')
})
