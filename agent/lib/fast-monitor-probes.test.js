// node --test agent/lib/fast-monitor-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Pins the mechanisms fast-monitor.js's
// broker-fallback relies on: the CAP (how many probes may be in flight at
// once), the BACKOFF (how often the same quiet symbol may be re-probed) and
// PEEK (whether a result is still fresh enough to evaluate with, checked at
// the CALLER's chosen moment, never cached from an earlier check).
//
// Fix round 3 (26-09-2026): `run()` (awaited by the caller) is replaced by
// `launch()` (fire-and-forget — this IS the "results used on the next pass"
// the spec asks for, V3-SEQUENCE:537) plus `_drainForTests()`, a test-only
// seam that waits for whatever is currently in flight instead of racing real
// timers. `lastResult()` is replaced by `peek(key, nowMs, maxAgeMs)`, which
// judges freshness against a caller-supplied clock reading, not "however
// long ago it happened to finish".

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROBE_CAP_DEFAULT, PROBE_CAP_MAX, PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_DEFAULT_MS, PROBE_KEY_CAP,
  probeCap, probeBackoffMs, clampCap, shouldBackoff, selectUnderCap,
  sideHasFreshQuoteExcluding, ProbeScheduler,
} from './fast-monitor-probes.js'

/**
 * Launch `key` and wait for it to settle — the test-seam equivalent of the
 * old awaited `run()`. Pins BOTH clocks to fixed values (not launch()'s own
 * real-Date.now() default for the monotonic one) so a caller that does not
 * care about durationMs gets a deterministic 0 every time — a real clock
 * here occasionally measures 1ms+ of genuine wall-clock time between two
 * back-to-back synchronous statements under load, which is exactly the kind
 * of flake `peek: durationMs is the probe's OWN round trip` (below) tests
 * FOR on purpose and everything else here must not trip over by accident.
 */
async function launchAndDrain(s, key, fn, nowMs, monoMs = nowMs) {
  s.launch(key, fn, () => nowMs, () => monoMs)
  await s._drainForTests()
}

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

// B3 (fix round 2, 26-09-2026): the cap can be 0 or unbounded unless floored
// first, THEN required >= 1, THEN clamped to a ceiling.
test('clampCap (B3): floors first, then requires >= 1, then clamps to PROBE_CAP_MAX', () => {
  assert.equal(clampCap(0.5), PROBE_CAP_DEFAULT, '0.5 floors to 0, which is invalid, not a valid 1')
  assert.equal(clampCap(0), PROBE_CAP_DEFAULT)
  assert.equal(clampCap(-1), PROBE_CAP_DEFAULT)
  assert.equal(clampCap(1e9), PROBE_CAP_MAX, 'an unbounded request is clamped, never passed through')
  assert.equal(clampCap(PROBE_CAP_MAX), PROBE_CAP_MAX, 'exactly the ceiling is allowed')
  assert.equal(clampCap(PROBE_CAP_MAX + 1), PROBE_CAP_MAX)
  assert.equal(clampCap(1), 1, 'exactly the floor is allowed')
  assert.equal(clampCap(4.9), 4, 'floored, not rounded')
  assert.equal(clampCap(NaN), PROBE_CAP_DEFAULT)
  assert.equal(clampCap(undefined), PROBE_CAP_DEFAULT)
  assert.equal(clampCap('garbage'), PROBE_CAP_DEFAULT)
})

test('probeCap (B3): the same clampCap validation applies through the env path', () => {
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '0.5' }), PROBE_CAP_DEFAULT)
  assert.equal(probeCap({ FAST_MONITOR_PROBE_CAP: '1e9' }), PROBE_CAP_MAX)
})

