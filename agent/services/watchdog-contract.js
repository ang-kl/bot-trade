import { getState } from '../db.js'
import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar, calendarIntervals, contractCalendar } from '../lib/calendar-intervals.js'
import { loadNotifyConfig } from './telegram-digest.js'
import { DEFAULT_SENT_TIMEOUT_MS } from './entry-ledger.js'
import { scannerWork, watchdogCalendars } from './scanner-work.js'
import { entryDiagnostics } from './blocker-report.js'
import { marketIdentityKey } from '../lib/market-identity.js'

const read = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const time = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : null }
const DAY = 86400_000
// cpp-verify rejects a Node contract over 256 KiB (watchdog_state.cpp) and an
// oversize contract empties `work` here, which blinds the watchdog.
export const CONTRACT_MAX_BYTES = 256 * 1024
let quietCache = null
function notificationPolicy(db, now) {
  const cfg = loadNotifyConfig(db), raw = getState(db, 'telegram_notify_json')
  // Preserve the master's OFF and treat a corrupt persisted policy as unknown.
  const parsed = read(db, 'telegram_notify_json')
  const valid = raw == null || (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed))
  const owner = getState(db, 'watchdog_incident_owner') === 'cpp-verify' ? 'cpp-verify' : 'node'
  let quietIntervals = []
  const from = Math.floor(now / DAY) * DAY, to = from + 2 * DAY
  try {
    if (cfg.quiet) {
      const key = JSON.stringify([cfg.quiet, cfg.tz, from])
      if (quietCache?.key !== key) {
        const sec = s => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60 }
        const a = sec(cfg.quiet.start), b = sec(cfg.quiet.end)
        const schedule = Array.from({ length: 7 }, (_, day) => ({ startSecond: day * 86400 + a,
          endSecond: (day * 86400 + (b > a ? b : 86400 + b)) % (7 * 86400) }))
        quietCache = { key, intervals: calendarIntervals({ scheduleTimeZone: cfg.tz, schedule, holiday: [] }, from, to) }
      }
      quietIntervals = quietCache.intervals
    }
  } catch { return { enabled: false, owner, observedAtMs: now, expiresAtMs: now, quietIntervals: [], reason: 'notification_timezone_unknown' } }
  return { enabled: valid && cfg.enabled, owner, observedAtMs: now, expiresAtMs: now + DAY,
    quietIntervals, urgentBypass: cfg.urgentBypass, source: 'telegram_notify_json' }
}

const exactKey = (accountId, host, symbolId) => [accountId, host, symbolId].every(v => typeof v === 'string' && v) ? `${accountId}|${host}|${symbolId}` : null
/**
 * V3 K1 — each calendar once. cpp-verify gives every work item of every
 * service the `calendars` entry whose identity matches its accountId, host
 * and symbolId as exact strings (watchdog_state.cpp:148-152), replacing
 * whatever the item carried. So a Node work item whose identity is exported
 * with a calendar need not repeat it: the item drops its copy and says where
 * it is (`calendarIn`). An item whose identity is not exported (beyond the
 * 96 KiB export bound) keeps its own, in the same contract shape. An item
 * whose calendar is null keeps its null. Measured before this change on a
 * realistic seven-account load: every position, scan and entry_activity item
 * repeated a ~1 KB calendar the export already held, and the contract passed
 * 256 KiB — which empties `work` and blinds the verifier.
 */
function shareCalendars(work, calendars, now) {
  const exported = new Set()
  for (const c of calendars) if (c.calendar) exported.add(exactKey(c.identity?.accountId, c.identity?.host, c.identity?.symbolId))
  for (const w of work) {
    if (w.calendar == null) continue
    if (exported.has(exactKey(w.accountId, w.host, w.symbolId))) { delete w.calendar; w.calendarIn = 'calendars' }
    else w.calendar = contractCalendar(w.calendar, now)
  }
}

