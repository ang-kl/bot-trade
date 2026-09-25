// ---------------------------------------------------------------------------
// agent/services/broker-readings.js — server-side account readings, once a
// minute (V3 WEB-4; 8,989-A rows 1 and 5; owner default 25-09-2026 21:30 SGT:
// "the server reads each account every 60 s itself").
//
// THE DEFECT. Balance, floating P&L, equity and free margin, and the equity
// history they feed (captureSnapshotHistory → account_history), were refreshed
// only while a browser page was open: the page POSTed /actions/broker-positions
// every 60 s (src/lib/use-account-overview.js) and nothing on the server ever
// did. Measured 25-09 16:29 UTC with no page open: all seven overview rows read
// 'snapshot_stale', the last snapshot 13:30 UTC. History accrued only in the
// hours someone was looking, and the margin readings the risk gates take from
// the same per-account cache (5-minute limit) aged out with it.
//
// WHAT THIS DOES. Once a minute it asks for the SAME read the page asked for —
// the route's own builder, registered here by routes/actions.js — so the
// per-account caches, the account_history rows and every consumer of them keep
// their shape; only who asks changes. The route's coalescing cache is shared,
// so a page read and this read in flight at once are one broker round.
// Read-only: reconcile, trader, asset, symbol, trendbar, spot and unrealised
// P&L requests. Nothing here orders, amends or closes. Every registered
// account is read on the same terms; the host is routing only (principle 1).
//
// BOUNDED. At most one round in flight: a round that outlives its timeout
// keeps the lock until it settles, so no second round stacks behind a hung
// one (the cashflow collector's rule). Accounts are read three at a time (the
// builder's own limit). The first round waits for M1's first protection band
// (runtime-record.js `first.band`) or three minutes after BOOT, whichever
// comes first, so a restart's protection pass never queues behind seven
// account snapshots.
//
// ON THE MAIN THREAD. The owner asked for "off the main thread where the
// pattern exists". For broker reads it does not: every cTrader helper
// (lib/ctrader-ws.js) is an async WebSocket exchange on this thread, and the
// worker pattern here (performance-populations, order lifecycle) is a
// read-only SQLite reader with no broker session. The wait is I/O; M1's lag
// tap measures what the parsing costs.
//
// RECORD. `broker_readings_last_json`. `at` is the last round that recorded at
// least one account; a failed round carries it unchanged, so it ages on its
// own (the heartbeat effect limit) and no status read renews it. Each round
// names the accounts it could not read and the registered accounts the broker
// token did not return. Reasons are a fixed vocabulary: a transport message
// is never copied. The `broker_readings` heartbeat beats ok only when every
// registered account was read.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { disarmReason } from '../lib/env-disarm.js'
import { BOOT_ORIGIN_MS } from './boot-clock.js'
import { runtimeRecordSnapshot } from './runtime-record.js'

export const CONTROLLER_NAME = 'broker_readings'
export const READINGS_RECORD_KEY = 'broker_readings_last_json'
export const READINGS_INTERVAL_MS = 60_000
// Under the interval, so a timed-out round is recorded before the next tick.
export const READINGS_TIMEOUT_MS = 55_000
// Matches the heartbeat effect limit (heartbeat.js broker_readings maxAgeSec).
export const READINGS_MAX_AGE_MS = 5 * 60_000
export const FIRST_READ_MAX_DELAY_MS = 3 * 60_000
const MAX_LISTED = 64

const readers = new WeakMap()
const isoOk = s => typeof s === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(s) && Number.isFinite(Date.parse(s))
const idOf = v => /^[1-9]\d*$/.test(String(v)) ? String(v) : null

/** routes/actions.js hands over its broker-positions builder for all accounts. */
export function registerBrokerReadingsReader(db, read) {
  if (db && typeof read === 'function') readers.set(db, read)
}