// N1 (nit, fix round 2): the CONSTRUCTOR itself validates the cap — a direct
// reconfigure (fast-monitor.js's _setFastMonitorProbeCapForTests, or any
// future caller) cannot hand it a 0/unbounded cap either.
test('ProbeScheduler constructor (N1): validates its own cap through clampCap, not a bare assignment', () => {
  assert.equal(new ProbeScheduler({ cap: 0 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeScheduler({ cap: -5 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeScheduler({ cap: 1e9 }).cap, PROBE_CAP_MAX)
  assert.equal(new ProbeScheduler({ cap: 0.5 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeScheduler({}).cap, PROBE_CAP_DEFAULT, 'the default itself must also pass validation')
  assert.equal(new ProbeScheduler({ cap: 3 }).cap, 3)
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
// shouldBackoff — the TIMING half of the OD-22 condition (the scheduler's
// `plan()` additionally requires a SUCCESSFUL no-quote result and no spike —
// see the ProbeScheduler section below, B1/B2).
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
// symbol itself, stale or otherwise (V3-SEQUENCE:539); fix round 3 nit: a
// row with a bad/invalid price does not count as fresh either.
// ---------------------------------------------------------------------------

test('sideHasFreshQuoteExcluding: a fresh OTHER symbol counts; the excluded symbol never does, fresh or not', () => {
  const now = 1_000_000
  const maxAge = 10_000
  const onlySelfFresh = new Map([[1, { bid: 1.1, ask: 1.1002, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(onlySelfFresh, 1, now, maxAge), false, 'the only entry is the excluded symbol itself')
  const otherFresh = new Map([[1, { bid: 1.1, ask: 1.1002, recvMs: now - 20_000 }], [2, { bid: 1.27, ask: 1.2702, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(otherFresh, 1, now, maxAge), true, 'symbol 2 is fresh and is not the excluded one')
  const otherStale = new Map([[2, { bid: 1.27, ask: 1.2702, recvMs: now - 20_000 }]])
  assert.equal(sideHasFreshQuoteExcluding(otherStale, 1, now, maxAge), false, 'the other symbol exists but is itself stale')
  assert.equal(sideHasFreshQuoteExcluding(new Map(), 1, now, maxAge), false)
  assert.equal(sideHasFreshQuoteExcluding(null, 1, now, maxAge), false)
  const withAgeMs = new Map([[2, { bid: 1.27, ask: 1.2702, ageMs: 500 }]])
  assert.equal(sideHasFreshQuoteExcluding(withAgeMs, 1, now, maxAge), true, 'ageMs is used directly when present')
})

test('sideHasFreshQuoteExcluding (nit, fix round 3): a fresh-timestamped but INVALID price never counts', () => {
  const now = 1_000_000
  const maxAge = 10_000
  const missingAsk = new Map([[2, { bid: 1.27, ask: null, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(missingAsk, 1, now, maxAge), false, 'no ask at all')
  const zeroBid = new Map([[2, { bid: 0, ask: 1.27, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(zeroBid, 1, now, maxAge), false, 'a non-positive bid is not a price')
  const crossed = new Map([[2, { bid: 1.28, ask: 1.27, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(crossed, 1, now, maxAge), false, 'ask below bid is not a valid book')
  const nonFinite = new Map([[2, { bid: NaN, ask: 1.27, recvMs: now - 100 }]])
  assert.equal(sideHasFreshQuoteExcluding(nonFinite, 1, now, maxAge), false)
})

// ---------------------------------------------------------------------------
// ProbeScheduler — cap + backoff + peek, wired together, on the CALLER's clock
// ---------------------------------------------------------------------------

test('ProbeScheduler.plan: eligible the first time; pending while its own launch() is still in flight', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_000 }), 'eligible')
  let resolve
  s.launch('k1', () => new Promise((r) => { resolve = r }), () => 1_000, () => 1_000)
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_001 }), 'pending', 'the same key is already in flight — realistic now that probes are never awaited within a pass')
  resolve({ bid: 1, ask: 1.1 })
  await s._drainForTests()
  assert.equal(s.inflightCount(), 0)
  assert.deepEqual(s.peek('k1', 1_000, 10_000), { state: 'quote', quote: { bid: 1, ask: 1.1 }, durationMs: 0 })
})

test('ProbeScheduler: backoff arms on the CALLER clock, not a real wall clock — the whole point of M7 (fast-monitor.js\'s injectable `now()`); ONLY after a probe that SUCCEEDED with no quote (B1)', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => null, 1_000) // a quiet symbol: the broker had nothing, cleanly
  // a simulated clock 30s later, side fresh, no spike: still inside the 60s backoff window
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 31_000 }), 'backoff')
  // the same key, side NOT fresh: must keep retrying regardless of elapsed time
  assert.equal(s.plan('k1', { sideHasFreshQuote: false, nowMs: 31_000 }), 'eligible')
  // past the window: eligible again
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 61_001 }), 'eligible')
})

test('ProbeScheduler: B2 — backoff never arms while the position is inside its spike window, regardless of the last result', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => null, 1_000) // quiet, would otherwise arm backoff
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, spikeActive: true, nowMs: 1_500 }), 'eligible', 'a spike overrides backoff outright — re-pricing matters most exactly here')
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, spikeActive: false, nowMs: 1_500 }), 'backoff', 'without the spike, the same inputs DO back off — pinning the spike check actually matters')
})

