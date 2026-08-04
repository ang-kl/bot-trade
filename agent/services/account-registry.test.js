// node --test agent/services/account-registry.test.js
//
// Account Registry (multi-account plan M0 shim): the compatibility
// invariants that keep the registry behaviour-identical to today's
// single-account state keys — exactly one enabled row, sole-enabled swap on
// select, and a loop-facing accounts list shaped like the legacy roles.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  ensureAccountRegistry,
  syncSelectedAccount,
  upsertAccount,
  listAccounts,
  getEnabledAccounts,
  registryAutopilotAccounts,
  backfillAccountIds,
  setAccountEnabled,
} from './account-registry.js'

const fresh = () => initDB(':memory:')

test('ensureAccountRegistry: bootstraps the current legacy account as the single enabled row', () => {
  const db = fresh()
  setState(db, 'ctrader_account_id', '47790949')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'ctrader_trader_login', '5306502')
  const r = ensureAccountRegistry(db)
  assert.equal(r.total, 1)
  assert.equal(r.enabled, '47790949')
  const rows = listAccounts(db)
  assert.equal(rows[0].trader_login, '5306502')
  assert.equal(rows[0].enabled, 1)
  assert.equal(rows[0].mode, 'active')
  // Idempotent: a second boot changes nothing.
  const r2 = ensureAccountRegistry(db)
  assert.equal(r2.total, 1)
  assert.equal(r2.enabled, '47790949')
})

test('ensureAccountRegistry: a later boot does not resurrect a disarmed account', () => {
  const db = fresh()
  setState(db, 'ctrader_account_id', 'A')
  ensureAccountRegistry(db)
  setAccountEnabled(db, 'A', false)          // the owner disarmed A deliberately
  syncSelectedAccount(db, 'B', true)
  setState(db, 'ctrader_account_id', 'B')
  ensureAccountRegistry(db)
  const enabled = getEnabledAccounts(db).map(a => a.account_id)
  assert.deepEqual(enabled, ['B'], 'the boot bootstrap only runs when NOTHING is enabled')
})

// ---------------------------------------------------------------------------
// THE SOLE-ENABLED SWAP IS RETIRED (owner 04-08-2026)
//
// "autotrade disarmed again or switch to manage-only … it is a wasted
// opportunities and time, if I don't check mean a few hours gone for not
// trading."
//
// Selecting an account used to disable or demote every other one, keeping only
// the accounts that happened to hold open positions at that instant. Nothing
// promoted them back and nothing said it had happened. Selection is a VIEW
// now; arming is a separate, deliberate state.
// ---------------------------------------------------------------------------

test('selecting an account does NOT disarm any other account', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  upsertAccount(db, { accountId: 'B', isLive: true })
  upsertAccount(db, { accountId: 'C', isLive: false })
  setAccountEnabled(db, 'A', true, 'active')
  setAccountEnabled(db, 'C', true, 'active')

  syncSelectedAccount(db, 'B', true, '1251247')

  const rows = Object.fromEntries(listAccounts(db).map(a => [a.account_id, a]))
  assert.equal(rows.A.enabled, 1, 'A was armed before the switch and must still be')
  assert.equal(rows.A.mode, 'active')
  assert.equal(rows.C.enabled, 1)
  assert.equal(rows.C.mode, 'active')
  // …and the selected account is armed, so selecting one you mean to trade is
  // not two gestures.
  assert.equal(rows.B.enabled, 1)
  assert.equal(rows.B.mode, 'active')
  assert.equal(rows.B.trader_login, '1251247')
})

test('a FLAT armed account survives a switch — the exact case that lost hours', () => {
  // The old rule retained only accounts holding open positions, so an armed
  // account that was merely between trades when the owner clicked another one
  // was silently set enabled = 0, mode = manage_only.
  const db = fresh()
  upsertAccount(db, { accountId: 'FLAT', isLive: false })
  setAccountEnabled(db, 'FLAT', true, 'active')
  syncSelectedAccount(db, 'OTHER', false)
  const flat = listAccounts(db).find(a => a.account_id === 'FLAT')
  assert.equal(flat.enabled, 1)
  assert.equal(flat.mode, 'active')
})

