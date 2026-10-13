// ---------------------------------------------------------------------------
// agent/services/telegram-digest.js — quiet hours, a master mute, and an
// hourly summary in place of a message per event.
//
// WHY. Every alert in this system calls telegram.js sendMessage directly —
// 78 call sites across the loop, the guards, the ratchet, the monitors. That
// is fine when you are at a desk and useless at 03:00 SGT, when the phone
// buzzes for a scan the owner cannot act on and will not read. The ask was
// three things: a "/" command to set sleep hours in SGT, an on/off, and a
// summary of the past hour instead of a message every time.
//
// WHERE THE GATE LIVES, AND WHY IT IS NOT AT THE CALL SITES. Routing 78 call
// sites means 78 chances to miss one, and the one missed is the 03:00 buzz
// that proves the feature does not work. The gate is therefore INSIDE
// telegram.js's send functions — a single choke point nothing can go around.
//
// THE DEFAULTS CHANGE NOTHING. enabled: true, mode: 'live', quiet: null. A
// deploy of this file leaves alerting exactly as it was; the owner opts in
// with /quiet, /notify or /digest. Silencing a live trading system's alerts
// as a side effect of shipping a convenience feature is not a trade this
// makes.
//
// WHICH DIRECTION IT FAILS. Every uncertainty resolves toward DELIVERING:
//   - no db attached (wiring missing)      → send now
//   - unreadable config                    → send now
//   - text matches the urgent pattern      → send now, quiet hours or not
//   - queue write fails                    → send now rather than lose it
// A muted alert is invisible; a redundant one is merely annoying.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const CONFIG_KEY = 'telegram_notify_json'
export const LAST_FLUSH_KEY = 'tg_digest_last_flush_ms'
// Claude · № 13,878 13-Oct (ordered after № 13,873, owner "Stop queuing while off"; claude-builder).
// While notify is OFF a message is not sent and not queued: it is counted
// here. 84,587 rows had been held since 22-08 (624 MB, never sent, never
// pruned: outbox-prune.js removed only sent rows).
export const DROPPED_KEY = 'telegram_dropped_json'
export const LAST_ERROR_KEY = 'tg_digest_last_error'
const DEFAULT_TZ = 'Asia/Singapore'

/** Untouched behaviour until the owner asks for something else. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  mode: 'live',        // 'live' | 'hourly'
  quiet: null,         // { start: 'HH:MM', end: 'HH:MM' } in `tz`
  urgentBypass: true,  // critical alerts ignore quiet hours AND hourly batching
  tz: DEFAULT_TZ,
})

/** Read the config, repairing anything unreadable back to "behave as before". */
export function loadNotifyConfig(db) {
  let raw = null
  try { raw = JSON.parse(getState(db, CONFIG_KEY) || 'null') } catch { raw = null }
  const c = raw && typeof raw === 'object' ? raw : {}
  const quiet = c.quiet && isHHMM(c.quiet.start) && isHHMM(c.quiet.end)
    && c.quiet.start !== c.quiet.end
    ? { start: c.quiet.start, end: c.quiet.end }
    : null
  return {
    enabled: c.enabled !== false,
    mode: c.mode === 'hourly' ? 'hourly' : 'live',
    quiet,
    urgentBypass: c.urgentBypass !== false,
    tz: typeof c.tz === 'string' && c.tz ? c.tz : DEFAULT_TZ,
  }
}