test('ProbeScheduler: B1/B2 — a THROWN probe never arms backoff (a technical failure is not "genuinely quiet")', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => { throw new Error('ECONNRESET') }, 1_000)
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_500 }), 'eligible', 'a throw/timeout/socket error keeps retrying — never mistaken for a quiet symbol')
})

test('ProbeScheduler: B1 — a key whose LAST probe actually priced it is never backed off, no matter how fresh the side or how soon the next check', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => ({ bid: 1, ask: 1.1 }), 1_000) // a real quote, not quiet
  // 1ms later, side fresh, well inside any backoff window: still eligible —
  // backoff is not a "just probed" cooldown, it only protects a QUIET symbol.
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_001 }), 'eligible')
})

test('ProbeScheduler.reset: drops all state (test seam / process restart)', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => ({ bid: 1, ask: 1.1 }), 1_000)
  s.reset()
  assert.deepEqual(s.peek('k1', 1_000, 10_000), { state: 'none' })
  assert.equal(s.plan('k1', { sideHasFreshQuote: true, nowMs: 1_001 }), 'eligible')
})

// Nit (fix round 3, 26-09-2026): the scheduler's own per-symbol history
// (lastProbeAt, results) is a BoundedMap, not a bare Map — a process that
// stays up for weeks and eventually probes more than PROBE_KEY_CAP distinct
// symbols must not grow these without limit (#123's exact shape). Eviction
// is oldest-first: an evicted key is simply never-probed again, same as a
// fresh process — never a crash, never an unbounded Map.
test('ProbeScheduler: lastProbeAt/results are bounded by PROBE_KEY_CAP — a process that outlives its cap evicts the oldest key, it does not grow forever', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  for (let i = 0; i < PROBE_KEY_CAP + 5; i++) {
    await launchAndDrain(s, `k${i}`, async () => ({ bid: 1, ask: 1.1 }), 1_000)
  }
  assert.equal(s.lastProbeAt.size, PROBE_KEY_CAP, `lastProbeAt must never exceed PROBE_KEY_CAP, got ${s.lastProbeAt.size}`)
  assert.equal(s.results.size, PROBE_KEY_CAP, `results must never exceed PROBE_KEY_CAP, got ${s.results.size}`)
  // the first 5 keys (oldest) were evicted; peek reads them as never-probed,
  // not an error — exactly like a fresh process.
  assert.deepEqual(s.peek('k0', 1_000, 10_000), { state: 'none' })
  assert.deepEqual(s.peek(`k${PROBE_KEY_CAP + 4}`, 1_000, 10_000), { state: 'quote', quote: { bid: 1, ask: 1.1 }, durationMs: 0 }, 'the most recent key is still there')
})

// ---------------------------------------------------------------------------
// peek — freshness is judged at the CALLER's chosen moment, not "since it
// finished". This is what closes B1 at the fast-monitor.js level: two
// `peek()` calls for the SAME result, at different `nowMs`, can legitimately
// disagree about whether it is still usable.
// ---------------------------------------------------------------------------

test('peek: "none" before any probe, "quote" while fresh, "stale" once maxAgeMs has elapsed — SAME result, judged at different moments', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  assert.deepEqual(s.peek('k1', 1_000, 10_000), { state: 'none' })
  await launchAndDrain(s, 'k1', async () => ({ bid: 1.1, ask: 1.1002 }), 1_000)
  assert.deepEqual(s.peek('k1', 1_005, 10_000), { state: 'quote', quote: { bid: 1.1, ask: 1.1002 }, durationMs: 0 })
  // The EXACT same stored result, now judged 11s later: stale.
  assert.deepEqual(s.peek('k1', 12_001, 10_000), { state: 'stale', error: null })
})

test('peek: "no_quote" for a fresh, clean null result (a genuine quote_unavailable case) — distinct from "stale"', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => null, 1_000)
  assert.deepEqual(s.peek('k1', 1_500, 10_000), { state: 'no_quote', error: null, durationMs: 0 })
  assert.equal(s.peek('k1', 12_000, 10_000).state, 'stale', 'the same clean null, now too old to trust without asking again')
})

test('peek: a THROWN probe reads as "no_quote" (fresh) / "stale" (old) with its error attached — callers decide what that means, peek does not judge', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'k1', async () => { throw new Error('boom') }, 1_000)
  const fresh = s.peek('k1', 1_100, 10_000)
  assert.equal(fresh.state, 'no_quote')
  assert.ok(fresh.error instanceof Error)
})

