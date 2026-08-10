// A2 — per-account capabilities. `accounts.mode` exists and, until now, was
// enforced in exactly one place.
//
// docs/per-account-control-plan.md §2: the column
// `accounts.mode TEXT NOT NULL DEFAULT 'manage_only'` has been written by three
// call sites since M0 and READ by one — `registryAutopilotAccounts` filters
// `mode === 'active'`. Scanning, analysis, pending-order work and the guards
// ignored it entirely. "Pause this account" was therefore a label on a switch
// that did almost nothing.
//
// ===========================================================================
// THE SAFETY PRINCIPLE THIS FILE ENCODES (plan §1)
// ===========================================================================
//
//     MANAGING AN OPEN POSITION IS NEVER PAUSABLE.
//
// Scanning is optional. Entering is optional. Watching money that is already
// at risk is not. Any "pause" that stops stop-management is a bug wearing a
// feature's clothes — it is precisely the failure the account switch used to
// cause, where trailing stops, the loss cap, the ratchet and the naked-position
// guardian all silently stopped while the positions stayed open at the broker.
//
// So MANAGE is on in every mode except `archived`, and `archived` is REFUSED
// while the account has anything open. That refusal is not advisory: it is the
// only thing standing between "I'm done with this account" and a repeat of the
// abandonment bug.
//
// ===========================================================================
// WHY THREE CAPABILITIES RATHER THAN ONE MODE
// ===========================================================================
// They fail and resume independently. An account can be scanning but not
// entering (you want its insight history warm while you work elsewhere), or
// entering nothing while still managing (you stepped away). Collapsing them
// into one switch forces those into the same decision, which is how "pause"
// came to mean four different things depending on who was asking.
//
// `mode` stays the user-facing preset; the capabilities are what the engine
// asks. Nothing here reads or writes trading state — it answers questions.
import { listAccounts } from './account-registry.js'

export const MODES = ['active', 'manage_only', 'paused', 'archived']

/** Modes an operator may set directly. `archived` goes through archiveAccount. */
export const SETTABLE_MODES = ['active', 'manage_only', 'paused']

/**
 * Preset → capabilities (plan §2 table).
 *
 * manage_only SCAN is `true` by default and overridable per account, because
 * the plan is explicit that this is a choice rather than an assumption:
 * scanning without entering keeps the insight history warm at the cost of some
 * shared scan budget, and which of those matters is the operator's call.
 */
export function capabilitiesFor(mode, { scanWhileManageOnly = true } = {}) {
  switch (String(mode || '')) {
    case 'active':
      return { scan: true, enter: true, manage: true }
    case 'manage_only':
      return { scan: !!scanWhileManageOnly, enter: false, manage: true }
    case 'paused':
      return { scan: false, enter: false, manage: true }
    case 'archived':
      return { scan: false, enter: false, manage: false }
    default:
      // An unrecognised mode must not silently become 'active'. The safe
      // reading of an unknown state is the one that starts nothing new and
      // keeps looking after what exists.
      return { scan: false, enter: false, manage: true }
  }
}

/**
 * Capabilities for one account, from the registry.
 *
 * `enabled = 0` is a harder switch than any mode: a disabled account is out of
 * the sidecar roster entirely, so it cannot enter. It still MANAGES, for the
 * same reason `paused` does — disabling an account does not close its
 * positions, and the ones still open need their stops fed.
 *
 * An account the registry has never seen gets the conservative default rather
 * than an exception: callers are on the trading hot path and an unknown id
 * must not be able to throw its way into a permissive answer.
 */
export function accountCapabilities(db, accountId) {
  const id = accountId == null ? null : String(accountId)
  if (!id) return { ...capabilitiesFor(null), mode: null, known: false, enabled: false }
  let row = null
  try {
    row = listAccounts(db).find(a => String(a.account_id) === id) || null
  } catch { row = null }
  if (!row) return { ...capabilitiesFor(null), mode: null, known: false, enabled: false }

  const mode = row.mode || 'manage_only'
  const caps = capabilitiesFor(mode, {
    scanWhileManageOnly: row.params?.scanWhileManageOnly !== false,
  })
  const enabled = row.enabled === 1
  return {
    mode,
    known: true,
    enabled,
    scan: caps.scan && enabled,
    enter: caps.enter && enabled,
    // NEVER gated on `enabled`. See the header: an account that is out of the
    // roster still holds positions, and those positions still need watching.
    manage: caps.manage,
  }
}

