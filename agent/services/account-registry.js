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
// capabilitiesFor is a PURE preset table with no imports of its own, so
// importing it here cannot create a cycle back through this module.
import { capabilitiesFor, SETTABLE_MODES, enabledForMode, liveEntryRefusal, archiveAccount } from './account-capabilities.js'

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
      VALUES (?, ?, ?, ?, ?, ?, 0, 'registered', '{}', ?, ?)
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
 * Make `accountId` the selected account. It does NOT touch any other row.
 *
 * THE SOLE-ENABLED SWAP IS RETIRED (owner 04-08-2026: "autotrade disarmed
 * again or switch to manage-only … it is a wasted opportunities and time, if I
 * don't check mean a few hours gone for not trading").
 *
 * This used to run, on every account selection:
 *
 *   UPDATE accounts SET enabled = 0, mode = 'manage_only'
 *    WHERE enabled = 1 AND account_id NOT IN (selected + retained)
 *
 * where `retained` was only the accounts holding open positions at that
 * instant. So clicking an account on Accounts or Connect silently disarmed
 * every OTHER armed account that happened to be flat, and demoted the ones
 * that were not to manage_only. Nothing ever promoted them back, and nothing
 * announced it — which is precisely the hours of not trading the owner was
 * losing between checks.
 *
 * That rule made sense when the system traded exactly one account: "selected"
 * and "the account we trade" were the same fact. They are not any more.
 * Selection is now a VIEW and a default — which account the legacy state keys
 * and the UI point at — while arming is a per-account state the owner sets
 * deliberately and only the arming path may change. Two different questions,
 * two different gestures.
 *
 * `retainAccountIds` is accepted and ignored, so callers computing it for
 * their own logging do not break; there is nothing left to retain against.
 */
export function syncSelectedAccount(db, accountId, isLive, traderLogin = null, { retainAccountIds = [] } = {}) {  // eslint-disable-line no-unused-vars
  if (accountId == null) return
  upsertAccount(db, { accountId, traderLogin, isLive })
  // The selected account is enabled and active — selecting an account you
  // intend to trade should not then require arming it separately. Promoting
  // ONE row is the whole of the write; every other row keeps whatever the
  // owner set.
  db.prepare(`UPDATE accounts SET enabled = 1, mode = 'active', is_live = ?, updated_at = ? WHERE account_id = ?`)
    .run(isLive ? 1 : 0, now(), String(accountId))
}

/**
 * M4: deliberately lift the M0 sole-enabled invariant — enable or disable
 * ONE account row without touching the others. This is the registry gesture
 * behind multi-account operation: the selected account stays the primary
 * (legacy state keys unchanged); additional enabled rows join the sidecar
 * roster, the reconcile sweep, and the autopilot dispatch. The row must
 * already exist (created by selection or an accounts push) — enabling an
 * unknown id is refused rather than inventing a row with no metadata.
 */
export function setAccountEnabled(db, accountId, enabled, mode = null, { confirmLive = false } = {}) {
  if (accountId == null) return { ok: false, error: 'accountId required' }
  const id = String(accountId)
  const row = db.prepare('SELECT account_id, is_live FROM accounts WHERE account_id = ?').get(id)
  if (!row) return { ok: false, error: `unknown account ${id} — select it once or push the account list first` }

  // DISABLING IS ARCHIVING, and archiving has a refusal. This used to write
  // `enabled = 0, mode = 'manage_only'` — a row still claiming MANAGE with no
  // way to reach it, which is the pair PR A repaired six of in production. The
  // only legitimate way off the roster is archiveAccount, whose open-work
  // refusal is the thing that stops an account being abandoned mid-position.
  if (!enabled) {
    const out = archiveAccount(db, id)
    return out.ok ? { ...out, enabled: false, isLive: row.is_live === 1 } : out
  }

  const m = mode || 'active'
  if (!SETTABLE_MODES.includes(m)) return { ok: false, error: `invalid mode ${m}` }
  const gate = liveEntryRefusal(row.is_live === 1, m, confirmLive)
  if (gate) return gate
  // `enabled` is derived, never passed in — see enabledForMode.
  db.prepare('UPDATE accounts SET enabled = ?, mode = ?, updated_at = ? WHERE account_id = ?')
    .run(enabledForMode(m) ? 1 : 0, m, now(), id)
  return { ok: true, accountId: id, enabled: enabledForMode(m), mode: m, isLive: row.is_live === 1 }
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
  // monitored_positions has carried the column for a while, but rows from
  // before the reconciler started stamping it are NULL — same single-account
  // provenance, same backfill.
  'monitored_positions',
]

/**
 * Resolve the account a read/write should scope to: an explicit id when the
 * caller carries one (per-account workers, proposal.accountId), else the
 * currently-selected account. The M1 scoped-read convention is
 * `(account_id = ? OR account_id IS NULL)` — NULL rows are legacy/global
 * and count for EVERY account, which only ever makes guards stricter,
 * never looser.
 */
export function resolveAccountId(db, explicit = null) {
  if (explicit != null && explicit !== '') return String(explicit)
  const id = getState(db, 'ctrader_account_id')
  return id ? String(id) : null
}

/** Per-account agent_state key namespace (plan M1: `acct:<id>:<key>`). */
export const acctKey = (accountId, key) => `acct:${accountId}:${key}`
export function getAccountState(db, accountId, key) {
  return getState(db, acctKey(String(accountId), key))
}
export function setAccountState(db, accountId, key, value) {
  return setState(db, acctKey(String(accountId), key), value)
}

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
  // A2: the ENTER capability, from the one preset table, rather than a
  // hand-rolled `mode === 'active'` here. Same answer for the three modes that
  // existed before; the difference is that `archived` and any unrecognised
  // mode now resolve through the same conservative rules as every other
  // capability read, instead of each caller inventing its own.
  return getEnabledAccounts(db)
    .filter(a => capabilitiesFor(a.mode, { scanWhileManageOnly: a.params.scanWhileManageOnly !== false }).enter
      && a.params.autopilot !== false)
    .map(a => ({ accountId: a.account_id, isLive: a.is_live === 1, autopilot: true }))
}