test('a DISARMED account is not armed by selecting something else', () => {
  // The reverse guarantee: selection must not promote either.
  const db = fresh()
  upsertAccount(db, { accountId: 'OFF', isLive: false })
  setAccountEnabled(db, 'OFF', false)
  syncSelectedAccount(db, 'OTHER', false)
  const off = listAccounts(db).find(a => a.account_id === 'OFF')
  assert.equal(off.enabled, 0)
  assert.equal(off.mode, 'manage_only')
})

test('upsertAccount: enriches metadata without touching enabled/mode', () => {
  const db = fresh()
  syncSelectedAccount(db, 'A', false)
  upsertAccount(db, { accountId: 'A', traderLogin: '5306502', baseCurrency: 'USD', leverage: 25, brokerLabel: 'Pepperstone' })
  const a = listAccounts(db)[0]
  assert.equal(a.enabled, 1, 'metadata upsert must not disable the account')
  assert.equal(a.mode, 'active')
  assert.equal(a.base_currency, 'USD')
  assert.equal(a.leverage, 25)
  assert.equal(a.broker_label, 'Pepperstone')
})

test('registryAutopilotAccounts: legacy roles shape; paused/param-disabled rows excluded', () => {
  const db = fresh()
  syncSelectedAccount(db, 'A', true)
  assert.deepEqual(registryAutopilotAccounts(db), [{ accountId: 'A', isLive: true, autopilot: true }])
  // params.autopilot=false opts an enabled account out of autotrade.
  db.prepare(`UPDATE accounts SET params = '{"autopilot":false}' WHERE account_id = 'A'`).run()
  assert.deepEqual(registryAutopilotAccounts(db), [])
  // A paused account is enabled but not active → excluded.
  db.prepare(`UPDATE accounts SET params = '{}', mode = 'paused' WHERE account_id = 'A'`).run()
  assert.deepEqual(registryAutopilotAccounts(db), [])
})

test('backfillAccountIds: stamps historical NULL rows once, leaves global tables alone', () => {
  const db = fresh()
  setState(db, 'ctrader_account_id', 'ACC1')
  db.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'closed')`).run()
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, created_at) VALUES ('EURUSD', 'BUY', 0, datetime('now'))`).run()
  db.prepare(`INSERT INTO scans (symbol, scanned_at) VALUES ('EURUSD', datetime('now'))`).run()
  const r = backfillAccountIds(db)
  assert.equal(r.backfilled, 2)
  assert.equal(db.prepare(`SELECT account_id FROM trades`).get().account_id, 'ACC1')
  assert.equal(db.prepare(`SELECT account_id FROM risk_events`).get().account_id, 'ACC1')
  // scans stay NULL — account-independent market observations by design.
  assert.equal(db.prepare(`SELECT account_id FROM scans`).get().account_id, null)
  // Idempotent: a later row is NOT swept up by a re-run.
  db.prepare(`INSERT INTO trades (symbol, status) VALUES ('GBPUSD', 'closed')`).run()
  assert.deepEqual(backfillAccountIds(db), { skipped: 'done' })
  assert.equal(db.prepare(`SELECT account_id FROM trades WHERE symbol='GBPUSD'`).get().account_id, null)
})

