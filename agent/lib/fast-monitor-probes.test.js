// node --test agent/lib/fast-monitor-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Unit pins for the board fast-monitor.js
// keeps its broker probes on (round 4 — the design and its invariants I1–I6
// are the header of ./fast-monitor-probes.js): the CAP and its FIFO queue,
// JOINING an open probe, never joining a LANDED one (I2), the BACKOFF only
// after a clean empty answer (I3), the answer's normal form, and the clock
// every stamp is taken on. The wiring is pinned in
// ../services/fast-monitor-m7-probes.test.js and the behaviour against
// origin/main in ../services/fast-monitor-m7-differential.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROBE_CAP_DEFAULT, PROBE_CAP_MAX, PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_DEFAULT_MS, PROBE_KEY_CAP, PROBE_GUARD_MS,
  PROBE_WAIT_DEFAULT_MS, PROBE_WAIT_MARGIN_MS, PROBE_RESULT_MAX_AGE_MS, PROBE_RESULT_MIN_AGE_MS,
  probeCap, probeBackoffMs, clampCap, shouldBackoff, sideHasFreshQuoteExcluding, probeResultOf, raceTimeout, isTimedOut,
  probeWaitForTick, probeMaxAgeForTick, ProbeBoard,
} from './fast-monitor-probes.js'

/** A manual clock: `now`/`mono` read `t`; `sleep` parks until `advance` passes it. */
function manualClock(t0 = 1_000_000) {
  let t = t0
  const timers = []
  return {
    now: () => t,
    mono: () => t,
    sleep: (ms) => new Promise(r => timers.push({ at: t + ms, r })),
    advance(ms) {
      t += ms
      for (const x of timers.splice(0)) { if (x.at <= t) x.r(); else timers.push(x) }
    },
  }
}
/** A broker call the test answers by hand. */
function handCall() {
  const calls = []
  const run = (label) => () => new Promise((resolve, reject) => calls.push({ label, resolve, reject }))
  return { calls, run }
}
const tick = () => new Promise(r => setImmediate(r))

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
// ProbeBoard — the board fast-monitor.js keeps (I1, I2, I3)
// ---------------------------------------------------------------------------

test('ProbeBoard constructor (N1): validates its own cap through clampCap, and the backoff against OD-22\'s ceiling', () => {
  assert.equal(new ProbeBoard({ cap: 0 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeBoard({ cap: -5 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeBoard({ cap: 1e9 }).cap, PROBE_CAP_MAX)
  assert.equal(new ProbeBoard({ cap: 0.5 }).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeBoard({}).cap, PROBE_CAP_DEFAULT)
  assert.equal(new ProbeBoard({ cap: 3 }).cap, 3)
  assert.equal(new ProbeBoard({ backoffMs: PROBE_BACKOFF_MAX_MS * 4 }).backoffMs, PROBE_BACKOFF_MAX_MS)
})

test('register: the first waiter on a key starts ONE probe; a second waiter on the same key JOINS it; waiters queue in registration order', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ cap: 8 })
  const { calls, run } = handCall()
  const w1 = b.register({ posId: 1, key: 'k', run: run('k'), pick: 'missing' }, clock)
  const w2 = b.register({ posId: 2, key: 'k', run: run('k-again'), pick: 'stale' }, clock)
  assert.equal(calls.length, 1, 'one broker call for two positions on one feed key')
  assert.equal(w1.probe, w2.probe)
  assert.equal(b.inflightCount(), 1)
  assert.deepEqual(b.waiters.map(w => w.posId), [1, 2])
  assert.equal(b.head(), w1)
  assert.equal(b.hasLanded(w1), false, 'no verdict yet (I4)')
  calls[0].resolve({ kind: 'quote', bid: 1, ask: 1.1 })
  await w1.probe.settled
  assert.equal(b.hasLanded(w1), true)
  assert.equal(b.hasLanded(w2), true)
  assert.deepEqual(w1.probe.result, { kind: 'quote', bid: 1, ask: 1.1 })
  assert.equal(b.inflightCount(), 0)
})

test('I2: a waiter never joins a probe that has LANDED — a due position after the answer asks the broker again', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ cap: 8 })
  const { calls, run } = handCall()
  const w1 = b.register({ posId: 1, key: 'k', run: run('first') }, clock)
  calls[0].resolve({ kind: 'quote', bid: 1, ask: 1.1 })
  await w1.probe.settled
  const w2 = b.register({ posId: 2, key: 'k', run: run('second') }, clock)
  assert.equal(calls.length, 2, 'a second, real broker call')
  assert.notEqual(w2.probe, w1.probe)
  assert.equal(b.hasLanded(w2), false)
})

