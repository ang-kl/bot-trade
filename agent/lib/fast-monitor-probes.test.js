// node --test agent/lib/fast-monitor-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Pins the two mechanisms fast-monitor.js's
// broker-fallback batch relies on: the CAP (how many probes may launch at
// once) and the BACKOFF (how often the same quiet symbol may be re-probed),
// plus the scheduler that wires them together.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROBE_CAP_DEFAULT, PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_DEFAULT_MS,
  probeCap, probeBackoffMs, shouldBackoff, selectUnderCap,
  sideHasFreshQuoteExcluding, ProbeScheduler,
} from './fast-monitor-probes.js'

// ---------------------------------------------------------------------------
// probeCap / probeBackoffMs — env overrides, with OD-22's ceiling enforced
// ---------------------------------------------------------------------------

test('probeCap: env override, garbage falls back to the default', () => {
  assert.equal(probeCap({}), PROBE_CAP_DEFAULT)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '3' }), 3)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '0' }), PROBE_CAP_DEFAULT)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '-1' }), PROBE_CAP_DEFAULT)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: 'nope' }), PROBE_CAP_DEFAULT)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '2.7' }), 2, 'floored')
})

test('probeBackoffMs: OD-22 ceiling (<= 5 min) holds even when the env asks for more', () => {
  assert.equal(probeBackoffMs({}), PROBE_BACKOFF_DEFAULT_MS)
  assert.equal(probeBackoffMs({ FAST_MONITOR_PROBE_BACKOFF_MS: '30000' }), 30_000)
  assert.equal(probeBackoffMs({ FAST_MONITOR_PROBE_BACKOFF_MS: String(PROBE_BACKOFF_MAX_MS) }), PROBE_BACKOFF_MAX_MS)
  assert.equal(probeBackoffMs({ FAST_MONITOR_PROBE_BACKOFF_MS: String(PROBE_BACKOFF_MAX_MS * 10) }), PROBE_BACKOFF_MAX_MS, 'clamped to the ceiling, never above it')
  assert.equal(probeBackoffMs({ FAST_MONITOR_PROBE_BACKOFF_MS: '0' }), PROBE_BACKOFF_DEFAULT_MS)
  assert.equal(probeBackoffMs({ FAST_MONITOR_PROBE_BACKOFF_MS: 'garbage' }), PROBE_BACKOFF_DEFAULT_MS)
})

// ---------------------------------------------------------------------------
// shouldBackoff — the OD-22 condition: arms ONLY when the rest of the side
// is fresh, and never for a symbol that has not been probed yet.
// ---------------------------------------------------------------------------

test('shouldBackoff: never arms for a symbol probed for the first time', () => {
  assert.equal(shouldBackoff({ lastProbeAtMs: null, nowMs: 1_000, backoffMs: 60_000, sideHasFreshQuote: true }), false)
})

test('shouldBackoff: never arms while the REST of the side is not fresh (a feed outage keeps retrying)', () => {
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 1_500, backoffMs: 60_000, sideHasFreshQuote: false }), false, 'quiet feed, not a quiet symbol — must keep retrying')
})

test('shouldBackoff: arms only inside the window, only when the side is fresh', () => {
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 1_500, backoffMs: 60_000, sideHasFreshQuote: true }), true)
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 61_001, backoffMs: 60_000, sideHasFreshQuote: true }), false, 'the window has elapsed')
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 61_000, backoffMs: 60_000, sideHasFreshQuote: true }), false, 'exactly the boundary is not still inside it')
})

test('shouldBackoff: non-finite or missing inputs never arm (a guard that cannot be evaluated never fires)', () => {
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: NaN, backoffMs: 60_000, sideHasFreshQuote: true }), false)
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 1_500, backoffMs: 0, sideHasFreshQuote: true }), false)
  assert.equal(shouldBackoff({ lastProbeAtMs: 1_000, nowMs: 1_500, backoffMs: -5, sideHasFreshQuote: true }), false)
})

// ---------------------------------------------------------------------------
// selectUnderCap — the concurrency ceiling
// ---------------------------------------------------------------------------

test('selectUnderCap: launches only up to the room the cap leaves, in order; the rest are deferred', () => {
  assert.deepEqual(selectUnderCap(['a', 'b', 'c'], 0, 2), { launch: ['a', 'b'], deferred: ['c'] })
  assert.deepEqual(selectUnderCap(['a', 'b', 'c'], 2, 2), { launch: [], deferred: ['a', 'b', 'c'] }, 'no room left')
  assert.deepEqual(selectUnderCap(['a', 'b'], 0, 8), { launch: ['a', 'b'], deferred: [] }, 'cap far above the candidate count')
  assert.deepEqual(selectUnderCap([], 0, 8), { launch: [], deferred: [] })
  assert.deepEqual(selectUnderCap(['a'], 5, 2), { launch: [], deferred: ['a'] }, 'inflight already above the cap')
})

