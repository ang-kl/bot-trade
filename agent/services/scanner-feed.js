import { randomUUID, createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { matchingProfile, recordReference, comparisonRecord, claimReferenceDelivery, markReferenceDelivery } from './scanner-comparison.js'
import { nativeProfileHash } from './scanner-profiles.js'
import { SCANNER_PROFILE_LIMIT } from '../lib/scanner-bounds.js'

const bridges = new WeakMap(), restarts = new WeakMap(), epoch = randomUUID()
const hash = text => createHash('sha256').update(text).digest('hex')

// HTTP belongs to the isolated observation worker. No credential can be sent
// through redirects or embedded URL auth. The deadline includes body reading.
export async function scannerRequest(base, secret, path, body, fetchImpl = fetch) {
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !secret) throw new Error('scanner_endpoint_invalid')
  const [pathname, query = ''] = path.split('?')
  url.pathname = `${url.pathname.replace(/\/$/, '')}${pathname}`
  url.search = query
  const response = await fetchImpl(url, { method: body == null ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(2000), headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body == null ? {} : { body: JSON.stringify(body) }) })
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 256 * 1024) throw new Error('scanner_response_bound')
    chunks.push(chunk)
  }
  if (body == null ? response.status !== 200 : response.status !== 202) throw new Error('scanner_transport_refused')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Why an input is refused, so the refusal population can tell an absent cache
// (no bars, no receipt time) from a forming last bar judged closed, bad OHLC
// or a bad TTL. Any reason here is exactly the old 'bar_input_invalid'.
function barInputRefusal(job, profile, duration, now) {
  if (!duration) return 'timeframe_unknown'
  if (!Array.isArray(job.bars) || !job.bars.length) return 'bars_empty'
  if (job.bars.length > 4096) return 'bars_bound'
  if (!Number.isSafeInteger(job.receivedAtMs) || job.receivedAtMs > now) return 'received_at_invalid'
  for (let i = 0; i < job.bars.length; i++) {
    const b = job.bars[i]
    if (!b || typeof b !== 'object') return 'bar_shape_invalid'
    if (!Number.isSafeInteger(b.t) || b.t < 0 || (i && b.t <= job.bars[i - 1].t)) return 'bar_time_invalid'
    if (b.t + duration > job.receivedAtMs) return i === job.bars.length - 1 ? 'last_bar_partial' : 'bar_not_closed'
    if (!['o', 'h', 'l', 'c', 'v'].every(k => Number.isFinite(b[k]) && b[k] >= 0)
      || b.l <= 0 || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) return 'ohlc_invalid'
  }
  if (!Number.isSafeInteger(profile.candidateTtlMs) || profile.candidateTtlMs < 1 || profile.candidateTtlMs > 3600_000) return 'ttl_invalid'
  return null
}

