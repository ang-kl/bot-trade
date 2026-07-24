// node --test agent/services/account-registry.test.js
//
// Account Registry (multi-account plan M0 shim): the compatibility
// invariants that keep the registry behaviour-identical to today's
// single-account state keys — exactly one enabled row, sole-enabled swap on
// select, and a loop-facing accounts list shaped like the legacy roles.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  ensureAccountRegistry,
  syncSelectedAccount,
  upsertAccount,
  listAccounts,
  getEnabledAccounts,
  registryAutopilotAccounts,
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

test('ensureAccountRegistry: never re-enables when a row is already enabled', () => {
  const db = fresh()
  setState(db, 'ctrader_account_id', 'A')
  ensureAccountRegistry(db)
  // Operator later switched to B; state key follows, registry synced:
  syncSelectedAccount(db, 'B', true)
  setState(db, 'ctrader_account_id', 'B')
  // A later boot must keep B enabled, not resurrect A.
  ensureAccountRegistry(db)
  const enabled = getEnabledAccounts(db)
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].account_id, 'B')
})

test('syncSelectedAccount: M0 sole-enabled swap — exactly one enabled row, others manage_only', () => {
  const db = fresh()
  upsertAccount(db, { accountId: 'A', isLive: false })
  upsertAccount(db, { accountId: 'B', isLive: true })
  upsertAccount(db, { accountId: 'C', isLive: false })
  syncSelectedAccount(db, 'B', true, '1251247')
  let enabled = getEnabledAccounts(db)
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].account_id, 'B')
  assert.equal(enabled[0].is_live, 1)
  assert.equal(enabled[0].trader_login, '1251247')
  // Swap again — the invariant holds and the old row demotes to manage_only.
  syncSelectedAccount(db, 'C', false)
  enabled = getEnabledAccounts(db)
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].account_id, 'C')
  const b = listAccounts(db).find(a => a.account_id === 'B')
  assert.equal(b.enabled, 0)
  assert.equal(b.mode, 'manage_only')
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