/** Merge a patch over the stored config and persist the WHOLE resolved shape. */
//
// Claude · № 13,901 13-Oct (Codex P1 on #1345; owner "Delete them when turned
// on"; claude-builder). The flush reads every unsent row whatever its reason,
// so rows held as `notify_off` from before the drop rule would go out in the
// first digest after notify is switched back on. This is the only writer of
// the setting, so an off→on switch deletes them here, in the same transaction
// right after the switch, whichever caller made it. `purgedHeld` says how many.
//
// Claude · № 13,902 13-Oct (Codex P1 #2 on #1345; owner "Switch always
// lands"; claude-builder). The switch is saved FIRST and on its own: a broken
// outbox must not roll back /notify on, because with notify ON the router
// sends directly when the outbox cannot be written, and with it OFF every
// alert, urgent ones too, is dropped. A failed purge is reported in
// `purgeError` and recorded as the digest's last error; the 8-hourly prune
// still removes held notify_off rows.
export function saveNotifyConfig(db, patch) {
  const before = loadNotifyConfig(db)
  const next = { ...before, ...patch }
  setState(db, CONFIG_KEY, JSON.stringify(next))
  let purgedHeld = 0
  let purgeError = null
  if (before.enabled === false && next.enabled !== false) {
    try {
      purgedHeld = db.prepare(`DELETE FROM telegram_outbox WHERE sent_at IS NULL AND reason = 'notify_off'`).run().changes
    } catch (err) {
      purgeError = String(err?.message ?? err).slice(0, 200)
      try { setState(db, LAST_ERROR_KEY, `${new Date().toISOString()} held notify_off rows not deleted: ${purgeError}`) } catch { /* status only */ }
    }
  }
  return { ...loadNotifyConfig(db), purgedHeld, purgeError }
}

export const isHHMM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

/** Minutes since midnight in `tz`, from an epoch ms. */
export function minutesOfDay(nowMs, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs))
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
  // en-GB renders midnight as "24" in some ICU builds; 24:00 is 00:00.
  return ((h % 24) * 60) + m
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h * 60) + m
}

/**
 * Is `nowMs` inside the quiet window? Windows WRAP past midnight, which is the
 * only shape sleep hours ever take: 23:00→07:00 is "23:00 or later, OR before
 * 07:00", not the empty set that a naive start <= x < end returns.
 *
 * The window is half-open [start, end): a window ending 07:00 is over AT
 * 07:00, so the wake-up flush at exactly 07:00 is not itself deferred.
 */
export function inQuietHours(nowMs, quiet, tz = DEFAULT_TZ) {
  if (!quiet || !isHHMM(quiet.start) || !isHHMM(quiet.end)) return false
  const s = toMinutes(quiet.start), e = toMinutes(quiet.end)
  if (s === e) return false // a 24h quiet window is a typo, not a preference
  const n = minutesOfDay(nowMs, tz)
  return s < e ? (n >= s && n < e) : (n >= s || n < e)
}

// Generous ON PURPOSE. A miss here delays a critical alert by up to an hour; a
// false positive sends one message that could have waited. Those costs are not
// symmetric, so the pattern errs toward matching.
const URGENT_RE = new RegExp([
  'circuit breaker', 'halt', 'halted', 'kill', 'killed', 'breach', 'breached',
  'margin', 'stop ?out', 'liquidat', 'loss cap', 'daily loss', 'drawdown',
  'risk veto', 'naked', 'unprotected', 'no stop', 'missing sl', 'failed to',
  'error', 'cannot', 'rejected', 'disconnect', 'emergency', 'urgent',
].join('|'), 'i')

/**
 * 'urgent' | 'normal'. Inferred from the text because the 78 call sites do not
 * pass metadata and rewriting all of them to add a field is exactly the
 * 78-chances-to-miss-one problem the choke point exists to avoid. An explicit
 * opts.priority always wins when a caller does supply one.
 */
export function classifyPriority(text, explicit) {
  if (explicit === 'urgent' || explicit === 'normal') return explicit
  const t = String(text ?? '')
  if (/^\s*(🔴|🛑|🚨|⛔|❌)/u.test(t)) return 'urgent'
  return URGENT_RE.test(t) ? 'urgent' : 'normal'
}

/**
 * The decision, with no side effects — the piece worth testing directly.
 *
 * @returns {{action:'send'|'queue', reason:string, priority:'urgent'|'normal'}}
 */