// ---------------------------------------------------------------------------
// sideHasFreshQuoteExcluding — "OTHER symbols on the side", never the probed
// symbol itself, stale or otherwise (V3-SEQUENCE:539)
// ---------------------------------------------------------------------------

test('sideHasFreshQuoteExcluding: a fresh OTHER symbol counts; the excluded symbol never does, fresh or not', () => {
  const now = 1_000_000
  const maxAge = 10_000
  const onlySelfFresh = new Map([[1, { recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(onlySelfFresh, 1, now, maxAge), false, 'the only entry is the excluded symbol itself')
  const otherFresh = new Map([[1, { recvMs: now - 20_000 }], [2, { recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(otherFresh, 1, now, maxAge), true, 'symbol 2 is fresh and is not the excluded one')
  const otherStale = new Map([[2, { recvMs: now - 20_000 }]])
  assert.equal(sideHasFreshQuoteExcluding(otherStale, 1, now, maxAge), false, 'the other symbol exists but is itself stale')
  assert.equal(sideHasFreshQuoteExcluding(new Map(), 1, now, maxAge), false)
  assert.equal(sideHasFreshQuoteExcluding(null, 1, now, maxAge), false)
  const withAgeMs = new Map([[2, { ageMs: 500 }]])
  assert.equal(sideHasFreshQuoteExcluding(withAgeMs, 1, now, maxAge), true, 'ageMs is used directly when present')
})

// ---------------------------------------------------------------------------
// ProbeScheduler — cap + backoff wired together, on the CALLER's clock
// ---------------------------------------------------------------------------

test('ProbeScheduler.plan: eligible the first time; pending while its own run() is still in flight', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_000 }), 'eligible')
  let resolve
  const p = s.run('k1', () => new Promise((r) => { resolve = r }), 1_000)
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_001 }), 'pending', 'the same key is already in flight')
  resolve({ bid: 1, ask: 1.1 })
  await p
  assert.equal(s.inflightCount(), 0)
  assert.deepEqual(s.lastResult('k1'), { quote: { bid: 1, ask: 1.1 }, at: 1_000, error: null })
})

test('ProbeScheduler: backoff arms on the CALLER clock, not a real wall clock — the whole point of M7 (fast-monitor.js\'s injectable `now()`)', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await s.run('k1', async () => ({ bid: 1, ask: 1.1 }), 1_000)
  // a simulated clock 30s later, side fresh: still inside the 60s backoff window
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 31_000 }), 'backoff')
  // the same key, side NOT fresh: must keep retrying regardless of elapsed time
  assert.equal(s.plan('k1', { sideHasFreshQuote: false, nowMs: 31_000 }), 'eligible')
  // past the window: eligible again
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 61_001 }), 'eligible')
})

test('ProbeScheduler: a failed probe still counts for cap/backoff bookkeeping, and never rejects', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  const q = await s.run('k1', async () => { throw new Error('boom') }, 1_000)
  assert.equal(q, null)
  assert.equal(s.inflightCount(), 0)
  const r = s.lastResult('k1')
  assert.equal(r.quote, null)
  assert.ok(r.error instanceof Error)
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_500 }), 'backoff', 'a failure still arms backoff — it is a completed probe')
})

test('ProbeScheduler.reset: drops all state (test seam / process restart)', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await s.run('k1', async () => ({ bid: 1, ask: 1.1 }), 1_000)
  s.reset()
  assert.equal(s.lastResult('k1'), null)
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_001 }), 'eligible')
})

// ---------------------------------------------------------------------------
// End-to-end shape: several symbols needing a probe in one pass, bounded by
// the cap, launched together (not one at a time) — this is what
// fast-monitor.js's parallel batch relies on.
// ---------------------------------------------------------------------------

test('a batch of candidates under a cap of 2: exactly 2 launch concurrently, the third waits its turn', async () => {
  const s = new ProbeScheduler({ cap: 2, backoffMs: 60_000 })
  const candidates = ['a', 'b', 'c']
  const plans = candidates.map((k) => s.plan(k, { sideHasFreshQuote: false, nowMs: 1_000 }))
  assert.deepEqual(plans, ['eligible', 'eligible', 'eligible'])
  const { launch, deferred } = selectUnderCap(candidates, s.inflightCount(), s.cap)
  assert.deepEqual(launch, ['a', 'b'])
  assert.deepEqual(deferred, ['c'])
  let maxInFlight = 0
  const track = async (key) => {
    s.inflight.size // (touch, no-op — inflight bookkeeping happens inside run())
    await new Promise((r) => setTimeout(r, 5))
    return { bid: key.length, ask: key.length }
  }
  const inflightSamples = []
  const runs = launch.map((k) => s.run(k, async () => { inflightSamples.push(s.inflightCount()); return track(k) }, 1_000))
  await Promise.all(runs)
  maxInFlight = Math.max(...inflightSamples)
  assert.equal(maxInFlight, 2, 'both launched probes were in flight together')
  assert.equal(s.lastResult('c'), null, 'the deferred one never ran')
})
