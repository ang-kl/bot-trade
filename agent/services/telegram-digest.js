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
export function saveNotifyConfig(db, patch) {
  const next = { ...loadNotifyConfig(db), ...patch }
  setState(db, CONFIG_KEY, JSON.stringify(next))
  return loadNotifyConfig(db)
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
    return { action: 'queue', reason: 'notify_off', priority: p }
  }
  const quiet = inQuietHours(nowMs, cfg.quiet, cfg.tz)
  if (p === 'urgent' && cfg.urgentBypass) {
    return { action: 'send', reason: quiet ? 'urgent_bypass_quiet' : 'live', priority: p }
  }
  if (quiet) return { action: 'queue', reason: 'quiet_hours', priority: p }
  if (cfg.mode === 'hourly') return { action: 'queue', reason: 'hourly_digest', priority: p }
  return { action: 'send', reason: 'live', priority: p }
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

/** Pending (unsent) outbox rows, oldest first. */
export function pendingMessages(db, limit = 500) {
  try {
    return db.prepare(
      `SELECT id, queued_at, kind, priority, text, reason FROM telegram_outbox
        WHERE sent_at IS NULL ORDER BY id ASC LIMIT ?`,
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
  if (text.length > TG_TEXT_MAX) text = `${text.slice(0, TG_TEXT_MAX - 3)}...`
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
    await sender(text)
    // Marked ONLY after the send resolves — a Telegram outage must leave the
    // hour pending for the next pass, not swallow it.
    markSent(db, d.rows.map(r => r.id))
    setState(db, LAST_FLUSH_KEY, String(nowMs))
    return { sent: true, reason: d.reason, count: d.rows.length }
  } catch (err) {
    return { sent: false, reason: `error: ${err?.message ?? err}`, count: 0 }
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

/** One-line human summary of the current settings, for /status and /notify. */
export function describeConfig(cfg) {
  const parts = [cfg.enabled ? 'notify ON' : 'notify OFF (queued, not dropped)']
  parts.push(cfg.mode === 'hourly' ? 'hourly digest' : 'live')
  parts.push(cfg.quiet ? `quiet ${cfg.quiet.start}–${cfg.quiet.end} SGT` : 'no quiet hours')
  if (cfg.quiet && cfg.urgentBypass) parts.push('urgent still wakes you')
  return parts.join(' · ')
}