test('cap: beyond the cap a probe QUEUES, and starts the moment a slot frees, FIFO', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ cap: 2 })
  const { calls, run } = handCall()
  const wa = b.register({ posId: 1, key: 'a', run: run('a') }, clock)
  b.register({ posId: 2, key: 'b', run: run('b') }, clock)
  const wc = b.register({ posId: 3, key: 'c', run: run('c') }, clock)
  const wd = b.register({ posId: 4, key: 'd', run: run('d') }, clock)
  assert.deepEqual(calls.map(c => c.label), ['a', 'b'], 'exactly the cap started')
  assert.equal(b.queuedCount(), 2)
  assert.equal(wc.probe.state, 'queued')
  // a queued probe can still be JOINED: no second call when it starts
  const wc2 = b.register({ posId: 5, key: 'c', run: run('c-dup') }, clock)
  assert.equal(wc2.probe, wc.probe)
  clock.advance(700)
  calls[0].resolve({ kind: 'quote', bid: 1, ask: 1.1 })
  await wa.probe.settled
  assert.deepEqual(calls.map(c => c.label), ['a', 'b', 'c'], 'c starts in a\'s settle — not on a later pass')
  assert.equal(wc.probe.launchedAt, clock.now(), 'stamped when it STARTED, on the caller\'s clock')
  assert.equal(wd.probe.state, 'queued')
  calls[1].reject(new Error('socket closed'))
  await tick(); await tick(); await tick()
  assert.deepEqual(calls.map(c => c.label), ['a', 'b', 'c', 'd'])
})

test('durationMs is the probe\'s own round trip on the caller\'s monotonic clock; settledAt on its wall clock', async () => {
  const clock = manualClock(5_000)
  const b = new ProbeBoard({})
  const { calls, run } = handCall()
  const w = b.register({ posId: 1, key: 'k', run: run('k') }, clock)
  clock.advance(1_234)
  calls[0].resolve({ kind: 'empty', reason: 'quiet' })
  await w.probe.settled
  assert.equal(w.probe.durationMs, 1_234)
  assert.equal(w.probe.settledAt, 6_234)
  assert.equal(w.probe.launchedAt, 5_000)
})

test('I3: backoff arms ONLY after a clean empty answer, only while the side is fresh, never in a spike window, and only for backoffMs from the launch', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ backoffMs: 60_000 })
  const answer = async (key, a) => {
    const w = b.register({ posId: 1, key, run: () => Promise.resolve(a) }, clock)
    await w.probe.settled
    b.shift()
  }
  const at = (key, extra = {}) => b.backoffActive(key, { nowMs: clock.now(), sideHasFreshQuote: true, spikeActive: false, ...extra })
  assert.equal(at('never'), false, 'never probed')
  await answer('empty', { kind: 'empty', reason: 'subscribed, silent' })
  assert.equal(at('empty'), true)
  assert.equal(at('empty', { sideHasFreshQuote: false }), false, 'a quiet SIDE keeps retrying')
  assert.equal(at('empty', { spikeActive: true }), false, 'a spike window never backs off')
  for (const failure of [{ kind: 'failed', reason: 'auth' }, null]) {
    await answer(`failed-${failure ? 'tagged' : 'null'}`, failure)
    assert.equal(at(`failed-${failure ? 'tagged' : 'null'}`), false, `${JSON.stringify(failure)} is a failure, not a quiet symbol`)
  }
  const thrown = b.register({ posId: 1, key: 'thrown', run: () => { throw new Error('boom') } }, clock)
  await thrown.probe.settled
  assert.equal(thrown.probe.result.kind, 'failed')
  assert.equal(at('thrown'), false)
  await answer('priced', { kind: 'quote', bid: 1, ask: 1.1 })
  assert.equal(at('priced'), false)
  clock.advance(59_999)
  assert.equal(at('empty'), true, 'still inside the window')
  clock.advance(1)
  assert.equal(at('empty'), false, 'backoffMs after the LAUNCH, and no longer')
})

test('the guard: a probe that never answers is settled as failed after PROBE_GUARD_MS — a pass waiting on it is never wedged', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({})
  const w = b.register({ posId: 1, key: 'k', run: () => new Promise(() => {}) }, clock)
  await tick()
  assert.equal(b.hasLanded(w), false)
  clock.advance(PROBE_GUARD_MS)
  await w.probe.settled
  assert.equal(w.probe.result.kind, 'failed')
  assert.match(w.probe.result.reason, /still open/)
  assert.equal(b.inflightCount(), 0)
})

test('reset: a probe in flight at a reset settles into nothing — the in-flight count never goes negative, nothing starts in the new generation', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ cap: 1 })
  const { calls, run } = handCall()
  const old = b.register({ posId: 1, key: 'a', run: run('a') }, clock)
  b.register({ posId: 2, key: 'b', run: run('b') }, clock)
  b.reset()
  assert.equal(b.inflightCount(), 0)
  assert.equal(b.queuedCount(), 0)
  assert.equal(b.head(), null)
  calls[0].resolve({ kind: 'quote', bid: 1, ask: 1.1 })
  await old.probe.settled
  assert.equal(b.inflightCount(), 0, 'the old generation does not decrement the new one')
  assert.deepEqual(calls.map(c => c.label), ['a'], 'the pre-reset queue never starts')
})

