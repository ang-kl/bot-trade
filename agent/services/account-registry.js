// ---------------------------------------------------------------------------
// agent/services/account-registry.js — the Account Registry (multi-account
// migration plan, milestone M0: the compatibility shim).
//
// Single source of truth for which cTrader accounts exist and which may
// trade. In M0 the registry deliberately mirrors today's single-account
// behaviour byte-for-byte: exactly ONE row is enabled at any time (the
// account `ctrader_account_id` points at), and selecting an account in the
// UI performs the same sole-enabled swap the legacy state keys perform.
// Later milestones (M1+) lift the one-enabled invariant, add per-account
// workers, and make disable/pause first-class — see
// docs/multi-account-migration-plan.md.
//
// This module is the ONLY writer of the `accounts` table (plan P2: one
// writer). Everything else reads.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

const now = () => new Date().toISOString()

function parseParams(raw) {
  try {
    const p = JSON.parse(raw || '{}')
    return p && typeof p === 'object' ? p : {}
  } catch { return {} }
}

/** All registry rows, params parsed, stable order (live first, then id). */
export function listAccounts(db) {
  const rows = db.prepare(
    'SELECT * FROM accounts ORDER BY is_live DESC, account_id'
  ).all()
  return rows.map(r => ({ ...r, params: parseParams(r.params) }))
}

/** Enabled rows only — the accounts allowed to trade right now. */
export function getEnabledAccounts(db) {
  return listAccounts(db).filter(a => a.enabled === 1)
}

/**
 * Upsert one account row WITHOUT touching its enabled/mode flags — used to
 * enrich the registry from broker data (account list pushes, select-time
 * lookups). Only identity/metadata fields update.
 */
export function upsertAccount(db, { accountId, traderLogin = null, brokerLabel = null, isLive = null, baseCurrency = null, leverage = null }) {
  if (accountId == null) return
  const id = String(accountId)
  const existing = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?').get(id)
  if (existing) {
    db.prepare(`
      UPDATE accounts SET
        trader_login  = COALESCE(?, trader_login),
        broker_label  = COALESCE(?, broker_label),
        is_live       = COALESCE(?, is_live),
        base_currency = COALESCE(?, base_currency),
        leverage      = COALESCE(?, leverage),
        updated_at    = ?
      WHERE account_id = ?
    `).run(
      traderLogin != null ? String(traderLogin) : null,
      brokerLabel,
      isLive == null ? null : (isLive ? 1 : 0),
      baseCurrency,
      leverage != null ? Math.round(Number(leverage)) : null,
      now(), id,
    )
  } else {
    db.prepare(`
      INSERT INTO accounts (account_id, trader_login, broker_label, is_live, base_currency, leverage, enabled, mode, params, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'manage_only', '{}', ?, ?)
    `).run(
      id,
      traderLogin != null ? String(traderLogin) : null,
      brokerLabel || 'cTrader',
      isLive ? 1 : 0,
      baseCurrency,
      leverage != null ? Math.round(Number(leverage)) : null,
      now(), now(),
    )
  }
}

/**
 * M0 sole-enabled swap: make `accountId` the ONE enabled/active account and
 * every other row manage_only — the registry mirror of what
 * /actions/ctrader-select-account already does to the legacy state keys.
 * Creates the row if the id is new.
 */
export function syncSelectedAccount(db, accountId, isLive, traderLogin = null) {
  if (accountId == null) return
  upsertAccount(db, { accountId, traderLogin, isLive })
  db.prepare(`UPDATE accounts SET enabled = 0, mode = 'manage_only', updated_at = ? WHERE enabled = 1 AND account_id != ?`)
    .run(now(), String(accountId))
  db.prepare(`UPDATE accounts SET enabled = 1, mode = 'active', is_live = ?, updated_at = ? WHERE account_id = ?`)
    .run(isLive ? 1 : 0, now(), String(accountId))
}

/**
 * Boot-time bootstrap (idempotent): guarantee the currently-selected legacy
 * account exists in the registry and, when NO row is enabled yet (fresh
 * migration), enable exactly that one — so the very first boot after this
 * table appears behaves identically to the boot before it.
 */
export function ensureAccountRegistry(db) {
  const id = getState(db, 'ctrader_account_id')
  const isLive = getState(db, 'ctrader_is_live') === 'true'
  const traderLogin = getState(db, 'ctrader_trader_login')
  if (id) upsertAccount(db, { accountId: id, traderLogin, isLive })
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE enabled = 1').get().n
  if (enabled === 0 && id) syncSelectedAccount(db, id, isLive, traderLogin)
  const total = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n
  return { total, enabled: db.prepare('SELECT account_id FROM accounts WHERE enabled = 1').get()?.account_id ?? null }
}

// Tables whose historical rows belong to the account they were created
// under. In the single-account era that is unambiguously the currently-
// selected account. scans/analyses/cup_handle_diagnostics deliberately stay
// NULL — they are account-independent market observations (plan M1).
const BACKFILL_TABLES = [
  'trades', 'signals', 'pending_orders', 'broker_orders', 'risk_events',
  'trade_postmortems', 'pending_signals', 'performance_snapshots',
]

/**
 * One-time M1 backfill (idempotent, boot-time): stamp every historical
 * NULL-account row with the current account id. Retries on later boots
 * until an account id exists; runs exactly once after that.
 */
export function backfillAccountIds(db) {
  if (getState(db, 'm1_account_backfill_v1')) return { skipped: 'done' }
  const id = getState(db, 'ctrader_account_id')
  if (!id) return { skipped: 'no account selected yet' }
  let total = 0
  for (const t of BACKFILL_TABLES) {
    try {
      total += db.prepare(`UPDATE ${t} SET account_id = ? WHERE account_id IS NULL`).run(String(id)).changes
    } catch { /* table may predate a migration on very old DBs — skip */ }
  }
  setState(db, 'm1_account_backfill_v1', new Date().toISOString())
  return { backfilled: total, accountId: String(id) }
}

/**
 * The registry-backed answer to "which accounts does the loop trade?" —
 * shaped exactly like the legacy ctrader_account_roles_json entries
 * ({accountId, isLive, autopilot}) so loop.js can consume either source
 * unchanged. Autopilot defaults ON for enabled/active rows (matching the
 * select-account handler's legacy write of autopilot:true) and can be
 * turned off per account via params.autopilot=false.
 */
export function registryAutopilotAccounts(db) {
  return getEnabledAccounts(db)
    .filter(a => a.mode === 'active' && a.params.autopilot !== false)
    .map(a => ({ accountId: a.account_id, isLive: a.is_live === 1, autopilot: true }))
}
