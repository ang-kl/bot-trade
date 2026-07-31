// ---------------------------------------------------------------------------
// phase-audit.js — explicit audit trail for the S.A.T. pipeline switches
// (scan_enabled / analyze_enabled / autotrade_enabled, master AND per-account)
// and for controller state transitions.
//
// Incident, owner 2026-07-31: "urgent serious issue - again happened -
// disconnected autotrade after I resume the browser screen … The Autotrade
// for all 5 accounts are disconnected. can you have explicit log setup the
// trading (S.A.T.) and each controller as well as inactive browser timeout."
//
// The diagnosis failed BOTH times for the same reason: half a dozen writers
// can flip these flags (UI routes, Telegram, equity stop, profit ratchet,
// performance breaker, kill-all) and none of them left a durable record of
// WHO flipped WHAT from WHAT to WHAT and WHY. The service logs told us the
// flags were off; nothing could say when they went off or by whose hand.
//
// From now on every flip goes through setPhaseFlag(), which:
//   - only writes (and only logs) on an actual CHANGE — read-modify-noise
//     from idempotent routes does not pollute the trail;
//   - writes one action_log row (method 'AUDIT', path /phase/<key>) with
//     {from, to, actor, via, reason, accountId} — the same table the security
//     and guard journals already ride on;
//   - emits one console line so Railway's log stream shows the flip inline
//     with the loop output.
//
// action_log is append-only and already surfaced in the workflow audit —
// no new table, no new retention policy.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'

/** The three pipeline flags; per-account variants are acct:<id>:<key>. */
export const PHASE_KEYS = Object.freeze(['scan_enabled', 'analyze_enabled', 'autotrade_enabled'])

/**
 * Set one S.A.T. flag WITH provenance. Drop-in for setState on these keys.
 *
 * @param {object} db
 * @param {string} key   'autotrade_enabled' or 'acct:<id>:autotrade_enabled' …
 * @param {string|null} value 'true' | 'false' | null (null clears a per-account
 *                      override back to inherit)
 * @param {{actor: string, via?: string|null, reason?: string|null,
 *          accountId?: string|null}} meta
 *        actor — WHO: 'owner-ui', 'telegram', 'equity_stop', 'profit_ratchet',
 *                'performance_breaker', …
 *        via   — the route/command that carried it ('/actions/kill-all', '/pause')
 *        reason— the why, for automatic actors especially
 * @returns {{changed: boolean, from: string|null, to: string|null}}
 */
export function setPhaseFlag(db, key, value, { actor, via = null, reason = null, accountId = null } = {}) {
  const from = getState(db, key) ?? null
  const to = value ?? null
  setState(db, key, value)
  if (from === to) return { changed: false, from, to }
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
      'AUDIT',
      `/phase/${key}`,
      JSON.stringify({
        key,
        from,
        to,
        actor: actor || 'unknown',
        via,
        reason,
        accountId: accountId != null ? String(accountId) : null,
        at: new Date().toISOString(),
      }),
    )
  } catch { /* the audit write must never block the flip itself */ }
  console.log(`[phase-audit] ${key}: ${from ?? 'unset'} → ${to ?? 'unset'} by ${actor || 'unknown'}${via ? ` via ${via}` : ''}${reason ? ` — ${reason}` : ''}`)
  return { changed: true, from, to }
}

/**
 * Controller state transition (stalled / recovered / started) — same trail,
 * so "which controller was dead when the flags flipped" is answerable from
 * one table.
 */
export function auditControllerEvent(db, { controller, event, detail = null }) {
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
      'AUDIT',
      `/controller/${controller}/${event}`,
      JSON.stringify({ controller, event, detail, at: new Date().toISOString() }),
    )
  } catch { /* never blocks */ }
  console.log(`[phase-audit] controller ${controller}: ${event}${detail ? ` — ${detail}` : ''}`)
}

/** Recent phase/controller audit rows, newest first, for /state readers. */
export function recentPhaseAudit(db, { limit = 100 } = {}) {
  try {
    return db.prepare(
      `SELECT id, at, method, path, body FROM action_log
        WHERE method = 'AUDIT' AND (path LIKE '/phase/%' OR path LIKE '/controller/%')
        ORDER BY id DESC LIMIT ?`
    ).all(Math.min(500, Math.max(1, limit))).map(r => {
      let body = null
      try { body = JSON.parse(r.body) } catch { body = r.body }
      return { id: r.id, at: r.at, path: r.path, ...((body && typeof body === 'object') ? body : { raw: body }) }
    })
  } catch { return [] }
}
