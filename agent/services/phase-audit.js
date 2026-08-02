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
import { getState, setState, withPhaseWriteAuthority } from '../db.js'

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
  // The ONE authorized write path for these keys — setState logs any other
  // writer as PHASE_RAW_WRITE with its stack (owner 01-08: ironclad).
  withPhaseWriteAuthority(() => setState(db, key, value))
  if (from === to) return { changed: false, from, to }
  try {
    // A5/A6 follow-up: stamp the account this flip was made for. Per-account
    // phase switches carry an accountId; the master switches do not and stay
    // NULL, which reads as "applies to every account" — the truth for a
    // global flag, not a missing value.
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)').run(
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
      accountId == null ? null : String(accountId),
    )
  } catch { /* the audit write must never block the flip itself */ }
  console.log(`[phase-audit] ${key}: ${from ?? 'unset'} → ${to ?? 'unset'} by ${actor || 'unknown'}${via ? ` via ${via}` : ''}${reason ? ` — ${reason}` : ''}`)

  // MASTER autotrade disarmed by an AUTOMATED actor → tell the owner's phone
  // immediately, with the culprit named (owner 01-08: "each time i change
  // browser or return - autotrade is off" — the flip happened hours earlier
  // in the background and nothing said so at the moment it happened; the
  // ratchet/breaker alerts exist but each writer alerting for itself is how
  // one gets missed). Centralised HERE so no current or future automated
  // disarm can be silent. Owner-initiated flips (UI, Telegram commands) skip
  // it — they already know. Fire-and-forget: alerting never blocks a brake.
  if (key === 'autotrade_enabled' && to === 'false' && actor !== 'owner-ui' && actor !== 'telegram') {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      import('./telegram.js')
        .then(t => t.sendMessage(
          `\u{1F512} MASTER AUTOTRADE DISARMED by ${actor || 'unknown'}${via ? ` (${via})` : ''}\n${reason || 'no reason recorded'}\n\nEvery account's Autotrade switch is now vetoed. Re-arm from Tune › Pipeline or /resume once reviewed.`))
        .catch(() => { /* alert best-effort */ })
    }
  }
  return { changed: true, from, to }
}

/**
 * The tracer view (owner 01-08: "setup a tracer") — GET /state/phase-trace.
 *
 * Merges three layers over the S.A.T. keys:
 *   1. phase_flag_trace — DB triggers under agent_state: EVERY physical
 *      change, whoever wrote it (db.js). The ground truth.
 *   2. the setPhaseFlag audit rows — attribution (actor/via/reason).
 *   3. PHASE_RAW_WRITE rows — writes that bypassed setPhaseFlag, with the
 *      caller's JS stack.
 * A trace row with no audit/raw row near it in time is UNATTRIBUTED — the
 * exact evidence class the last two incidents lacked.
 */
export function phaseTraceView(db, { limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, limit))
  let trace = []
  try {
    trace = db.prepare(
      'SELECT id, key, old_value, new_value, at FROM phase_flag_trace ORDER BY id DESC LIMIT ?'
    ).all(lim)
  } catch { trace = [] }

  const audit = recentPhaseAudit(db, { limit: lim }).filter(r => String(r.path || '').startsWith('/phase/'))
  let raw = []
  try {
    raw = db.prepare(
      `SELECT id, at, path, body FROM action_log
        WHERE method = 'PHASE_RAW_WRITE' ORDER BY id DESC LIMIT ?`
    ).all(lim).map(r => {
      let body = null
      try { body = JSON.parse(r.body) } catch { body = { raw: r.body } }
      return { id: r.id, at: r.at, path: r.path, ...body }
    })
  } catch { raw = [] }

  // Attribute each physical change: an audit or raw row for the same key and
  // same to-value within ±5s. Coarse on purpose — attribution is a pointer
  // for a human, the trace row itself is the fact.
  const WINDOW_MS = 5000
  const ts = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null }
  const attributed = trace.map(row => {
    const t = ts(row.at)
    const match = (cands, kind) => cands.find(c =>
      c.key === row.key && (c.to ?? null) === (row.new_value ?? null) &&
      t != null && ts(c.at) != null && Math.abs(ts(c.at) - t) <= WINDOW_MS
    ) && kind
    // A first-ever write (old NULL) with no audit row is the initDB seed —
    // expected on every fresh database, not evidence of anything.
    const src = match(audit, 'audited') || match(raw, 'raw_write')
      || (row.old_value === null ? 'seed' : 'UNATTRIBUTED')
    const detail = src === 'audited'
      ? audit.find(c => c.key === row.key && (c.to ?? null) === (row.new_value ?? null) && Math.abs((ts(c.at) ?? 0) - (t ?? 0)) <= WINDOW_MS)
      : src === 'raw_write'
        ? raw.find(c => c.key === row.key && (c.to ?? null) === (row.new_value ?? null) && Math.abs((ts(c.at) ?? 0) - (t ?? 0)) <= WINDOW_MS)
        : null
    return {
      ...row,
      source: src,
      actor: detail?.actor ?? null,
      via: detail?.via ?? null,
      reason: detail?.reason ?? null,
      stack: detail?.stack ?? null,
    }
  })

  const current = {}
  for (const k of PHASE_KEYS) current[k] = getState(db, k)
  return {
    current,
    changes: attributed,
    unattributed: attributed.filter(c => c.source === 'UNATTRIBUTED').length,
    rawWrites: raw.length,
  }
}

/**
 * Controller state transition (stalled / recovered / started) — same trail,
 * so "which controller was dead when the flags flipped" is answerable from
 * one table.
 */
export function auditControllerEvent(db, { controller, event, detail = null }) {
  try {
    // NO account column on purpose: a controller stall is PROCESS health, not
    // one account's event. Stamping it with the trading account would make a
    // per-account read look like that account had a fault of its own.
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
      'AUDIT',
      `/controller/${controller}/${event}`,
      JSON.stringify({ controller, event, detail, at: new Date().toISOString() }),
    )
  } catch { /* never blocks */ }
  console.log(`[phase-audit] controller ${controller}: ${event}${detail ? ` — ${detail}` : ''}`)
}

/** Recent phase/controller audit rows, newest first, for /state readers. */
export function recentPhaseAudit(db, { limit = 100, accountId = null } = {}) {
  try {
    // Scoping INCLUDES the NULL rows deliberately, and here that is more than
    // a convention: the master switches and the controller events are global
    // by design, and an account's audit trail without them would omit the
    // flips that actually affected it.
    const scope = accountId != null && accountId !== ''
      ? { sql: 'AND (account_id = ? OR account_id IS NULL)', params: [String(accountId)] }
      : { sql: '', params: [] }
    return db.prepare(
      `SELECT id, at, method, path, body, account_id FROM action_log
        WHERE method = 'AUDIT' AND (path LIKE '/phase/%' OR path LIKE '/controller/%')
        ${scope.sql}
        ORDER BY id DESC LIMIT ?`
    ).all(...scope.params, Math.min(500, Math.max(1, limit))).map(r => {
      let body = null
      try { body = JSON.parse(r.body) } catch { body = r.body }
      return { id: r.id, at: r.at, path: r.path, accountId: r.account_id ?? null, ...((body && typeof body === 'object') ? body : { raw: body }) }
    })
  } catch { return [] }
}
