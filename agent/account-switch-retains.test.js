// node --test agent/account-switch-retains.test.js
//
// A1 (owner 2026-07-28): switching accounts must not abandon the account you
// switch away from. Before this, /actions/ctrader-select-account closed the
// old account's monitored_positions outright and disabled its registry row,
// so trailing stops, the per-position loss cap, the profit ratchet and time
// caps all stopped for positions that were still OPEN at the broker.
//
// The owner's decision was "switching away from an account with open
// positions should be okay, don't have to warn" — which is only true if the
// old account keeps being managed. These tests are that guarantee.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, accountsWithOpenPositions, sweepMonitoredPositionsForAccounts } from './db.js'
import { upsertAccount, syncSelectedAccount, getEnabledAccounts, registryAutopilotAccounts } from './services/account-registry.js'

const OLD = '43097342'
const NEW = '46979908'

function seed() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: OLD, isLive: false })
  upsertAccount(db, { accountId: NEW, isLive: false })
  syncSelectedAccount(db, OLD, false) // OLD is the selected/active account
  return db
}

function addPosition(db, accountId, symbol) {
  db.prepare(
    `INSERT INTO monitored_positions (symbol, status, account_id) VALUES (?, 'active', ?)`
  ).run(symbol, accountId)
}

test('accountsWithOpenPositions reports only attributable, active exposure', () => {
  const db = seed()
  addPosition(db, OLD, 'EURUSD')
  addPosition(db, OLD, 'XAUUSD')
  addPosition(db, NEW, 'GBPUSD')
  // closed rows are not exposure
  db.prepare(`INSERT INTO monitored_positions (symbol, status, account_id) VALUES ('USDJPY', 'closed', ?)`).run(OLD)
  // an unattributable legacy row is not evidence that any account has exposure
  db.prepare(`INSERT INTO monitored_positions (symbol, status, account_id) VALUES ('AUDUSD', 'active', NULL)`).run()

  assert.deepEqual(accountsWithOpenPositions(db).sort(), [OLD, NEW].sort())
})

test('switching away KEEPS the old account managed while it holds positions', () => {
  const db = seed()
  addPosition(db, OLD, 'EURUSD')

  // What the route does on a switch OLD → NEW.
  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  assert.deepEqual(retained, [OLD], 'the old account must be recognised as still holding exposure')
  sweepMonitoredPositionsForAccounts(db, [NEW, ...retained])
  syncSelectedAccount(db, NEW, false, null, { retainAccountIds: retained })

  // 1. Its position is STILL being monitored — this is the whole point.
  const still = db.prepare(
    `SELECT COUNT(*) c FROM monitored_positions WHERE status='active' AND account_id = ?`
  ).get(OLD).c
  assert.equal(still, 1, 'the old account\'s open position must remain actively monitored')

  // 2. It stays in the enabled set, so the reconciler and sidecar still cover it.
  const enabled = getEnabledAccounts(db).map(a => a.account_id)
  assert.ok(enabled.includes(OLD), `old account must stay enabled, got ${JSON.stringify(enabled)}`)
  assert.ok(enabled.includes(NEW), 'new account must be enabled')

  // 3. But it must NOT be dispatched new entries — manage, don't trade.
  const autopilot = registryAutopilotAccounts(db).map(a => a.accountId)
  assert.deepEqual(autopilot, [NEW], 'only the newly selected account may take new entries')
  const oldRow = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(OLD)
  assert.equal(oldRow.mode, 'manage_only')
})

test('switching away from a FLAT account fully releases it', () => {
  const db = seed()
  // OLD holds nothing.
  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  assert.deepEqual(retained, [], 'a flat account is not retained')
  syncSelectedAccount(db, NEW, false, null, { retainAccountIds: retained })

  const enabled = getEnabledAccounts(db).map(a => a.account_id)
  assert.deepEqual(enabled, [NEW], 'a flat old account should not linger in the enabled set')
})

test('unattributable NULL rows are still swept — they leak across accounts', () => {
  // The risk gate accepts `account_id IS NULL` for every account
  // (services/risk.js:357, :757), so a NULL row would gate the new account's
  // position limits. Those must still be cleared on a switch.
  const db = seed()
  addPosition(db, OLD, 'EURUSD')
  db.prepare(`INSERT INTO monitored_positions (symbol, status, account_id) VALUES ('AUDUSD', 'active', NULL)`).run()

  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  sweepMonitoredPositionsForAccounts(db, [NEW, ...retained])

  const nulls = db.prepare(`SELECT COUNT(*) c FROM monitored_positions WHERE status='active' AND account_id IS NULL`).get().c
  assert.equal(nulls, 0, 'unattributable active rows must be swept')
  const kept = db.prepare(`SELECT COUNT(*) c FROM monitored_positions WHERE status='active' AND account_id = ?`).get(OLD).c
  assert.equal(kept, 1, 'sweeping NULLs must not touch the retained account')
})

test('a third account with no exposure is released even while another is retained', () => {
  const db = seed()
  const THIRD = '46130058'
  upsertAccount(db, { accountId: THIRD, isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1, mode = 'manage_only' WHERE account_id = ?`).run(THIRD)
  addPosition(db, OLD, 'EURUSD') // only OLD holds anything

  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  syncSelectedAccount(db, NEW, false, null, { retainAccountIds: retained })

  const enabled = getEnabledAccounts(db).map(a => a.account_id).sort()
  assert.deepEqual(enabled, [NEW, OLD].sort(), `THIRD holds nothing and must be released, got ${JSON.stringify(enabled)}`)
})