export function routeDecision(cfg, { text, priority, nowMs }) {
  const p = classifyPriority(text, priority)
  if (!cfg.enabled) {
    // OFF means off, including for urgent — a master mute that quietly keeps
    // sending some messages is not a mute, and the owner would have no way to
    // tell which class was still getting through.
    // Claude · № 13,878 13-Oct (owner "Stop queuing while off"): dropped and
    // counted, not queued. Switching back on delivers nothing from the off
    // period.
    return { action: 'drop', reason: 'notify_off', priority: p }
  }
  const quiet = inQuietHours(nowMs, cfg.quiet, cfg.tz)
  if (p === 'urgent' && cfg.urgentBypass) {
    return { action: 'send', reason: quiet ? 'urgent_bypass_quiet' : 'live', priority: p }
  }
  if (quiet) return { action: 'queue', reason: 'quiet_hours', priority: p }
  if (cfg.mode === 'hourly') return { action: 'queue', reason: 'hourly_digest', priority: p }
  return { action: 'send', reason: 'live', priority: p }
}

/**
 * Count one message not sent because notify is OFF. The count runs from
 * `since` (the first drop recorded) and says which priorities were dropped.
 * Never throws; returns false when the count could not be written.
 */
export function recordDropped(db, { priority = 'normal', kind = 'alert', nowMs = Date.now() } = {}) {
  try {
    let prev = null
    try { prev = JSON.parse(getState(db, DROPPED_KEY) || 'null') } catch { prev = null }
    const ok = prev != null && typeof prev === 'object' && !Array.isArray(prev)
    const n = k => (ok && Number.isSafeInteger(prev[k]) ? prev[k] : 0)
    const at = new Date(nowMs).toISOString()
    const next = {
      since: ok && typeof prev.since === 'string' ? prev.since : at,
      count: n('count') + 1,
      urgent: n('urgent') + (priority === 'urgent' ? 1 : 0),
      normal: n('normal') + (priority === 'urgent' ? 0 : 1),
      lastAt: at,
      lastKind: String(kind),
    }
    setState(db, DROPPED_KEY, JSON.stringify(next))
    return true
  } catch { return false }
}

/** The drop count, or null when none was recorded. */
export function droppedState(db) {
  try {
    const d = JSON.parse(getState(db, DROPPED_KEY) || 'null')
    return d != null && typeof d === 'object' && !Array.isArray(d) ? d : null
  } catch { return null }
}

/** Append to the outbox. Returns false when the write failed (caller sends). */
export function queueMessage(db, { text, kind = 'alert', priority = 'normal', reason = '' }) {
  try {
    db.prepare(
      `INSERT INTO telegram_outbox (kind, priority, text, reason) VALUES (?, ?, ?, ?)`,
    ).run(String(kind), String(priority), String(text ?? ''), String(reason))
    return true
  } catch { return false }
}

/**
 * Pending (unsent) outbox rows waiting to be DELIVERED, oldest first.
 *
 * Claude · № 13,904 13-Oct (Codex P1 #3 on #1345; owner "Flush skips
 * notify_off rows"; claude-builder). A row held as `notify_off` is never
 * delivered: turning notify on deletes those rows, and when that delete
 * fails they stay here unsent until the 8-hourly prune removes them. Every
 * flush and every "queued" count reads this, so none of them can send or
 * count one. GET /state/telegram-digest still reports them as held.
 */
export function pendingMessages(db, limit = 500) {
  try {
    return db.prepare(
      // INDEXED BY: the planner otherwise takes (sent_at, id) and walks every
      // held row; the partial index holds only deliverable ones (db.js,
      // Codex P1 #4 on #1346; Claude · № 13,923).
      `SELECT id, queued_at, kind, priority, text, reason FROM telegram_outbox INDEXED BY idx_tg_outbox_deliverable
        WHERE sent_at IS NULL AND reason IS NOT 'notify_off' ORDER BY id ASC LIMIT ?`,
    ).all(limit)
  } catch { return [] }
}

const firstLine = (t) => String(t ?? '').split('\n').find(l => l.trim()) ?? ''

// Telegram hard-caps a message at 4096 characters. A digest that exceeds it is
// not truncated by Telegram — the send is REJECTED, so an over-long summary
// would lose the whole hour rather than the tail of it.
export const TG_TEXT_MAX = 4096

/**
 * Turn queued rows into ONE message. Grouped by kind, urgent items first and
 * never elided, normal items listed until the budget runs out and then counted.
 */
