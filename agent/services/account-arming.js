// ---------------------------------------------------------------------------
// agent/services/account-arming.js — ONE fact for "may this account open a new
// position", plus a notice every time that fact changes.
//
// OWNER, 04-08-2026: "do we need to have this extra layer of Auto-trade (armed
// and disarmed capability)" and "it is a wasted opportunities and time, if I
// don't check mean a few hours gone for not trading."
//
// Both complaints are the same defect seen from two sides.
//
// THE DUPLICATE. Whether an account may ENTER was stored in two places that
// nothing kept in agreement:
//
//   accounts.mode                     'active' | 'manage_only' | 'paused'
//   agent_state acct:<id>:autotrade_enabled   'true' | 'false' | absent
//
// effectivePhases ANDed them, so either could veto and neither knew the other
// existed. POST /actions/ctrader-select-account wrote `mode` and never touched
// the override; the equity stop wrote the override and never touched `mode`.
// Undoing either therefore took two gestures, and a page reading one layer
// could show ARMED while the dispatcher refused from the other.
//
// `accounts.mode` wins as the survivor: it is a real column with a constraint,
// it already drives the dispatcher through accountCapabilities, and it can say
// `manage_only` — "keep managing what is open, start nothing new" — which is
// exactly what a per-account disarm means and what a bare boolean cannot
// express. The agent_state override becomes a translated alias: writes are
// folded into `mode`, reads derive from it, and a boot migration clears the
// old keys so there is nothing left to drift.
//
// WHAT IS NOT COLLAPSED. The master `autotrade_enabled` stays, and stays
// separate. It is the kill switch — /pause, /killall, the performance breaker
// — and this desk already learned why per-account disarms must NOT go through
// it: flipping master stopped every account at once, which is the
// "autotrade drops from the accounts" incident equity-stop.js was written to
// end. One global switch, one per-account state, no third thing.
//
// THE SILENCE. Losing entries costs hours, and nothing announced a change, so
// the only detector was the owner opening the page. Every transition out of
// the entering state now writes an audit row and, when it was not the owner's
// own doing, sends a Telegram notice naming the account, the states and the
// actor. Re-arming is announced too — a brake that lifts silently is the same
// problem in the other direction.
// ---------------------------------------------------------------------------

import { getState, setState, withPhaseWriteAuthority } from '../db.js'
import { accountCapabilities } from './account-capabilities.js'

/** The legacy per-account override key. Retired; read only by the migration. */
export const legacyArmKey = (accountId) => `acct:${String(accountId)}:autotrade_enabled`

/**
 * May this account open a new position, ignoring the master switch?
 *
 * Derived from `accounts.mode` alone. An account the registry has never seen
 * returns `true`: a conservative `false` is right for the dispatcher (which
 * asks accountCapabilities directly) but wrong here, where it would report
 * "disarmed" for every account on a database with no registry rows — a false
 * alarm about the one thing the owner most needs to trust.
 */
export function accountArmed(db, accountId) {
  try {
    const caps = accountCapabilities(db, accountId)
    if (!caps.known) return true
    return caps.enter !== false
  } catch { return true }
}

/**
 * Set it. `on` maps to mode 'active'; `off` maps to 'manage_only' — never to
 * `enabled = 0`, because disabling drops the account from the reconcile sweep
 * and the sidecar roster, which would stop MANAGING positions that are still
 * open at the broker. Disarming must cost entries and nothing else.
 *
 * @returns {{ok: boolean, changed: boolean, from: string|null, to: string, error?: string}}
 */
export function setAccountArmed(db, accountId, on, meta = {}) {
  const id = String(accountId)
  let row = null
  try { row = db.prepare('SELECT mode, enabled FROM accounts WHERE account_id = ?').get(id) } catch { row = null }
  if (!row) {
    // A DISARM MUST ALWAYS LAND, even for an account the registry has never
    // seen. Refusing here would be a fail-open: the equity stop, the
    // performance breaker and /killall would all silently do nothing on a row
    // that had not been created yet, and this module's whole job is that a
    // brake cannot be quietly ignored. So a disarm CREATES the row it needs.
    //
    // An ARM is refused, deliberately and asymmetrically. Inventing a row to
    // satisfy an arm would mean a typo'd or unknown account id could bring an
    // armed account into existence.
    if (on) return { ok: false, changed: false, from: null, to: 'active', error: `unknown account ${id}` }
    try {
      const stamp = new Date().toISOString()
      db.prepare(
        `INSERT INTO accounts (account_id, enabled, mode, params, created_at, updated_at)
         VALUES (?, 1, 'manage_only', '{}', ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET mode = 'manage_only', updated_at = excluded.updated_at`
      ).run(id, stamp, stamp)
    } catch (e) {
      return { ok: false, changed: false, from: null, to: 'manage_only', error: e.message }
    }
    noteArmChange(db, { accountId: id, from: 'unknown', to: 'manage_only', ...meta })
    return { ok: true, changed: true, from: 'unknown', to: 'manage_only' }
  }

  const from = row.mode || 'manage_only'
  const to = on ? 'active' : 'manage_only'
  // A `paused` or `archived` account is not silently promoted by an arm: those
  // are deliberate states with their own meaning, and turning one into
  // 'active' through the arming switch would hide the fact that it was paused.
  if (!on && from !== 'active') return { ok: true, changed: false, from, to: from }
  if (from === to) return { ok: true, changed: false, from, to }

  db.prepare('UPDATE accounts SET mode = ?, updated_at = ? WHERE account_id = ?')
    .run(to, new Date().toISOString(), id)
  // Arming an account that was dropped from the roster has to put it back, or
  // the switch reads ON while the reconciler and the sidecar have never heard
  // of it.
  if (on && row.enabled !== 1) {
    db.prepare('UPDATE accounts SET enabled = 1, updated_at = ? WHERE account_id = ?')
      .run(new Date().toISOString(), id)
  }
  noteArmChange(db, { accountId: id, from, to, ...meta })
  return { ok: true, changed: true, from, to }
}

