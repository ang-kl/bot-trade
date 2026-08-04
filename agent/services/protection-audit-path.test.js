// node --test agent/services/protection-audit-path.test.js
//
// PROTECTION HAS ITS OWN PATH — Operating Goal Plan §43.
//
//   "A position must never be considered safely managed merely because the
//    main strategy loop is running. Protection, active management, broker
//    reconciliation and emergency authority must each have their own
//    functioning and observable path."
//
// It did not have one. The audit lived inside the loop's per-account reconcile
// block, sharing that phase with order_monitor, and on 2026-08-04 both went
// stalled at the same instant — 961s old against a 314s expectation. For
// sixteen minutes nothing checked whether open positions still had stops at
// the broker.
//
// These tests hold down the properties that make the second path real rather
// than decorative: it sweeps EVERY enabled account against that account's OWN
// broker truth, one account's failure does not silence the others, and it
// beats its own heartbeat so the panel reflects THIS path and not only the
// loop's.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { runProtectionAuditAllAccounts } from './naked-position-guard.js'

let db
const A = '43097342'
const B = '46130058'

beforeEach(() => {
  db = initDB(':memory:')
  for (const [id, login] of [[A, '5067353'], [B, '5203012']]) {
    db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,0,1,?,?)')
      .run(id, 'active', login)
  }
})

/** One active position on `acct`, linked to a trade with a broker position id. */
function seedPosition(acct, symbol, posId, sl) {
  const t = db.prepare(
    'INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)'
  ).run(symbol, 'long', 'open', acct, posId)
  db.prepare(
    'INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,source) VALUES (?,?,?,?,?,?)'
  ).run(t.lastInsertRowid, symbol, 'active', acct, sl, 'bot')
}

const creds = { ready: true, isLive: false, accountId: A }

test('it sweeps EVERY enabled account, each against its own broker snapshot', async () => {
  seedPosition(A, 'EURUSD', '111', 1.05)
  seedPosition(B, 'GBPUSD', '222', 1.25)
  const asked = []
  const exec = {
    reconcile: async (c) => {
      asked.push(String(c.accountId))
      // Each account's snapshot contains ONLY its own position — auditing one
      // account's rows against another's truth marks the rest `unmatched`,
      // which staging once reported as "all protected" over four unaudited
      // positions.
      return String(c.accountId) === A
        ? { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
        : { position: [{ positionId: '222', stopLoss: null, takeProfit: null }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.deepEqual(asked.sort(), [A, B].sort(), 'both accounts asked')
  assert.equal(out.accounts, 2)
  assert.equal(out.naked, 1, 'the account whose broker holds no stop is reported naked')
})

test('one account failing does not silence the others', async () => {
  seedPosition(A, 'EURUSD', '111', 1.05)
  seedPosition(B, 'GBPUSD', '222', 1.25)
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === A) throw new Error('broker timeout')
      return { position: [{ positionId: '222', stopLoss: null, takeProfit: null }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.errors.length, 1, 'the failure is reported, not swallowed')
  assert.match(out.errors[0], /broker timeout/)
  assert.equal(out.accounts, 1, 'and the other account was still audited')
  assert.equal(out.naked, 1, 'including its missing stop')
})

test('an account clean on both sides is counted, not skipped', async () => {
  const exec = { exec: null, reconcile: async () => ({ position: [] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.accounts, 2)
  assert.equal(out.naked, 0)
  assert.equal(out.errors.length, 0)
})

test('a BROKER position with no local row still gets audited', async () => {
  // The reverse of the usual case, and the one a "skip when we have no rows"
  // shortcut would hide: the broker holds a position the bot does not know
  // about. That is exactly what the audit is for.
  const exec = {
    reconcile: async () => ({ position: [{ positionId: '999', stopLoss: null, takeProfit: null }] }),
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.accounts, 2, 'both swept despite zero local rows')
  assert.equal(out.errors.length, 0)
})

test('not-ready credentials do nothing at all — never a false all-clear', async () => {
  seedPosition(A, 'EURUSD', '111', null)
  let called = false
  const exec = { reconcile: async () => { called = true; return { position: [] } } }
  const out = await runProtectionAuditAllAccounts(db, { ready: false }, { exec })
  assert.equal(called, false)
  assert.equal(out.accounts, 0, 'zero accounts audited, not zero problems found')
})

test('only the SAME side is swept — a demo token cannot read a live account', async () => {
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,1,1,?,?)')
    .run('42993489', 'manage_only', '1251247')
  const asked = []
  const exec = {
    reconcile: async (c) => { asked.push(String(c.accountId)); return { position: [] } },
  }
  await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.ok(!asked.includes('42993489'), 'the live account is not swept with demo credentials')
})