export function summarise(rows, { nowMs, tz = DEFAULT_TZ, label = 'past hour' } = {}) {
  if (!rows.length) return null
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(nowMs ?? Date.now()))

  const urgent = rows.filter(r => r.priority === 'urgent')
  const normal = rows.filter(r => r.priority !== 'urgent')
  const head = `🗞 Digest — ${rows.length} message${rows.length > 1 ? 's' : ''} from the ${label} (as at ${stamp} SGT)`
  const lines = [head, '']

  if (urgent.length) {
    lines.push(`⚠️ ${urgent.length} urgent:`)
    for (const r of urgent) lines.push(`  • ${firstLine(r.text)}`)
    lines.push('')
  }

  const byKind = new Map()
  for (const r of normal) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, [])
    byKind.get(r.kind).push(r)
  }
  for (const [kind, group] of byKind) {
    lines.push(`${kind} (${group.length}):`)
    let shown = 0
    for (const r of group) {
      const line = `  • ${firstLine(r.text)}`
      if (lines.join('\n').length + line.length > TG_TEXT_MAX - 120) break
      lines.push(line)
      shown++
    }
    if (shown < group.length) lines.push(`  …and ${group.length - shown} more`)
  }

  let text = lines.join('\n').trimEnd()
  // 64 characters of headroom: the sender appends a version footer AFTER this
  // trim, and Telegram rejects (not truncates) anything past 4096 — a digest
  // trimmed to exactly the cap still lost the whole hour once the footer
  // landed on top.
  const cap = TG_TEXT_MAX - 64
  if (text.length > cap) text = `${text.slice(0, cap - 3)}...`
  return text
}