/** A fixed vocabulary for a failed read — never the transport's own words. */
export function readingFailureReason(message) {
  const m = String(message ?? '')
  if (/^readings_[a-z_]+$/.test(m)) return m
  if (/no access token/i.test(m)) return 'no_access_token'
  if (/client id\/secret/i.test(m)) return 'client_credentials_missing'
  if (/not available on the broker token/i.test(m)) return 'account_not_on_token'
  if (/timeout|timed out/i.test(m)) return 'broker_timeout'
  if (/token|auth|denied|refused|unauthori[sz]ed/i.test(m)) return 'broker_auth_refused'
  return 'broker_read_failed'
}

/** The first round waits for M1's first protection band, or FIRST_READ_MAX_DELAY_MS after BOOT. */
export function firstReadReady(nowMs, { bootMs = BOOT_ORIGIN_MS, first = () => runtimeRecordSnapshot().first } = {}) {
  if (nowMs - bootMs >= FIRST_READ_MAX_DELAY_MS) return { ready: true, via: 'max_delay_after_boot' }
  let band = null
  try { band = first()?.band ?? null } catch { band = null }
  return band ? { ready: true, via: 'first_protection_band' } : { ready: false, reason: 'waiting_first_protection_band' }
}

function readRecord(db) {
  try {
    const rec = JSON.parse(getState(db, READINGS_RECORD_KEY) || 'null')
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null
  } catch { return null }
}

/** One round's outcome from the builder's reply, against the registered accounts. */
export function summariseRound(result, registered) {
  if (!result || result.ok !== true || !Array.isArray(result.accounts)) return null
  const returned = new Set(), recorded = [], failed = []
  for (const a of result.accounts) {
    const id = idOf(a?.accountId)
    if (!id) continue
    returned.add(id)
    if (a.error) failed.push({ accountId: id, reason: readingFailureReason(a.error) })
    else recorded.push(id)
  }
  const missing = registered.filter(id => !returned.has(id))
  return { recorded: recorded.sort(), failed: failed.sort((x, y) => x.accountId.localeCompare(y.accountId)), missing }
}

export function makeBrokerReadings(db, {
  read = () => {
    const reader = readers.get(db)
    if (!reader) throw new Error('readings_reader_unavailable')
    return reader()
  },
  clock = Date.now, timeoutMs = READINGS_TIMEOUT_MS, ready = firstReadReady, heartbeat = null,
  log = console.log,
} = {}) {
  let running = false, stopped = false, gateOpen = false
  const beatOnce = async (ok, error, detail) => {
    try { (heartbeat ?? await import('./heartbeat.js')).beat(db, CONTROLLER_NAME, { ok, error, detail }) }
    catch { /* the record still carries the outcome */ }
  }
  const poll = async () => {
    if (stopped) return { skipped: 'stopped' }
    if (running) return { skipped: 'in_flight' }
    const startedAt = clock()
    if (!gateOpen) {
      const gate = ready(startedAt)
      if (!gate.ready) {
        // Beat while waiting: the code ran and chose to wait. Silence here
        // would read as a stall after every restart; the record still ages.
        await beatOnce(true, null, { waiting: gate.reason })
        return { skipped: gate.reason }
      }
      gateOpen = true
    }
    running = true
    let task, timer
    const previous = readRecord(db)
    const finish = async (round, reason, fetchedAt) => {
      const recorded = round?.recorded ?? [], failed = round?.failed ?? [], missing = round?.missing ?? []
      const status = !round || !recorded.length ? 'failed' : failed.length || missing.length ? 'partial' : 'success'
      const why = status === 'success' ? null
        : reason ?? (failed[0]?.reason ?? (missing.length ? 'account_not_on_token' : 'no_account_read'))
      const at = recorded.length ? (isoOk(fetchedAt) ? fetchedAt : new Date(clock()).toISOString()) : (isoOk(previous?.at) ? previous.at : null)
      const durationMs = Math.max(0, clock() - startedAt)
      const record = {
        at, attemptAt: new Date(startedAt).toISOString(), status, reason: why, durationMs,
        intervalMs: READINGS_INTERVAL_MS,
        recorded: recorded.slice(0, MAX_LISTED), failed: failed.slice(0, MAX_LISTED), missing: missing.slice(0, MAX_LISTED),
        consecutiveFailures: status === 'success' ? 0 : (Number.isSafeInteger(previous?.consecutiveFailures) ? previous.consecutiveFailures : 0) + 1,
      }
      setState(db, READINGS_RECORD_KEY, JSON.stringify(record))
      // The route's POST invalidated the /state response cache on finish;
      // this read writes the same caches out of band, so it does the same.
      if (recorded.length) invalidateStateCache()
      await beatOnce(status === 'success', why, { recorded: recorded.length, failed: failed.length, missing: missing.length, durationMs })
      if (status !== 'success') log(`[broker-readings] ${status} reason=${why} recorded=${recorded.length} failed=${failed.map(f => f.accountId).join(',') || '-'} missing=${missing.join(',') || '-'}`)
      return { status, reason: why, recorded, failed, missing, at, durationMs }
    }
    try {
      task = Promise.resolve().then(read)
      // A transport that never settles holds this lock past our deadline, so
      // no later tick can stack a second round on the broker behind it.
      task.finally(() => { running = false }).catch(() => {})
      const result = await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('readings_timeout')), timeoutMs)
      })])
      if (stopped) return { skipped: 'stopped' }
      const registered = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all().map(r => idOf(r.account_id)).filter(Boolean)
      const round = summariseRound(result, registered)
      return await finish(round, round ? null : 'readings_malformed', result?.fetchedAt)
    } catch (err) {
      if (stopped) return { skipped: 'stopped' }
      return await finish(null, readingFailureReason(err?.message), null)
    } finally {
      clearTimeout(timer)
      if (!task) running = false
    }
  }
  return { poll, stop: () => { stopped = true } }
}