/** The reference result was produced by the existing strategy on these bars. */
export async function publishTimeframeEvaluation(db, job, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const source = 'cpp-scan-timeframe', profile = matchingProfile(db, source, job)
  if (!profile) return { state: 'profile_unregistered' }
  const id = hash(JSON.stringify([job.feed, job.feedEpoch, job.configVersion, job.profileHash, job.timeframe, job.bars?.at(-1)?.t]))
  const options = job.nativeOptions ?? {}
  const supportedProfile = nativeProfileHash(job.strategy, options)
  const unsupported = !supportedProfile || job.profileHash !== supportedProfile || job.nativeCompatible !== true
  if (unsupported) { comparisonRecord(db, id, source, 'unsupported_reference_semantics', { feed: job.feed, strategy: job.strategy, timeframe: job.timeframe }, now); return { state: 'unsupported' } }
  // The worker swallows these throws (scanner-bridge-worker.js), so each
  // refusal is recorded first: one row per refused input and reason.
  const refuse = (error, reason) => {
    try { comparisonRecord(db, `${id}:${error}:${reason}`, source, 'input_refused', { feed: job.feed, strategy: job.strategy, timeframe: job.timeframe, error, reason }, now) }
    catch { /* the refusal itself still throws below */ }
    return new Error(error)
  }
  const duration = tfMs(job.timeframe)
  const refusal = barInputRefusal(job, profile, duration, now)
  if (refusal) throw refuse('bar_input_invalid', refusal)
  let body = { schemaVersion: 1, purpose: 'mirror', feed: job.feed, feedEpoch: job.feedEpoch,
    configVersion: job.configVersion, profileHash: job.profileHash, candidateTtlMs: profile.candidateTtlMs,
    strategy: job.strategy, timeframe: job.timeframe, barMode: 'closed', barDurationMs: duration, options,
    receivedAtMs: job.receivedAtMs, sourceTimestampMs: job.bars.at(-1).t,
    barCloseAtMs: job.bars.at(-1).t + duration, bars: job.bars,
    inputHash: hash(JSON.stringify(job.bars)), calendar: projectCalendar(readMarketCalendar(db, job.feed, { nowMs: now }), now) }
  if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw refuse('bar_input_bound', 'request_bound')
  let reference
  try { reference = recordReference(db, body, job.reference, now) } catch (error) {
    if (error?.message === 'reference_identity_conflict') throw refuse('reference_identity_conflict', 'reference_identity_conflict')
    throw error
  }
  if (!claimReferenceDelivery(db, reference.id)) return { state: 'already_delivered_or_retry_budget_exhausted' }
  if (reference.original) { body = { ...reference.original, bars: job.bars }; delete body.reference }
  try {
    const receipt = await scannerRequest(env.SCANNER_TIMEFRAME_URL, env.SCANNER_TIMEFRAME_SECRET, '/evaluate', body, fetchImpl)
    if (receipt.orderAuthority !== false || (!receipt.queued && !receipt.duplicate)) throw new Error('scanner_ack_invalid')
    markReferenceDelivery(db, reference.id, 'delivered')
    return { state: 'delivered', orderAuthority: false }
  } catch (error) {
    markReferenceDelivery(db, reference.id, 'failed')
    comparisonRecord(db, `${reference.id}:delivery`, source, 'delivery_failed', { feed: job.feed, reason: 'scanner_transport_or_contract_unavailable' }, now)
    throw error
  }
}

// Admission into this local queue is not scanner activation. The worker is
// constructed only under the separately approved SCANNER_BRIDGE_ENABLED flag.
// At most 32 bounded messages are in flight; no network or SQLite work is done
// inside a strategy callback. Failures cannot alter its reference result.
// A job the worker cannot accept (a send() throw, e.g. an uncloneable value)
// is that job's failure: it is counted and dropped and the worker stays up.
// Only fail() marks the bridge failed: a worker 'error'/'exit' or a
// construction throw, which ensureScannerBridge then rebuilds.
export function boundedScannerObserver(send, { capacity = 32 } = {}) {
  let pending = 0, dropped = 0, failed = false, failure = null, sendFailures = 0, lastSendError = null
  return {
    offer(job) {
      if (failed || pending >= capacity || !Array.isArray(job.bars) || job.bars.length > 4096) { dropped++; return false }
      try { send(job); pending++; return true } catch (error) {
        dropped++; sendFailures++; lastSendError = String(error?.name || 'send_failed').slice(0, 64); return false
      }
    },
    acknowledge() { pending = Math.max(0, pending - 1) },
    fail(cause = 'worker_failed') { if (!failed) failure = cause; failed = true },
    status: () => ({ enabled: true, pending, dropped, failed, failure, sendFailures, lastSendError, capacity, orderAuthority: false }),
  }
}

const WORKER_ENV = ['SCANNER_TICK_URL', 'SCANNER_TICK_SECRET', 'SCANNER_TIMEFRAME_URL', 'SCANNER_TIMEFRAME_SECRET']
const REBUILD_MIN_MS = 30_000, ENSURE_EVERY_MS = 60_000
const newWorker = (url, options) => new Worker(url, options)