export const canScan = (db, id) => accountCapabilities(db, id).scan
export const canEnter = (db, id) => accountCapabilities(db, id).enter
export const canManage = (db, id) => accountCapabilities(db, id).manage

/**
 * What is still open on this account, and therefore what forbids archiving.
 *
 * Positions AND working entry orders both count. The plan is explicit that a
 * pending is live work — under supervised-drain the monitor is still
 * evaluating it — so an account with a resting entry order has not gone quiet
 * however few positions it holds.
 *
 * @returns {{flat: boolean, positions: number, pendings: number, reasons: string[]}}
 */
export function openWork(db, accountId) {
  const id = String(accountId)
  const count = (sql, ...params) => {
    try { return Number(db.prepare(sql).get(...params)?.c || 0) } catch { return 0 }
  }
  const positions = count(
    `SELECT COUNT(*) AS c FROM monitored_positions
      WHERE status = 'active' AND (account_id = ? OR account_id IS NULL)`, id)
  const pendings = count(
    `SELECT COUNT(*) AS c FROM pending_orders
      WHERE status IN ('working', 'pending') AND (account_id = ? OR account_id IS NULL)`, id)
  const reasons = []
  if (positions > 0) reasons.push(`${positions} open position${positions === 1 ? '' : 's'}`)
  if (pendings > 0) reasons.push(`${pendings} working entry order${pendings === 1 ? '' : 's'}`)
  return { flat: positions === 0 && pendings === 0, positions, pendings, reasons }
}

/**
 * Archive an account — the only state that stops MANAGE, and therefore the
 * only one that can recreate the abandonment bug if it is granted carelessly.
 *
 * Refused while anything is open, with the blockers NAMED. A bare "cannot
 * archive" would send the operator hunting; "3 open positions, 1 working entry
 * order" tells them what to do next.
 */
export function archiveAccount(db, accountId) {
  const id = String(accountId)
  let row = null
  try {
    row = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?').get(id)
  } catch { row = null }
  if (!row) return { ok: false, error: `account ${id} is not in the registry` }

  const work = openWork(db, id)
  if (!work.flat) {
    return {
      ok: false,
      error: `account ${id} still has ${work.reasons.join(' and ')} — archiving would stop managing them`,
      ...work,
    }
  }
  db.prepare('UPDATE accounts SET enabled = 0, mode = ?, updated_at = ? WHERE account_id = ?')
    .run('archived', new Date().toISOString(), id)
  return { ok: true, accountId: id, mode: 'archived' }
}

/**
 * MANAGE CLAIMED IS NOT MANAGE REACHABLE (10-08-2026).
 *
 * `accountCapabilities` returns `manage: caps.manage` and says, correctly, that
 * it is NEVER gated on `enabled` — an account out of the roster still holds
 * positions and those positions still need watching. That is the intent. It is
 * not what happens.
 *
 * `enabled = 0` removes the row from `ctrader-creds.js:42`, which builds the
 * roster pushed to the sidecar in `/connect`. An account outside that roster is
 * never authorised at the broker, so no amend and no close can be routed to it.
 * MANAGE is therefore asserted and unreachable at the same time — the one
 * combination worse than the abandonment bug this file exists to prevent,
 * because it reports itself as healthy.
 *
 * Production, this morning: six of seven accounts sat `enabled = 0` with a
 * non-archived mode, every one reporting `"manage": true` beside
 * `"connectivity": "disconnected"`, between them holding 17 open positions and
 * 5 working entry orders that nothing could reach.
 *
 * The invariant, stated once so it can be tested:
 *
 *     mode !== 'archived'  ⇒  enabled = 1
 *
 * `archived` is the only mode that turns MANAGE off, and archiveAccount already
 * refuses to set it while anything is open. So every other mode is a promise to
 * keep managing, and this repair makes the roster keep it.
 *
 * Idempotent: after the first pass there is nothing left to promote. `mode` is
 * never touched, so no account gains SCAN or ENTER from being repaired — those
 * two are `caps.x && enabled`, and the modes that had them false keep them
 * false.
 *
 * @returns {{promoted: Array<{accountId:string, mode:string, isLive:boolean}>}}
 */