/**
 * Record — and, when it was not the owner, announce — a change in whether an
 * account may enter.
 *
 * Fire-and-forget on the alert: a notice must never be able to block or undo
 * the state change it is describing.
 */
export function noteArmChange(db, { accountId, from, to, actor = 'unknown', via = null, reason = null }) {
  const id = accountId == null ? null : String(accountId)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)').run(
      'AUDIT',
      `/arm/${id ?? 'unknown'}`,
      JSON.stringify({ accountId: id, from, to, actor, via, reason, at: new Date().toISOString() }),
      id,
    )
  } catch { /* the trail must never block the flip */ }
  console.log(`[arming] account ${id}: ${from} → ${to} by ${actor}${via ? ` via ${via}` : ''}${reason ? ` — ${reason}` : ''}`)

  // The owner's own gestures are not news to the owner. Everything else is:
  // this is the notice whose absence turned a demotion into hours of not
  // trading that nobody knew about.
  if (actor === 'owner-ui' || actor === 'telegram') return
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  const armed = to === 'active'
  const text = armed
    ? `\u{1F513} Account ${id} RE-ARMED (${from} → ${to}) by ${actor}${via ? ` (${via})` : ''}\n${reason || 'no reason recorded'}\n\nIt can open new positions again.`
    : `\u{1F512} Account ${id} STOPPED ENTERING (${from} → ${to}) by ${actor}${via ? ` (${via})` : ''}\n${reason || 'no reason recorded'}\n\nOpen positions are still managed — stops, trails and the ratchet keep running. No NEW entries until it is re-armed.`
  import('./telegram.js').then(t => t.sendMessage(text)).catch(() => { /* best effort */ })
}

/**
 * Boot migration: fold any surviving `acct:<id>:autotrade_enabled` into `mode`,
 * then clear it so the two can never disagree again.
 *
 * DIRECTION MATTERS. An override reading 'false' is an owner or a brake having
 * said "not this account", and it must survive the migration — so it wins over
 * a `mode` of 'active'. An override reading 'true' does NOT promote a
 * manage_only account: that combination is exactly the drift being removed,
 * and resolving it towards trading would arm an account on a deploy.
 *
 * Idempotent: after the first run there are no keys left to fold.
 */
export function migrateLegacyArmFlags(db) {
  let rows = []
  try {
    // `value IS NOT NULL` so a cleared key is not re-processed: setState(null)
    // leaves the row in place with a NULL value, which is already "no flag".
    // Without this the migration would report work on every boot forever.
    rows = db.prepare(
      `SELECT key, value FROM agent_state
        WHERE key LIKE 'acct:%:autotrade_enabled' AND value IS NOT NULL`
    ).all()
  } catch { return { folded: 0, cleared: 0 } }

  let folded = 0, cleared = 0
  for (const r of rows) {
    const id = String(r.key).slice('acct:'.length, -':autotrade_enabled'.length)
    if (r.value === 'false') {
      try {
        const row = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(id)
        if (row && row.mode === 'active') {
          db.prepare('UPDATE accounts SET mode = ?, updated_at = ? WHERE account_id = ?')
            .run('manage_only', new Date().toISOString(), id)
          folded++
        }
      } catch { /* a missing row means nothing to fold */ }
    }
    // These keys are guarded — a plain setState would be journalled as a
    // PHASE_RAW_WRITE with a stack. This IS an authorized retirement of the
    // key, so it says so rather than tripping the alarm it exists to raise.
    try { withPhaseWriteAuthority(() => setState(db, r.key, null)); cleared++ }
    catch { /* leave it; the read path no longer uses it either way */ }
  }
  if (cleared) console.log(`[arming] migrated ${cleared} legacy per-account autotrade flag(s) into accounts.mode (${folded} disarm(s) preserved)`)
  return { folded, cleared }
}

/** Is the legacy key still present anywhere? Used by the migration test. */
export function legacyArmFlagsRemaining(db) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'acct:%:autotrade_enabled' AND value IS NOT NULL`
    ).get().n
  } catch { return 0 }
}

/** Present for symmetry with the legacy reader; always null now. */
export function legacyArmFlag(db, accountId) {
  try { return getState(db, legacyArmKey(accountId)) } catch { return null }
}