test('retain drops waiters, not probes: the answer still lands, it just serves no one', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({})
  const { calls, run } = handCall()
  const w = b.register({ posId: 1, key: 'k', run: run('k') }, clock)
  b.retain(() => false)
  assert.equal(b.head(), null)
  calls[0].resolve({ kind: 'quote', bid: 1, ask: 1.1 })
  await w.probe.settled
  assert.equal(b.inflightCount(), 0)
})

test('the probe history is bounded by PROBE_KEY_CAP — an evicted key reads as never probed', async () => {
  const clock = manualClock()
  const b = new ProbeBoard({ cap: PROBE_CAP_MAX })
  for (let i = 0; i <= PROBE_KEY_CAP; i++) {
    const w = b.register({ posId: i, key: `k${i}`, run: () => Promise.resolve({ kind: 'empty' }) }, clock)
    await w.probe.settled
    b.shift()
  }
  assert.ok(b.history.size <= PROBE_KEY_CAP)
  assert.equal(b.backoffActive('k0', { nowMs: clock.now(), sideHasFreshQuote: true }), false, 'the oldest key was evicted')
  assert.equal(b.backoffActive(`k${PROBE_KEY_CAP}`, { nowMs: clock.now(), sideHasFreshQuote: true }), true)
})

// ---------------------------------------------------------------------------
// The answer's normal form, the race, the end-of-pass wait
// ---------------------------------------------------------------------------

test('probeResultOf (I3): tagged answers pass through; a bare quote is a quote; null and anything unknown are FAILURES, never a clean empty', () => {
  assert.deepEqual(probeResultOf({ kind: 'quote', bid: 1, ask: 2 }), { kind: 'quote', bid: 1, ask: 2 })
  assert.deepEqual(probeResultOf({ kind: 'empty', reason: 'r' }), { kind: 'empty', reason: 'r' })
  assert.deepEqual(probeResultOf({ kind: 'failed', reason: 'auth' }), { kind: 'failed', reason: 'auth' })
  assert.deepEqual(probeResultOf({ bid: 1, ask: 2 }), { kind: 'quote', bid: 1, ask: 2 }, 'the legacy wsGetSpotOnce quote')
  assert.equal(probeResultOf(null).kind, 'failed', 'the legacy null cannot tell failure from silence — never arms the backoff')
  assert.equal(probeResultOf(undefined).kind, 'failed')
  assert.equal(probeResultOf({ kind: 'weird' }).kind, 'failed')
})

test('raceTimeout: the value when it is faster, TIMED_OUT when it is not, on an injected clock or a cleared real timer', async () => {
  const clock = manualClock()
  let resolve
  const p = new Promise(r => { resolve = r })
  const raced = raceTimeout(p, 500, clock.sleep)
  clock.advance(500)
  assert.equal(isTimedOut(await raced), true)
  resolve('late')
  assert.equal(await raceTimeout(Promise.resolve('now'), 500, clock.sleep), 'now')
  assert.equal(await raceTimeout(Promise.resolve('real'), 50), 'real', 'the default timer is cleared, never left to hold the process')
  assert.equal(isTimedOut(await raceTimeout(new Promise(() => {}), 5)), true)
  assert.equal(await raceTimeout(Promise.resolve('forever'), Infinity), 'forever', 'no deadline: just the promise')
})

test('probeWaitForTick: the tick less PROBE_WAIT_MARGIN_MS, at most PROBE_WAIT_DEFAULT_MS, never negative', () => {
  assert.equal(PROBE_WAIT_DEFAULT_MS, 2_000)
  assert.equal(PROBE_WAIT_MARGIN_MS, 1_000)
  assert.equal(probeWaitForTick(3_000), 2_000, 'the production tick')
  assert.equal(probeWaitForTick(10_000), 2_000)
  assert.equal(probeWaitForTick(2_500), 1_500)
  assert.equal(probeWaitForTick(1_000), 0, 'FAST_MONITOR_MS\'s 1 s floor waits for nothing')
  assert.equal(probeWaitForTick(5), 0)
  assert.equal(probeWaitForTick(NaN), 0)
})

test('probeMaxAgeForTick: a landed quote may wait one tick for its turn — the probe\'s own bound (nit 4), never the sidecar\'s env knob', () => {
  assert.equal(PROBE_RESULT_MAX_AGE_MS, 3_000, 'one production tick')
  assert.equal(probeMaxAgeForTick(3_000), 3_000)
  assert.equal(probeMaxAgeForTick(10_000), 10_000, 'a slower ticker consumes a pass later, so its answers may be that much older')
  assert.equal(probeMaxAgeForTick(5), PROBE_RESULT_MIN_AGE_MS, 'a test ticker never re-asks an answer that waited one of its passes')
  assert.equal(probeMaxAgeForTick(undefined), PROBE_RESULT_MAX_AGE_MS)
  assert.equal(PROBE_GUARD_MS > 6_000, true, 'above wsProbeSpot\'s own 6 s deadline')
})
