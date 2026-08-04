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
//
// EXTENDED 04-08-2026. The A1 fix retained only accounts HOLDING POSITIONS,
// and demoted even those to manage_only. So an armed account that was merely
// flat when the owner clicked another one was silently disabled, and an armed
// account with exposure stopped taking entries — with nothing said either way:
// "it is a wasted opportunities and time, if I don't check mean a few hours
// gone for not trading."
//
// Selection no longer changes ANY other account's arming. What A1 guaranteed
// (the old account stays managed) still holds, and now holds for a flat
// account too — because nothing is released on a switch at all.

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

  // 3. And it KEEPS its arming (04-08-2026). It was active before the switch,
  //    so it is active after: selection is a view, not a disarm. The old
  //    assertion here demanded the opposite — that switching away demote it to
  //    manage_only — which is exactly the behaviour that lost trading hours.
  const autopilot = registryAutopilotAccounts(db).map(a => a.accountId).sort()
  assert.deepEqual(autopilot, [NEW, OLD].sort(), 'both stay armed; only the VIEW moved')
  const oldRow = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(OLD)
  assert.equal(oldRow.mode, 'active')
})

test('switching away from a FLAT account does NOT release it', () => {
  // THE REGRESSION TEST FOR THE HOURS LOST. A flat account is the common case
  // between trades, and it was precisely the case the old rule disabled: it
  // retained only accounts holding positions, so an armed-but-flat account
  // vanished from the enabled set the moment the owner looked at another one.
  const db = seed()
  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  assert.deepEqual(retained, [], 'OLD genuinely holds nothing')
  syncSelectedAccount(db, NEW, false, null, { retainAccountIds: retained })

  const enabled = getEnabledAccounts(db).map(a => a.account_id).sort()
  assert.deepEqual(enabled, [NEW, OLD].sort(), 'a flat armed account survives the switch')
  assert.equal(db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(OLD).mode, 'active')
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

test('a third account keeps the exact state the owner left it in', () => {
  // Neither promoted nor demoted. A manage_only account stays manage_only
  // through a switch — selection must not decide arming in EITHER direction.
  const db = seed()
  const THIRD = '46130058'
  upsertAccount(db, { accountId: THIRD, isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1, mode = 'manage_only' WHERE account_id = ?`).run(THIRD)
  addPosition(db, OLD, 'EURUSD')

  const retained = accountsWithOpenPositions(db).filter(id => id !== NEW)
  syncSelectedAccount(db, NEW, false, null, { retainAccountIds: retained })

  const enabled = getEnabledAccounts(db).map(a => a.account_id).sort()
  assert.deepEqual(enabled, [NEW, OLD, THIRD].sort(), 'nothing is released on a switch')
  const third = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(THIRD)
  assert.equal(third.mode, 'manage_only', 'and nothing is promoted either')
})