/** Mark rows delivered. Kept separate so a failed send leaves them pending. */
export function markSent(db, ids) {
  if (!ids?.length) return 0
  try {
    const stmt = db.prepare(
      `UPDATE telegram_outbox SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    let n = 0
    for (const id of ids) n += stmt.run(id).changes
    return n
  } catch { return 0 }
}

export const HOUR_MS = 3_600_000

/**
 * Should the outbox be flushed now?
 *
 * TWO triggers, and the second is the one that matters most:
 *   - hourly: an hour has passed since the last flush
 *   - wake-up: quiet hours have ENDED and something was deferred into them
 *
 * Without the wake-up trigger, a night's alerts queued under `quiet_hours`
 * would sit until whenever the hourly timer next happened to fire — which in
 * 'live' mode is never. Messages deferred by a feature that promises to
 * deliver them later, and then does not, is the failure this whole file exists
 * to avoid on the sending side.
 */
export function flushDecision(db, cfg, nowMs) {
  const pending = pendingMessages(db)
  if (!pending.length) return { flush: false, reason: 'empty', rows: [] }
  if (!cfg.enabled) return { flush: false, reason: 'notify_off', rows: pending }
  if (inQuietHours(nowMs, cfg.quiet, cfg.tz)) return { flush: false, reason: 'still_quiet', rows: pending }

  const deferredForNight = pending.some(r => r.reason === 'quiet_hours')
  if (deferredForNight) return { flush: true, reason: 'quiet_hours_ended', rows: pending }

  const last = Number(getState(db, LAST_FLUSH_KEY))
  const lastMs = Number.isFinite(last) && last > 0 ? last : null
  // First run with something pending: flush rather than wait an arbitrary hour
  // measured from a timestamp that was never written.
  if (lastMs == null) return { flush: true, reason: 'first_flush', rows: pending }
  if (nowMs - lastMs >= HOUR_MS) return { flush: true, reason: 'hourly', rows: pending }
  return { flush: false, reason: 'within_hour', rows: pending }
}

/**
 * One flush pass — called once per loop cycle. Never throws.
 *
 * `send` is injected (the raw telegram sender) so the flush cannot recurse
 * back through the gate and re-queue its own digest.
 */
export async function flushDigest(db, { nowMs = Date.now(), send, force = false } = {}) {
  try {
    const cfg = loadNotifyConfig(db)
    const d = force
      ? { flush: pendingMessages(db).length > 0, reason: 'forced', rows: pendingMessages(db) }
      : flushDecision(db, cfg, nowMs)
    if (!d.flush) return { sent: false, reason: d.reason, count: d.rows.length }

    const label = d.reason === 'quiet_hours_ended' ? 'quiet hours' : 'past hour'
    const text = summarise(d.rows, { nowMs, tz: cfg.tz, label })
    if (!text) return { sent: false, reason: 'empty', count: 0 }

    const sender = send ?? (await import('./telegram.js')).sendMessageRaw
    // PLAIN, deliberately. The digest stitches first-lines of arbitrary alert
    // texts; under parse_mode Markdown one unmatched underscore anywhere in
    // 500 queued lines 400s the WHOLE message, the rows stay pending, and the
    // next pass retries the same unparseable batch forever — the 26-08-2026
    // "digest off since 11 AM" outage.
    await sender(text, { plain: true })
    // Marked ONLY after the send resolves — a Telegram outage must leave the
    // hour pending for the next pass, not swallow it.
    markSent(db, d.rows.map(r => r.id))
    setState(db, LAST_FLUSH_KEY, String(nowMs))
    try { setState(db, LAST_ERROR_KEY, '') } catch { /* status only */ }
    return { sent: true, reason: d.reason, count: d.rows.length }
  } catch (err) {
    const reason = `error: ${err?.message ?? err}`
    // Record the failure where /digest can show it. A flush that fails every
    // hour while the status line reads only "queued: 500" is a guard whose
    // record is stuck — the owner had no way to see WHY nothing arrived.
    try { setState(db, LAST_ERROR_KEY, `${new Date(nowMs).toISOString()} ${reason}`) } catch { /* status only */ }
    return { sent: false, reason, count: 0 }
  }
}

// --- the db handle the choke point uses -------------------------------------
// telegram.js's senders take (text, opts) and have no db. Rather than thread a
// handle through 78 call sites, the loop registers the open handle once at
// startup. Unregistered → routeOutbound sends immediately, so a missing wiring
// step cannot mute anything.
let _db = null
export function attachNotifyDb(db) { _db = db ?? null }
export function notifyDb() { return _db }

/**
 * The choke point. Returns true when the caller should perform the real send.
 * Anything it defers has already been written to the outbox.
 */
export function routeOutbound(text, opts = {}) {
  const db = _db
  if (!db) return { send: true, reason: 'no_db' }
  try {
    const cfg = loadNotifyConfig(db)
    const nowMs = opts.nowMs ?? Date.now()
    const d = routeDecision(cfg, { text, priority: opts.priority, nowMs })
    if (d.action === 'send') return { send: true, reason: d.reason }
    if (d.action === 'drop') {
      recordDropped(db, { priority: d.priority, kind: opts.kind ?? 'alert', nowMs })
      return { send: false, reason: d.reason, dropped: true }
    }
    const queued = queueMessage(db, {
      text, kind: opts.kind ?? 'alert', priority: d.priority, reason: d.reason,
    })
    // Could not persist it → send it. Dropping an alert to protect a
    // convenience feature would be the worst outcome available here.
    return queued ? { send: false, reason: d.reason } : { send: true, reason: 'queue_failed' }
  } catch {
    return { send: true, reason: 'route_error' }
  }
}

// --- the digest's state, as a read (V3 STK-08v2) ----------------------------
// What GET /state/telegram-digest serves and what the order-lifecycle rule
// STK-08 judges the Telegram outbox by: ONE reader, so the route and the
// rule cannot disagree about the same outbox (CLAUDE.md failure mode #3).
// Counts, times, reasons and the settings only — never a message's text,
// never a credential. Reads only; every statement goes through
// idx_tg_outbox_pending (telegram_outbox is one of the four large tables).

/**
 * The reason breakdown reads at most this many pending rows, the NEWEST
 * first: `reason` sits after `text` in the row, so each row read can walk
 * the text's overflow pages. Production 25-09-2026: 57,750 unsent rows in a
 * table measured at 380 MB — a full breakdown would read the whole table on
 * every 10-minute lifecycle pass. The reply says how many rows it covered
 * and whether that was all of them; the total and the oldest row are exact.
 */
export const DIGEST_REASON_ROWS_MAX = 2_000
export const DIGEST_STATE_SQL = Object.freeze({
  pending: 'SELECT COUNT(*) AS n FROM telegram_outbox WHERE sent_at IS NULL',
  oldest: 'SELECT id, queued_at, reason FROM telegram_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 1',
  reasons: `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS n, MIN(queued_at) AS oldest
              FROM (SELECT reason, queued_at FROM telegram_outbox WHERE sent_at IS NULL ORDER BY id DESC LIMIT ?)
             GROUP BY 1 ORDER BY n DESC, reason LIMIT 50`,
})

/** A flush error names what failed; a bot token inside a URL is not part of that. */
const redactToken = s => String(s).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')

/**
 * The digest's state. The configuration is read through loadNotifyConfig —
 * the loader routeDecision and flushDecision act on — and `configReadable`
 * says whether the stored value is usable: an unreadable value is repaired to
 * the default (enabled) by the loader, so it is never reported as OFF.
 * `configReadable` is: absent, or a stored JSON object (the definition the
 * watchdog contract's notificationPolicy used until it was removed on
 * 03-10-2026 with cpp-verify's delivery gate).
 * Throws when the outbox cannot be read — a caller reports that, never a 0.
 */
export function digestState(db, { nowMs = Date.now() } = {}) {
  let raw = null, configReadable = true, configError = null
  try { raw = getState(db, CONFIG_KEY) } catch (err) { configReadable = false; configError = `agent_state unreadable: ${err?.message ?? err}` }
  if (configReadable && raw != null) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    if (!(parsed != null && typeof parsed === 'object' && !Array.isArray(parsed))) { configReadable = false; configError = `${CONFIG_KEY} is not a JSON object` }
  }
  const cfg = loadNotifyConfig(db)
  const count = Number(db.prepare(DIGEST_STATE_SQL.pending).get()?.n) || 0
  const oldest = count > 0 ? db.prepare(DIGEST_STATE_SQL.oldest).get() : null
  const rows = count > 0 ? db.prepare(DIGEST_STATE_SQL.reasons).all(DIGEST_REASON_ROWS_MAX) : []
  const over = Math.min(count, DIGEST_REASON_ROWS_MAX)
  let lastFlushAt = null, lastError = null
  try {
    const last = Number(getState(db, LAST_FLUSH_KEY))
    lastFlushAt = Number.isFinite(last) && last > 0 ? new Date(last).toISOString() : null
    const e = getState(db, LAST_ERROR_KEY)
    lastError = e ? redactToken(e).slice(0, 300) : null
  } catch { /* status only: the outbox reading above stands */ }
  return {
    at: new Date(nowMs).toISOString(),
    configKey: CONFIG_KEY, configStored: raw != null, configReadable, configError,
    enabled: cfg.enabled, mode: cfg.mode, quiet: cfg.quiet, urgentBypass: cfg.urgentBypass, tz: cfg.tz,
    pending: { count, oldestQueuedAt: oldest?.queued_at ?? null, oldestReason: oldest ? (oldest.reason ?? '') : null },
    reasons: {
      rows: rows.map(r => ({ reason: r.reason, count: Number(r.n), oldestQueuedAt: r.oldest ?? null })),
      over, of: count, complete: over === count, window: 'newest pending rows first',
    },
    lastFlushAt, lastError,
    // While OFF nothing is queued; this is what was not sent, and since when.
    dropped: droppedState(db),
  }
}

/** One-line human summary of the current settings, for /status and /notify. */
export function describeConfig(cfg) {
  const parts = [cfg.enabled ? 'notify ON' : 'notify OFF (not sent, not queued: counted only)']
  parts.push(cfg.mode === 'hourly' ? 'hourly digest' : 'live')
  parts.push(cfg.quiet ? `quiet ${cfg.quiet.start}–${cfg.quiet.end} SGT` : 'no quiet hours')
  if (cfg.quiet && cfg.urgentBypass) parts.push('urgent still wakes you')
  return parts.join(' · ')
}