test('peek: durationMs is the probe\'s OWN round trip — never blended with anything that happens after it lands (B5)', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  s.launch('k1', async () => { await sleep(40); return { bid: 1, ask: 1.1 } }, () => 1_000)
  await s._drainForTests()
  const peeked = s.peek('k1', 1_000, 10_000)
  assert.equal(peeked.state, 'quote')
  assert.ok(peeked.durationMs >= 30, `expected the probe's own ~40ms round trip, got ${peeked.durationMs}`)
  assert.ok(peeked.durationMs < 5_000, `must not include anything else — got ${peeked.durationMs}`)
})

// ---------------------------------------------------------------------------
// End-to-end shape: several symbols needing a probe in one pass, bounded by
// the cap, launched together (not one at a time) — this is what
// fast-monitor.js's launch batch relies on. None of this is awaited by a
// pass in production; the test drains explicitly instead.
// ---------------------------------------------------------------------------

test('a batch of candidates under a cap of 2: exactly 2 launch concurrently, the third waits its turn', async () => {
  const s = new ProbeScheduler({ cap: 2, backoffMs: 60_000 })
  const candidates = ['a', 'b', 'c']
  const plans = candidates.map((k) => s.plan(k, { sideHasFreshQuote: false, nowMs: 1_000 }))
  assert.deepEqual(plans, ['eligible', 'eligible', 'eligible'])
  const { launch, deferred } = selectUnderCap(candidates, s.inflightCount(), s.cap)
  assert.deepEqual(launch, ['a', 'b'])
  assert.deepEqual(deferred, ['c'])
  const inflightSamples = []
  for (const k of launch) {
    s.launch(k, async () => { inflightSamples.push(s.inflightCount()); await new Promise((r) => setTimeout(r, 5)); return { bid: k.length, ask: k.length } }, () => 1_000)
  }
  await s._drainForTests()
  assert.equal(Math.max(...inflightSamples), 2, 'both launched probes were in flight together')
  assert.deepEqual(s.peek('c', 1_000, 10_000), { state: 'none' }, 'the deferred one never ran')
})

test('launch: a key already in flight is never relaunched, even if the caller calls launch() again without checking plan() first', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  let calls = 0
  let resolve
  s.launch('k1', () => { calls++; return new Promise((r) => { resolve = r }) }, () => 1_000)
  s.launch('k1', () => { calls++; return Promise.resolve({ bid: 9, ask: 9 }) }, () => 1_000)
  assert.equal(calls, 1, 'the second launch() was a no-op — the key was already in flight')
  resolve({ bid: 1, ask: 1.1 })
  await s._drainForTests()
  assert.deepEqual(s.peek('k1', 1_000, 10_000).quote, { bid: 1, ask: 1.1 })
})

// ---------------------------------------------------------------------------
// sortFair (B2, fix round 2 26-09-2026): never-probed keys first, then
// oldest-probed-first — so a persistently over-cap batch does not relaunch
// the same head-of-list keys every pass while the rest starve.
// ---------------------------------------------------------------------------

test('sortFair: never-probed keys come first, in their given order', () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  assert.deepEqual(s.sortFair(['c', 'a', 'b']), ['c', 'a', 'b'])
})

test('sortFair: probed keys sort oldest lastProbeAt first, after every never-probed key', async () => {
  const s = new ProbeScheduler({ cap: 8, backoffMs: 60_000 })
  await launchAndDrain(s, 'b', async () => ({ bid: 1, ask: 1 }), 3_000)
  await launchAndDrain(s, 'a', async () => ({ bid: 1, ask: 1 }), 1_000)
  await launchAndDrain(s, 'c', async () => ({ bid: 1, ask: 1 }), 2_000)
  assert.deepEqual(s.sortFair(['b', 'a', 'c']), ['a', 'c', 'b'], 'oldest probe (a, t=1000) first')
  assert.deepEqual(s.sortFair(['b', 'a', 'c', 'd']), ['d', 'a', 'c', 'b'], 'd was never probed — ahead of all three')
})

test('sortFair: starvation under a persistent over-cap batch resolves within ceil(N/cap) passes', async () => {
  const s = new ProbeScheduler({ cap: 2, backoffMs: 60_000 })
  const all = ['a', 'b', 'c', 'd', 'e']
  const everProbed = new Set()
  let t = 1_000
  for (let pass = 0; pass < 3; pass++) {
    const ordered = s.sortFair(all)
    const { launch } = selectUnderCap(ordered, 0, s.cap)
    for (const k of launch) { await launchAndDrain(s, k, async () => null, t); everProbed.add(k) }
    t += 1
  }
  // ceil(5/2) = 3 passes must cover every key at least once.
  assert.deepEqual([...everProbed].sort(), all, `every key must be probed within 3 passes, got ${[...everProbed].sort()}`)
})
