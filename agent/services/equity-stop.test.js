// node --test agent/services/equity-stop.test.js
//
// Owner (2026-07-30): "ensure the account switches is ironclad, sometimes
// autotrade drops from the accounts and I don't see any trades especially
// today."
//
// The headline test is `IRONCLAD`: an equity-stop breach on ONE account must not
// touch the master flag, because account-phases computes
// `effective = master AND (override ?? master)` — so a master write is an
// absolute veto that silently overrides every per-account switch. That is the
// mechanism the owner reported, and it is what these tests pin down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  accountPnlToday, alreadyTrippedToday, evaluateAccount, disarmAccount,
  recordDisarm, trippedKey,
} from './equity-stop.js'
import { effectivePhases, masterPhases, acctPhaseKey } from './account-phases.js'

const A = '43097342'
const B = '46130058'
const DAY_START = '2026-07-30 00:00:00'

function seed(db, rows) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, account_id, net_pnl, closed_at)
     VALUES (?, 'buy', 'closed', ?, ?, ?)`)
  for (const r of rows) ins.run(r.symbol || 'EURUSD', r.account ?? null, r.pnl ?? null, r.closedAt || '2026-07-30 08:00:00')
}
function freshDb() {
  const db = initDB(':memory:')
  setState(db, 'autotrade_enabled', 'true')
  return db
}

// ---------------------------------------------------------------------------
test('IRONCLAD: disarming one account never writes the master flag', () => {
  const db = freshDb()
  setState(db, acctPhaseKey(B, 'autotrade'), 'true')   // owner armed B explicitly

  const key = disarmAccount(db, A)

  assert.equal(key, 'acct:43097342:autotrade_enabled')
  // The disarm no longer writes that agent_state key — it sets the account's
  // MODE (owner 04-08-2026: "do we need to have this extra layer"). Two stores
  // of "may this account enter" could disagree, and did: account selection
  // wrote the mode, the equity stop wrote the flag, and neither saw the other.
  assert.equal(getState(db, key), null, 'the retired per-account flag stays unwritten')
  assert.equal(db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(A).mode, 'manage_only')
  // THE ASSERTION THAT MATTERS. The old code did
  // setState(db, 'autotrade_enabled', 'false') here, which per
  // `effective = master AND (override ?? master)` turned off every account.
  assert.equal(getState(db, 'autotrade_enabled'), 'true', 'master must be untouched')
  assert.equal(masterPhases(db).autotrade, true)

  // A is off, B keeps the switch the owner set, and B is still armed.
  assert.equal(effectivePhases(db, A).autotrade, false)
  assert.equal(effectivePhases(db, B).autotrade, true)
})

test('IRONCLAD: a breach on one account leaves an untouched account armed', () => {
  const db = freshDb()
  // A loses heavily, B is flat.
  seed(db, [{ account: A, pnl: -500 }, { account: B, pnl: 0 }])

  const a = accountPnlToday(db, A, DAY_START)
  const b = accountPnlToday(db, B, DAY_START)
  assert.equal(a.pnl, -500)
  assert.equal(b.pnl, 0, "B must not inherit A's loss")

  const vA = evaluateAccount({ pnl: a.pnl, balance: 1000, stopPct: 0.05, openPositions: 1 })
  const vB = evaluateAccount({ pnl: b.pnl, balance: 1000, stopPct: 0.05, openPositions: 1 })
  assert.equal(vA.breach, true)
  assert.equal(vB.breach, false)

  disarmAccount(db, A)
  assert.equal(effectivePhases(db, A).autotrade, false)
  assert.equal(effectivePhases(db, B).autotrade, true, 'B keeps trading')
})

test('the master remains an absolute veto — the panic button still works', () => {
  const db = freshDb()
  setState(db, acctPhaseKey(A, 'autotrade'), 'true')
  setState(db, 'autotrade_enabled', 'false')          // kill-all / owner
  assert.equal(effectivePhases(db, A).autotrade, false,
    'a per-account ON must never defeat a master OFF')
})

// ---------------------------------------------------------------------------
test('P&L is attributed to ONE account, never charged to all of them', () => {
  const db = freshDb()
  // The row that caused the incident shape: closed, a real loss, NO account.
  seed(db, [{ account: null, pnl: -900 }, { account: A, pnl: -10 }])
  assert.equal(accountPnlToday(db, A, DAY_START).pnl, -10,
    'an unattributed loss must not be charged to A')
  assert.equal(accountPnlToday(db, B, DAY_START).pnl, 0,
    'nor to B')
})

test('unknown (NULL) net_pnl is counted, not silently read as zero', () => {
  const db = freshDb()
  seed(db, [{ account: A, pnl: -50 }, { account: A, pnl: null }, { account: A, pnl: null }])
  const r = accountPnlToday(db, A, DAY_START)
  // SQLite's SUM skips NULLs, so the sum alone understates the day.
  assert.equal(r.pnl, -50)
  assert.equal(r.unknownCount, 2, 'the caller must know the sum is incomplete')
})

test('the unknown count is surfaced in the breach reason', () => {
  const v = evaluateAccount({ pnl: -100, balance: 1000, stopPct: 0.05, openPositions: 1, unknownCount: 3 })
  assert.equal(v.breach, true)
  assert.match(v.reason, /3 closed trade\(s\) with unknown P&L/)
  assert.match(v.reason, /at least this/)
})

test('trades outside the FX day window are excluded', () => {
  const db = freshDb()
  seed(db, [{ account: A, pnl: -900, closedAt: '2026-07-29 08:00:00' }])
  assert.equal(accountPnlToday(db, A, DAY_START).pnl, 0)
})

test('both closed_at timestamp formats are seen', () => {
  const db = freshDb()
  // closeTradeRow writes "YYYY-MM-DD HH:MM:SS"; other paths write ISO with 'T'.
  seed(db, [
    { account: A, pnl: -5, closedAt: '2026-07-30 08:00:00' },
    { account: A, pnl: -7, closedAt: '2026-07-30T09:00:00Z' },
  ])
  assert.equal(accountPnlToday(db, A, DAY_START).pnl, -12,
    'the ISO form must not be silently excluded (the 2026-07-24 bug)')
})

// ---------------------------------------------------------------------------
test('evaluateAccount: no usable cap is not a breach', () => {
  // Acting on a threshold we do not have would close positions on a guess.
  for (const balance of [null, 0, -1, NaN, 'nope']) {
    const v = evaluateAccount({ pnl: -99999, balance, stopPct: 0.05, openPositions: 1 })
    assert.equal(v.breach, false)
    assert.equal(v.cap, null)
  }
})

test('evaluateAccount: falls back to the absolute dollar limit when balance is unknown', () => {
  const v = evaluateAccount({ pnl: -60, balance: null, stopPct: 0.05, fallbackLimit: 50, openPositions: 1 })
  assert.equal(v.breach, true)
  assert.equal(v.cap, 50)
})

test('evaluateAccount: nothing open means nothing for this circuit to do', () => {
  const v = evaluateAccount({ pnl: -500, balance: 1000, stopPct: 0.05, openPositions: 0 })
  assert.equal(v.breach, false, 'the entry veto is risk.js — this one flattens exposure')
})

test('evaluateAccount: exactly at the cap trips, a cent short does not', () => {
  const at = evaluateAccount({ pnl: -50, balance: 1000, stopPct: 0.05, openPositions: 1 })
  const under = evaluateAccount({ pnl: -49.99, balance: 1000, stopPct: 0.05, openPositions: 1 })
  assert.equal(at.breach, true)
  assert.equal(under.breach, false)
})

test('evaluateAccount: a profitable day never trips, whatever the cap', () => {
  const v = evaluateAccount({ pnl: 1234, balance: 1000, stopPct: 0.05, openPositions: 3 })
  assert.equal(v.breach, false)
})

test('evaluateAccount: a negative stopPct cannot invert the comparison', () => {
  // abs() on the cap means a mis-signed config still means "loss of this much".
  const v = evaluateAccount({ pnl: -60, balance: 1000, stopPct: -0.05, openPositions: 1 })
  assert.equal(v.breach, true)
})

// ---------------------------------------------------------------------------
test('the trip marker is per account, so one trip cannot silence another', () => {
  const db = freshDb()
  const dayOpen = Date.parse('2026-07-30T00:00:00Z')
  assert.equal(alreadyTrippedToday(db, A, dayOpen), false)
  disarmAccount(db, A, '2026-07-30T08:00:00Z')
  assert.equal(alreadyTrippedToday(db, A, dayOpen), true)
  assert.equal(alreadyTrippedToday(db, B, dayOpen), false, 'B is still checked')
  assert.equal(getState(db, trippedKey(A)), '2026-07-30T08:00:00Z')
})

test('a trip from a PREVIOUS fx day does not suppress today', () => {
  const db = freshDb()
  disarmAccount(db, A, '2026-07-29T08:00:00Z')
  assert.equal(alreadyTrippedToday(db, A, Date.parse('2026-07-30T00:00:00Z')), false)
})

test('junk in the trip marker reads as not-tripped, so the check still runs', () => {
  const db = freshDb()
  for (const junk of ['', 'nope', 'null']) {
    setState(db, trippedKey(A), junk)
    assert.equal(alreadyTrippedToday(db, A, Date.parse('2026-07-30T00:00:00Z')), false)
  }
})

// ---------------------------------------------------------------------------
test('the disarm is recorded where the owner can see it', () => {
  const db = freshDb()
  recordDisarm(db, { accountId: A, reason: 'equity_stop: test', pnl: -500, cap: 50, positionsClosed: 2 })
  const row = db.prepare("SELECT method, path, body FROM action_log WHERE method='EQUITY_STOP' ORDER BY id DESC LIMIT 1").get()
  assert.equal(row.path, `/equity-stop/${A}`)
  const body = JSON.parse(row.body)
  assert.equal(body.accountId, A)
  assert.equal(body.positionsClosed, 2)
  assert.equal(body.pnl, -500)
  // The old version wrote to stdout only, which is why "I don't see any trades"
  // came with no on-screen reason.
})

test('a failed journal write never blocks the stop', () => {
  const db = freshDb()
  db.prepare('DROP TABLE action_log').run()
  assert.doesNotThrow(() => recordDisarm(db, { accountId: A, reason: 'x', pnl: -1, cap: 1, positionsClosed: 0 }))
})