// The approval gate, unchanged: the flag, a file database (the worker opens
// its own connection) and 1..SCANNER_PROFILE_LIMIT registered profiles.
function approvedProfiles(db, env) {
  if (env.SCANNER_BRIDGE_ENABLED !== '1' || !db.name || db.name === ':memory:') return null
  let profiles
  try { profiles = JSON.parse(getState(db, 'scanner_mirror_profiles_json') || 'null') } catch { return null }
  return Array.isArray(profiles) && profiles.length && profiles.length <= SCANNER_PROFILE_LIMIT ? profiles : null
}
function buildBridge(db, env, createWorker, now) {
  const record = { worker: null, builtAtMs: now }
  record.bridge = boundedScannerObserver(job => record.worker.postMessage(job))
  bridges.set(db, record)
  try {
    record.worker = createWorker(new URL('./scanner-bridge-worker.js', import.meta.url), { workerData: { path: db.name },
      env: Object.fromEntries(WORKER_ENV.filter(k => env[k]).map(k => [k, env[k]])),
      resourceLimits: { maxOldGenerationSizeMb: 128 } })
  } catch { record.bridge.fail('worker_construction'); return record }
  const { bridge, worker } = record
  worker.on('message', () => bridge.acknowledge())
  worker.on('error', () => bridge.fail('worker_error'))
  worker.on('exit', () => bridge.fail('worker_exit'))
  worker.unref?.()
  return record
}

/**
 * The one construction path for the bridge worker (timeframe publishing and
 * the tick/candidate collector). Returns null while the gate is closed, else
 * { bridge, profiles }. A bridge whose worker errored, exited or failed to
 * construct is terminated and rebuilt, at most once per REBUILD_MIN_MS
 * whichever caller reaches it first; a failed send() never triggers this.
 */
export function ensureScannerBridge(db, env = process.env, { createWorker = newWorker, now = Date.now() } = {}) {
  const profiles = approvedProfiles(db, env)
  if (!profiles) return null
  let record = bridges.get(db)
  if (record?.bridge.status().failed && now - record.builtAtMs >= REBUILD_MIN_MS) {
    try { Promise.resolve(record.worker?.terminate()).catch(() => {}) } catch { /* already gone */ }
    restarts.set(db, (restarts.get(db) || 0) + 1)
    record = null
  }
  if (!record) record = buildBridge(db, env, createWorker, now)
  return { bridge: record.bridge, profiles }
}

/**
 * Boot-time starter, called from startLoop and not from runLoop: the loop's
 * breaker and skip paths return early, and collection must not depend on the
 * bar scan being reached (scan off, weekend quiet, creds not ready).
 */
export function startScannerBridge(db, { env = process.env, setInterval: every = setInterval, clearInterval: stop = clearInterval, createWorker, now = Date.now } = {}) {
  const ensure = () => {
    try { ensureScannerBridge(db, env, { createWorker, now: now() }) } catch { /* unreadable state: the next tick retries */ }
  }
  ensure()
  const timer = every(ensure, ENSURE_EVERY_MS)
  timer?.unref?.()
  return () => stop(timer)
}

export function scannerObserver(db, creds, env = process.env, deps = {}) {
  const ensured = ensureScannerBridge(db, env, deps)
  if (!ensured) return null
  const { bridge } = ensured, host = creds.host, accountId = String(creds.accountId)
  // One index per call: each evaluation looks up its own cell rather than
  // filtering every profile (about 1,560 evaluations a cycle, up to 1024
  // profiles). The key is the exact (symbolId, timeframe, strategy) triple as
  // JSON (the registry admits only string values for these), so no delimiter
  // inside a value can make two cells collide and a hit needs no re-check.
  const cells = new Map()
  const cell = (symbolId, timeframe, strategy) => JSON.stringify([symbolId, timeframe, strategy])
  for (const p of ensured.profiles) {
    if (p?.source !== 'cpp-scan-timeframe' || p.feed?.host !== host || p.feed?.accountId !== accountId) continue
    const key = cell(p.feed.symbolId, p.timeframe, p.strategy)
    if (cells.has(key)) cells.get(key).push(p); else cells.set(key, [p])
  }
  return input => {
    const feed = { provider: 'ctrader', host, accountId, symbolId: String(input.symbolId) }
    // Old cache entries or a cache from a different account cannot be relabelled.
    if (input.cacheIdentity?.host !== feed.host || String(input.cacheIdentity?.accountId) !== feed.accountId) return false
    for (const profile of cells.get(cell(feed.symbolId, input.timeframe, input.strategy)) || []) {
      bridge.offer({ ...input, feed, feedEpoch: epoch, configVersion: profile.configVersion, profileHash: profile.profileHash })
    }
  }
}
export const scannerBridgeStatus = db => {
  const record = bridges.get(db)
  return record ? { ...record.bridge.status(), restarts: restarts.get(db) || 0, builtAtMs: record.builtAtMs } : { enabled: false, orderAuthority: false }
}