/** Start the minute ticker. Inert in a disarmed (staging) environment. Returns a stop function. */
export function startBrokerReadings(db, deps = {}) {
  if (disarmReason(deps.env)) return () => {}
  const readings = makeBrokerReadings(db, deps)
  const timer = (deps.setInterval ?? setInterval)(() => { void readings.poll().catch(() => {}) }, deps.intervalMs ?? READINGS_INTERVAL_MS)
  timer?.unref?.()
  return () => { (deps.clearInterval ?? clearInterval)(timer); readings.stop() }
}

/**
 * What the page is told about the server's own reading. Read-only; `at` is
 * never renewed here. `fresh` is judged now from the record's own `at`.
 */
export function brokerReadingsStatus(db, { nowMs = Date.now() } = {}) {
  const base = { source: 'server', intervalMs: READINGS_INTERVAL_MS, maxAgeMs: READINGS_MAX_AGE_MS }
  const rec = readRecord(db)
  if (!rec) return { ...base, status: 'no_record', reason: null, at: null, attemptAt: null, ageMs: null, fresh: false, failed: [], missing: [] }
  const at = isoOk(rec.at) ? rec.at : null
  const ageMs = at ? nowMs - Date.parse(at) : null
  const ids = list => Array.isArray(list) ? list.slice(0, MAX_LISTED) : []
  return {
    ...base,
    status: ['success', 'partial', 'failed'].includes(rec.status) ? rec.status : 'unknown',
    reason: typeof rec.reason === 'string' && /^[a-z_]{1,60}$/.test(rec.reason) ? rec.reason : null,
    at, attemptAt: isoOk(rec.attemptAt) ? rec.attemptAt : null, ageMs,
    fresh: ageMs != null && ageMs >= 0 && ageMs < READINGS_MAX_AGE_MS,
    failed: ids(rec.failed).map(f => ({ accountId: idOf(f?.accountId), reason: typeof f?.reason === 'string' ? f.reason : null })).filter(f => f.accountId),
    missing: ids(rec.missing).map(idOf).filter(Boolean),
  }
}