test('backfillAccountIds: waits for an account id instead of stamping garbage', () => {
  const db = fresh()
  db.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'closed')`).run()
  assert.equal(backfillAccountIds(db).skipped, 'no account selected yet')
  // Flag NOT set — a later boot with an account id still backfills.
  setState(db, 'ctrader_account_id', 'ACC9')
  assert.equal(backfillAccountIds(db).backfilled, 1)
})

test('persistRiskEvent stamps the deciding account (proposal override wins)', async () => {
  const { persistRiskEvent } = await import('./risk.js')
  const db = fresh()
  setState(db, 'ctrader_account_id', 'SEL')
  persistRiskEvent(db, { symbol: 'EURUSD', side: 'BUY' }, { approved: false, veto_reason: 'x', checks: {} })
  persistRiskEvent(db, { symbol: 'EURUSD', side: 'BUY', accountId: 'OTHER' }, { approved: true, checks: {} })
  const rows = db.prepare(`SELECT account_id FROM risk_events ORDER BY id`).all()
  assert.equal(rows[0].account_id, 'SEL')
  assert.equal(rows[1].account_id, 'OTHER')
})

test('M4 setAccountEnabled: lifts sole-enabled, refuses unknown ids, modes validated', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'A')
  syncSelectedAccount(db, 'A', false, '111')
  upsertAccount(db, { accountId: 'B', traderLogin: '222', isLive: false })
  // Enable B alongside A — two enabled rows now coexist.
  const out = setAccountEnabled(db, 'B', true)
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'active')
  const enabled = getEnabledAccounts(db).map(a => a.account_id).sort()
  assert.deepEqual(enabled, ['A', 'B'])
  // A stays selected/primary; roles include both.
  assert.equal(registryAutopilotAccounts(db).length, 2)
  // Disable B → back to sole-enabled without touching A.
  assert.equal(setAccountEnabled(db, 'B', false).mode, 'manage_only')
  assert.deepEqual(getEnabledAccounts(db).map(a => a.account_id), ['A'])
  // Unknown id refused; bad mode refused.
  assert.equal(setAccountEnabled(db, 'ZZZ', true).ok, false)
  assert.equal(setAccountEnabled(db, 'B', true, 'bogus').ok, false)
})

// ---------------------------------------------------------------------------
// DISCOVERY REGISTERS, IT DOES NOT ENABLE (2026-07-29).
//
// POST /actions/ctrader-accounts now upserts every account the broker returns,
// because browsing the list used to leave no trace: an account entered the
// registry only when SELECTED or role-pushed, so everything registry-backed —
// the roster, per-account watchlists, the compare & copy panel — could not see
// an account the operator had never selected. Owner, of their live account:
// "How come cannot see the live account?" Because it had never been selected.
//
// That is only safe because registering is not enabling. These pin it: a
// discovered account arrives disabled and manage_only, and an upsert NEVER
// touches the flags of a row that already exists. Get this wrong and merely
// opening the Connect page would arm a live account.
// ---------------------------------------------------------------------------

test('a newly discovered account arrives DISABLED and manage_only', () => {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: '1251247', traderLogin: '1251247', isLive: true, brokerLabel: 'Pepperstone' })

  const row = db.prepare('SELECT * FROM accounts WHERE account_id = ?').get('1251247')
  assert.ok(row, 'discovery registers it')
  assert.equal(row.enabled, 0, 'visible, NOT tradeable')
  assert.equal(row.mode, 'manage_only')
  assert.equal(row.is_live, 1)
  assert.equal(row.trader_login, '1251247')
})

test('re-discovery never re-flags an account that is already enabled', () => {
  // The Connect page can be opened at any time, including while the account
  // it lists is actively trading. An upsert that reset enabled/mode would
  // silently disarm a running account — or arm a disabled one.
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: '46130058', isLive: false })
  setAccountEnabled(db, '46130058', true, 'active')

  upsertAccount(db, { accountId: '46130058', traderLogin: '5203012', isLive: false, brokerLabel: 'Pepperstone' })

  const row = db.prepare('SELECT * FROM accounts WHERE account_id = ?').get('46130058')
  assert.equal(row.enabled, 1, 'still enabled')
  assert.equal(row.mode, 'active', 'still active')
  assert.equal(row.trader_login, '5203012', 'metadata DID refresh')
})

test('discovering a LIVE account does not make it the selected one', () => {
  // The strongest version of the same guarantee: listing accounts must never
  // change which account the bot trades.
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '46130058')
  upsertAccount(db, { accountId: '1251247', isLive: true })

  assert.equal(getState(db, 'ctrader_account_id'), '46130058')
  assert.equal(db.prepare('SELECT enabled FROM accounts WHERE account_id = ?').get('1251247').enabled, 0)
})
