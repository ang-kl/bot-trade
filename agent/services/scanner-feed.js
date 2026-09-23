import { randomUUID, createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { FIB_PROFILE, matchingProfile, recordReference, comparisonRecord, claimReferenceDelivery, markReferenceDelivery } from './scanner-comparison.js'

const bridges = new WeakMap(), epoch = randomUUID()
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

/** The reference result was produced by the existing strategy on these bars. */
export async function publishTimeframeEvaluation(db, job, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const source = 'cpp-scan-timeframe', profile = matchingProfile(db, source, job)
  if (!profile) return { state: 'profile_unregistered' }
  const id = hash(JSON.stringify([job.feed, job.feedEpoch, job.configVersion, job.profileHash, job.timeframe, job.bars?.at(-1)?.t]))
  const unsupported = job.strategy !== 'fib_618_fade' || job.profileHash !== FIB_PROFILE || job.nativeCompatible !== true
  if (unsupported) { comparisonRecord(db, id, source, 'unsupported_reference_semantics', { feed: job.feed, strategy: job.strategy, timeframe: job.timeframe }, now); return { state: 'unsupported' } }
  const duration = tfMs(job.timeframe)
  if (!duration || !Array.isArray(job.bars) || !job.bars.length || job.bars.length > 4096
    || !Number.isSafeInteger(job.receivedAtMs) || job.receivedAtMs > now
    || job.bars.some((b, i) => !Number.isSafeInteger(b.t) || b.t < 0 || b.t + duration > job.receivedAtMs
      || (i && b.t <= job.bars[i - 1].t) || !['o', 'h', 'l', 'c', 'v'].every(k => Number.isFinite(b[k]) && b[k] >= 0)
      || b.l <= 0 || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c))
    || !Number.isSafeInteger(profile.candidateTtlMs) || profile.candidateTtlMs < 1 || profile.candidateTtlMs > 3600_000)
    throw new Error('bar_input_invalid')
  let body = { schemaVersion: 1, purpose: 'mirror', feed: job.feed, feedEpoch: job.feedEpoch,
    configVersion: job.configVersion, profileHash: job.profileHash, candidateTtlMs: profile.candidateTtlMs,
    strategy: job.strategy, timeframe: job.timeframe, barMode: 'closed', barDurationMs: duration, options: {},
    receivedAtMs: job.receivedAtMs, sourceTimestampMs: job.bars.at(-1).t,
    barCloseAtMs: job.bars.at(-1).t + duration, bars: job.bars,
    inputHash: hash(JSON.stringify(job.bars)), calendar: projectCalendar(readMarketCalendar(db, job.feed, { nowMs: now }), now) }
  if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new Error('bar_input_bound')
  const reference = recordReference(db, body, job.reference, now)
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
export function boundedScannerObserver(send, { capacity = 32 } = {}) {
  let pending = 0, dropped = 0, failed = false
  return {
    offer(job) {
      if (failed || pending >= capacity || !Array.isArray(job.bars) || job.bars.length > 4096) { dropped++; return false }
      try { send(job); pending++; return true } catch { dropped++; failed = true; return false }
    },
    acknowledge() { pending = Math.max(0, pending - 1) },
    fail() { failed = true },
    status: () => ({ enabled: true, pending, dropped, failed, capacity, orderAuthority: false }),
  }
}
export function scannerObserver(db, creds, env = process.env) {
  if (env.SCANNER_BRIDGE_ENABLED !== '1' || !db.name || db.name === ':memory:') return null
  let profiles
  try { profiles = JSON.parse(getState(db, 'scanner_mirror_profiles_json') || 'null') } catch { return null }
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 512) return null
  let bridge = bridges.get(db)
  if (!bridge) {
    let worker
    bridge = boundedScannerObserver(job => worker.postMessage(job)); bridges.set(db, bridge)
    try { worker = new Worker(new URL('./scanner-bridge-worker.js', import.meta.url), { workerData: { path: db.name },
      env: Object.fromEntries(['SCANNER_TICK_URL', 'SCANNER_TICK_SECRET', 'SCANNER_TIMEFRAME_URL', 'SCANNER_TIMEFRAME_SECRET'].filter(k => env[k]).map(k => [k, env[k]])),
      resourceLimits: { maxOldGenerationSizeMb: 128 } }) } catch { bridge.fail(); return null }
    worker.on('message', () => bridge.acknowledge()); worker.on('error', () => bridge.fail()); worker.on('exit', () => bridge.fail()); worker.unref()
  }
  return input => {
    const feed = { provider: 'ctrader', host: creds.host, accountId: String(creds.accountId), symbolId: String(input.symbolId) }
    // Old cache entries or a cache from a different account cannot be relabelled.
    if (input.cacheIdentity?.host !== feed.host || String(input.cacheIdentity?.accountId) !== feed.accountId) return false
    for (const profile of profiles.filter(p => p.source === 'cpp-scan-timeframe' && p.feed?.host === feed.host
      && p.feed?.accountId === feed.accountId && p.feed?.symbolId === feed.symbolId && p.timeframe === input.timeframe && p.strategy === input.strategy)) {
      bridge.offer({ ...input, feed, feedEpoch: epoch, configVersion: profile.configVersion, profileHash: profile.profileHash })
    }
  }
}
export const scannerBridgeStatus = db => bridges.get(db)?.status() || { enabled: false, orderAuthority: false }