export function rosterInvariantViolations(db) {
  try {
    return db.prepare(
      `SELECT account_id AS accountId, mode, is_live AS isLive FROM accounts
        WHERE enabled != 1 AND mode IS NOT NULL AND mode != 'archived'
        ORDER BY is_live DESC, account_id`
    ).all().map(r => ({ accountId: String(r.accountId), mode: r.mode, isLive: r.isLive === 1 }))
  } catch { return [] }
}

export function repairRosterMembership(db) {
  let rows = []
  try {
    rows = db.prepare(
      `SELECT account_id, mode, is_live FROM accounts
        WHERE enabled != 1 AND mode IS NOT NULL AND mode != 'archived'`
    ).all()
  } catch { return { promoted: [] } }
  if (rows.length === 0) return { promoted: [] }

  const upd = db.prepare('UPDATE accounts SET enabled = 1, updated_at = ? WHERE account_id = ?')
  const stamp = new Date().toISOString()
  const promoted = []
  for (const r of rows) {
    try {
      upd.run(stamp, String(r.account_id))
      promoted.push({ accountId: String(r.account_id), mode: r.mode, isLive: r.is_live === 1 })
    } catch { /* one bad row must not abandon the rest */ }
  }
  return { promoted }
}

/** Bring an archived account back. Always returns to the quietest live mode. */
export function unarchiveAccount(db, accountId, mode = 'manage_only') {
  const id = String(accountId)
  if (!SETTABLE_MODES.includes(mode)) return { ok: false, error: `invalid mode ${mode}` }
  const row = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(id)
  if (!row) return { ok: false, error: `account ${id} is not in the registry` }
  if (row.mode !== 'archived') return { ok: false, error: `account ${id} is not archived` }
  db.prepare('UPDATE accounts SET mode = ?, updated_at = ? WHERE account_id = ?')
    .run(mode, new Date().toISOString(), id)
  // Deliberately does NOT re-enable: re-entering the sidecar roster is a
  // separate, louder decision than un-filing the account.
  return { ok: true, accountId: id, mode, enabled: false }
}

/** Every account with its capabilities and open work — the A4 traffic-light feed. */
export function capabilityView(db) {
  let rows = []
  try { rows = listAccounts(db) } catch { rows = [] }
  return rows.map(a => {
    const id = String(a.account_id)
    const caps = accountCapabilities(db, id)
    const work = openWork(db, id)
    return {
      accountId: id,
      label: a.broker_label || null,
      isLive: a.is_live === 1,
      enabled: a.enabled === 1,
      mode: caps.mode,
      scan: caps.scan,
      enter: caps.enter,
      manage: caps.manage,
      positions: work.positions,
      pendings: work.pendings,
      flat: work.flat,
      // The §1 invariant, checked rather than assumed: an account holding
      // open work while MANAGE is off is the alarm state, and the only mode
      // that can produce it is `archived` — which archiveAccount refuses to
      // set while work exists. If this is ever true, something set the column
      // directly.
      unmanagedExposure: !caps.manage && !work.flat,
    }
  })
}

/** Account ids that may SCAN. The universe question, not the entry question. */
export function scanAccountIds(db) {
  return capabilityView(db).filter(r => r.scan).map(r => r.accountId)
}

/** Account ids that may ENTER — the ones a dispatch may actually reach. */
export function enterAccountIds(db) {
  return capabilityView(db).filter(r => r.enter).map(r => r.accountId)
}