/** Completed-work evidence only. No broker request, mutation or entry gate. */
export function nodeWatchdogContract(db, { now = Date.now() } = {}) {
  const accounts = new Map(db.prepare('SELECT account_id,is_live FROM accounts').all().map(a => [String(a.account_id), a]))
  const receipts = read(db, 'fast_monitor_position_work_json')
  const byPosition = new Map((Array.isArray(receipts?.positions) ? receipts.positions : []).map(r => [`${r.accountId}:${r.positionId}`, r]))
  const positions = db.prepare("SELECT id,account_id,symbol,source,created_at FROM monitored_positions WHERE status='active' AND paused IS NOT 1 LIMIT 2049").all()
  const work = [], maps = new Map()
  for (const p of positions.slice(0, 2048)) {
    if (p.source === 'external') continue // human ownership; broker protection audit remains independent
    const accountId = p.account_id == null ? null : String(p.account_id), account = accounts.get(accountId)
    const r = byPosition.get(`${accountId}:${p.id}`)
    const host = account == null ? null : account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    if (!maps.has(accountId)) maps.set(accountId, getAccountSymbolMap(db, accountId)?.map)
    const symbolId = maps.get(accountId)?.[String(p.symbol).toUpperCase()]
    const identity = { provider: 'ctrader', accountId, host, symbolId }
    let calendar = null
    try { calendar = projectCalendar(readMarketCalendar(db, identity, { nowMs: now }), now) } catch { /* evidence unavailable */ }
    const paused = r?.state === 'manage_off'
    work.push({ id: `position:${p.id}`, role: paused ? 'management_paused' : 'management',
      accountId, host, symbolId: symbolId == null ? null : String(symbolId), positionId: String(p.id),
      calendar, lastCompletedAtMs: time(r?.lastCompletedAt),
      nextDueMs: paused ? null : time(r?.nextDueAt) ?? time(p.created_at),
      // No invented closed-market audit cadence. This remains an explicit
      // missing contract until the management owner publishes that deadline.
      closedAuditDueMs: null, blocker: r?.state || 'management_receipt_unavailable',
      reason: paused ? 'management_configured_off' : 'due_management', receiptAtMs: time(receipts?.at) })
  }
  const intents = db.prepare("SELECT id,account_id,symbol_id,state,updated_at,error_code FROM entry_intents WHERE state IN ('DISPATCHING','SENT','UNKNOWN') LIMIT 2049").all()
  for (const row of intents.slice(0, 2048)) work.push({ id: `intent:${row.id}`, role: 'intent', accountId: row.account_id,
    symbolId: row.symbol_id == null ? null : String(row.symbol_id), state: row.state,
    deadlineMs: time(row.updated_at) == null ? null : time(row.updated_at) + (row.state === 'UNKNOWN' ? 0 : DEFAULT_SENT_TIMEOUT_MS),
    reason: 'terminal_acknowledgement', blocker: row.error_code || null })
  work.push(...scannerWork(db, accounts, now))
  // V3 C4 (WP-C PR-C1): Node's own per-account entry records for cpp-verify
  // to relay (never broker-verified). It must never fail or empty the
  // contract: a throw becomes an explicit unavailable block, and at the size
  // bound it is the FIRST thing dropped, before `work`.
  let diagnostics
  try { diagnostics = entryDiagnostics(db, { now }) } catch { diagnostics = { schemaVersion: 1, source: 'node_records', observedAtMs: now, complete: false, reason: 'entry_diagnostics_unavailable', accounts: [] } }
  const lead = new Set()
  for (const w of work) if (w.calendar != null) { const key = marketIdentityKey({ accountId: w.accountId, host: w.host, symbolId: w.symbolId }); if (key) lead.add(key) }
  const calendars = watchdogCalendars(db, now, { lead })
  shareCalendars(work, calendars.calendars, now)
  const out = { schemaVersion: 1, service: 'node', observedAtMs: now, ...calendars, workComplete: positions.length <= 2048 && intents.length <= 2048 && work.length <= 2048 && !work.some(w => w.inventoryComplete === false),
    work: work.slice(0, 2048), notificationPolicy: notificationPolicy(db, now), entryDiagnostics: diagnostics,
    limitations: ['Scanner work is published by its actual owner; a Node timer is not a scanner receipt.', 'No closed-market management deadline has been invented.',
      'A work item marked calendarIn "calendars" carries no calendar of its own: its calendar is the calendars entry with the same accountId, host and symbolId.'] }
  if (Buffer.byteLength(JSON.stringify(out)) > CONTRACT_MAX_BYTES) out.entryDiagnostics = { schemaVersion: 1, source: 'node_records', observedAtMs: now, complete: false, reason: 'contract_size_bound', accounts: [] }
  if (Buffer.byteLength(JSON.stringify(out)) > CONTRACT_MAX_BYTES) { out.workComplete = false; out.work = []; out.calendars = []; out.calendarsComplete = false; out.exportComplete = false; out.reason = 'work_contract_size_bound' }
  return out
}
