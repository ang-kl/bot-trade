// node --test agent/services/fast-monitor.test.js
//
// Fast monitor cadence policy: base interval from monitor_interval_min,
// scaled by the instrument's relative 1-minute volume — busy markets get
// the fastest checks, quiet ones the slowest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cadenceMs, relVolFromBars, effectiveCadenceMs, isSpikeMove, SPIKE_PCT_PER_MIN, frozenQuoteUpdate, FROZEN_QUOTE_DEFAULT_MIN, makeCadenceGate } from './fast-monitor.js'

const MIN = 60_000

test('cadence: busy market checks at base speed, average 2×, quiet 3×', () => {
  assert.equal(cadenceMs(2.0, 1), 1 * MIN)
  assert.equal(cadenceMs(1.5, 1), 1 * MIN)
  assert.equal(cadenceMs(1.0, 1), 2 * MIN)
  assert.equal(cadenceMs(0.75, 1), 2 * MIN)
  assert.equal(cadenceMs(0.2, 1), 3 * MIN)
})

test('cadence: base minutes scale linearly; unknown volume = middle pace', () => {
  assert.equal(cadenceMs(2.0, 3), 3 * MIN)
  assert.equal(cadenceMs(0.2, 2), 6 * MIN)
  assert.equal(cadenceMs(NaN, 1), 2 * MIN)
})

test('cadence: garbage base falls back to 1 minute, floor 30s', () => {
  assert.equal(cadenceMs(2.0, undefined), 1 * MIN)
  assert.equal(cadenceMs(2.0, 0), 1 * MIN)      // 0 is garbage → default 1m
  assert.equal(cadenceMs(2.0, 0.25), 30_000)    // sub-30s floors at 30s
})

test('relVolFromBars: last CLOSED bar vs prior average; forming bar dropped', () => {
  const mk = (vols) => vols.map((v, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1, v }))
  // 6 closed bars of 100 + last closed 300 + forming 5 (ignored) → relVol 3
  const bars = mk([100, 100, 100, 100, 100, 100, 300, 5])
  assert.ok(Math.abs(relVolFromBars(bars) - 3) < 1e-9)
  assert.ok(Number.isNaN(relVolFromBars(mk([100, 100]))), 'too few bars → NaN')
  assert.ok(Number.isNaN(relVolFromBars(mk([0, 0, 0, 0, 0, 0, 0, 0]))), 'zero volume → NaN')
})

test('owner override beats the volume-adaptive cadence, both directions', () => {
  // hot market would say 1m — override throttles to 10m
  assert.equal(effectiveCadenceMs(10, 2.0, 1), 10 * MIN)
  // quiet market would say 3m — override pins to 30s
  assert.equal(effectiveCadenceMs(0.5, 0.2, 1), 30_000)
  // floor: overrides can never go below 15s
  assert.equal(effectiveCadenceMs(0.1, 2.0, 1), 15_000)
  // no/garbage override → volume-adaptive
  assert.equal(effectiveCadenceMs(null, 0.2, 1), 3 * MIN)
  assert.equal(effectiveCadenceMs('nope', 2.0, 1), 1 * MIN)
})

test('isSpikeMove: fast enough move since the last check counts as a spike', () => {
  const t0 = 1_000_000
  // 0.5% in 30s = 1%/min — above the 0.4%/min default threshold.
  assert.equal(isSpikeMove(100, t0, 100.5, t0 + 30_000), true)
  // Same 0.5% move stretched over 5 minutes = 0.1%/min — not a spike.
  assert.equal(isSpikeMove(100, t0, 100.5, t0 + 5 * MIN), false)
  // Custom threshold widens/narrows what counts.
  assert.equal(isSpikeMove(100, t0, 100.05, t0 + 30_000, 0.05), true)
})

test('isSpikeMove: no prior sample, non-finite price, or non-advancing clock never spikes', () => {
  const t0 = 1_000_000
  assert.equal(isSpikeMove(undefined, undefined, 101, t0), false)
  assert.equal(isSpikeMove(100, t0, null, t0 + MIN), false)
  assert.equal(isSpikeMove(100, t0, 200, t0), false)      // clock didn't advance
  assert.equal(isSpikeMove(0, t0, 1, t0 + MIN), false)    // prevMid <= 0 is garbage, not "infinite move"
})

test('SPIKE_PCT_PER_MIN is exported and isSpikeMove uses it as the default threshold', () => {
  const t0 = 1_000_000
  const justUnder = 100 * (1 + (SPIKE_PCT_PER_MIN - 0.01) / 100)
  const justOver = 100 * (1 + (SPIKE_PCT_PER_MIN + 0.01) / 100)
  assert.equal(isSpikeMove(100, t0, justUnder, t0 + MIN), false)
  assert.equal(isSpikeMove(100, t0, justOver, t0 + MIN), true)
})

// Frozen-quote detector (hardening batch 6a) ----------------------------

test('frozenQuoteUpdate: first sighting and any price movement restart the episode', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  assert.deepEqual(r, { rec: { mid: 1.1, changedAt: t0, alerted: false }, alert: false, recovered: false })
  r = frozenQuoteUpdate(r.rec, 1.1001, t0 + MIN, 10 * MIN)
  assert.equal(r.rec.changedAt, t0 + MIN)
  assert.equal(r.alert, false)
})

test('frozenQuoteUpdate: unchanged past the threshold alerts exactly once', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 9 * MIN, 10 * MIN)
  assert.equal(r.alert, false)                              // still inside the threshold
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 11 * MIN, 10 * MIN)
  assert.equal(r.alert, true)                               // breach → alert
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 30 * MIN, 10 * MIN)
  assert.equal(r.alert, false)                              // same episode → no re-alert
})

test('frozenQuoteUpdate: movement after an alert reports recovery and re-arms', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 10 * MIN)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 11 * MIN, 10 * MIN)
  assert.equal(r.alert, true)
  r = frozenQuoteUpdate(r.rec, 1.2, t0 + 12 * MIN, 10 * MIN)
  assert.equal(r.recovered, true)
  assert.equal(r.rec.alerted, false)                        // fresh episode — can alert again
  r = frozenQuoteUpdate(r.rec, 1.2, t0 + 23 * MIN, 10 * MIN)
  assert.equal(r.alert, true)
})

test('frozenQuoteUpdate: threshold 0 disables alerting entirely', () => {
  const t0 = 1_000_000
  let r = frozenQuoteUpdate(undefined, 1.1, t0, 0)
  r = frozenQuoteUpdate(r.rec, 1.1, t0 + 100 * MIN, 0)
  assert.equal(r.alert, false)
  assert.equal(FROZEN_QUOTE_DEFAULT_MIN, 10)
})

// ---------------------------------------------------------------------------
// Sub-cadence gating. The bug this replaces: `tick % everyTicks(n) === 0` on a
// counter that advances during SKIPPED ticks, so a sub-task ran only when a
// multiple of its period happened to coincide with a tick where the body
// actually started. Production cost: cpp_exec went 26h with no beat at all.
// ---------------------------------------------------------------------------

test('cadence gate: arms on first sighting, then fires on wall-clock elapsed', () => {
  const due = makeCadenceGate()
  const t0 = 1_000_000
  assert.equal(due('probe', 120, t0), false, 'first sighting arms, does not fire')
  assert.equal(due('probe', 120, t0 + 119_000), false)
  assert.equal(due('probe', 120, t0 + 120_000), true)
  assert.equal(due('probe', 120, t0 + 120_001), false, 're-armed immediately after firing')
  assert.equal(due('probe', 120, t0 + 240_000), true)
})

test('cadence gate: keys are independent', () => {
  const due = makeCadenceGate()
  const t0 = 0
  due('a', 60, t0); due('b', 120, t0)
  assert.equal(due('a', 60, t0 + 60_000), true)
  assert.equal(due('b', 120, t0 + 60_000), false, 'b is on its own schedule')
  assert.equal(due('b', 120, t0 + 120_000), true)
})

test('cadence gate: a late pass owes ONE run, not a backlog', () => {
  const due = makeCadenceGate()
  due('probe', 60, 0)
  // The pass overran by ten minutes. One fire, then re-anchored from now —
  // catching up ten missed probes would be ten broker round-trips at once.
  assert.equal(due('probe', 60, 600_000), true)
  assert.equal(due('probe', 60, 600_001), false)
  assert.equal(due('probe', 60, 660_000), true)
})

test('cadence gate: SKIPPED ticks cannot starve a sub-task (the 26h cpp_exec bug)', () => {
  // Replay the exact production shape: a 3s ticker whose body takes 60s, so
  // only every 20th firing actually runs the body. Under the old rule the
  // run-start ticks were 1, 21, 41, 61… — never ≡ 0 (mod 20) and never
  // ≡ 0 (mod 40) — so the 60s watchdog and the 120s cpp probe fired ZERO
  // times, forever. Time-based gating does not care which ticks ran.
  const TICK_MS = 3_000, BODY_TICKS = 20
  const due = makeCadenceGate()
  let probes = 0, watchdogs = 0
  let oldProbes = 0, oldWatchdogs = 0
  let tick = 0, busyUntil = 0
  const everyTicks = (secs) => Math.max(1, Math.round((secs * 1000) / TICK_MS))

  for (let i = 0; i < 2_000; i++) {          // 2,000 ticks = 100 minutes
    tick++
    if (tick < busyUntil) continue           // overlap guard: body still running
    busyUntil = tick + BODY_TICKS
    const nowMs = tick * TICK_MS
    if (tick % everyTicks(120) === 0) oldProbes++       // the old rule…
    if (tick % everyTicks(60) === 0) oldWatchdogs++
    if (due('cpp_probe', 120, nowMs)) probes++          // …and the new one
    if (due('watchdog', 60, nowMs)) watchdogs++
  }

  assert.equal(oldProbes, 0, 'the old modulo rule never fired — this is the bug')
  assert.equal(oldWatchdogs, 0, 'the stall alerter was starved the same way')
  // 100 minutes of wall clock: ~50 probes at 120s, ~100 watchdog passes at 60s.
  // The body only runs once a minute, so each gate fires at most once per run.
  assert.ok(probes >= 45 && probes <= 50, `cpp probe should fire ~50×, got ${probes}`)
  assert.ok(watchdogs >= 90 && watchdogs <= 100, `watchdog should fire ~100×, got ${watchdogs}`)
})

test('cadence gate: a fast ticker with no skips does not multiply traffic', () => {
  // The property the old `everyTicks` was there to protect: dropping
  // FAST_MONITOR_MS from 3s to 1s must not triple probe volume.
  const runs = (tickMs) => {
    const due = makeCadenceGate()
    let n = 0
    for (let tick = 1; tick * tickMs <= 3_600_000; tick++) if (due('probe', 120, tick * tickMs)) n++
    return n
  }
  assert.equal(runs(1_000), runs(3_000), 'probe count follows the clock, not the tick rate')
  assert.equal(runs(3_000), 29, 'one hour at 120s, minus the arming interval')
})

// ---------------------------------------------------------------------------
// TWO TICKERS (owner § 7,453·C, 08-09-2026): the protection band on its own
// interval, measured, recorded and beaten as its own controller.
// ---------------------------------------------------------------------------
import { initDB, getState } from '../db.js'
import { startFastMonitor, rollingMax, bandOverran, PASS_RECORD_KEY, withBudget } from './fast-monitor.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('rollingMax keeps the window and reports its maximum; bandOverran is strictly past the cadence', () => {
  const now = 1_000_000
  const { kept, max } = rollingMax([{ at: now - 700_000, ms: 90 }, { at: now - 100, ms: 40 }, { at: now, ms: 55 }], now, 600_000)
  assert.equal(kept.length, 2); assert.equal(max, 55)
  assert.equal(rollingMax([], now).max, null)
  assert.equal(bandOverran(60_000, 60_000), false); assert.equal(bandOverran(60_001, 60_000), true)
})

test('a slow protection band never skips the spike tick; its overrun is recorded and beaten as an error', async () => {
  const db = initDB(':memory:')
  const beats = []
  const hb = { beat: (_db, name, o) => beats.push({ name, ...o }), probeCppExec: async () => {}, checkHeartbeats: () => {}, checkAccountAuthorization: () => {} }
  let ticks = 0
  const stop = startFastMonitor(db, () => ({ ready: false }), {
    tickMs: 5, bandMs: 20, heartbeat: hb,
    runTick: async () => { ticks++; return null },
    runBand: () => sleep(60),
  })
  await sleep(150)
  stop()
  // Timer granularity: a 60ms sleep reads 59ms on Date.now() about one run
  // in three (CI 08-09, then 5/15 locally), so the bounds are loose — the
  // claims are "ticks kept running" and "the band outlived its 20ms
  // cadence", not exact milliseconds.
  assert.ok(ticks >= 6, `the tick kept running while the band slept 60ms: ${ticks} ticks`)
  const rec = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.equal(rec.band.overran, true)
  assert.ok(rec.band.lastMs >= 40, `band measured ${rec.band.lastMs}ms`)
  assert.ok(rec.band.skippedBands >= 1, 'the band skipped its own firings while running, and said so')
  assert.equal(rec.band.everyMs, 20); assert.equal(rec.tick.everyMs, 5)
  assert.ok(rec.tick.max10mMs != null && rec.tick.lastMs != null, 'tick durations are measured too')
  const pb = beats.filter(b => b.name === 'protection_band')
  assert.ok(pb.length >= 1, 'the band beats its own controller')
  assert.equal(pb[0].ok, false); assert.match(pb[0].error, /over its 0s cadence/)
  assert.ok(beats.some(b => b.name === 'fast_monitor' && b.ok === true && Number.isFinite(b.detail?.ms)), 'the tick beats fast_monitor with its duration')
})

test('a band inside its cadence beats ok and records overran:false', async () => {
  const db = initDB(':memory:')
  const beats = []
  const hb = { beat: (_db, name, o) => beats.push({ name, ...o }) }
  const stop = startFastMonitor(db, () => ({ ready: false }), { tickMs: 5, bandMs: 15, heartbeat: hb, runTick: async () => null, runBand: async () => {} })
  await sleep(60)
  stop()
  const rec = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.equal(rec.band.overran, false)
  const pb = beats.filter(b => b.name === 'protection_band')
  assert.ok(pb.length >= 1); assert.equal(pb[0].ok, true); assert.equal(pb[0].error, null)
})

// ---------------------------------------------------------------------------
// EVERY BAND JOB HAS A BUDGET, INCLUDING THE PROTECTION AUDIT (17-09-2026).
//
// The audit was the one job outside `withBudget`, and it became the one job
// that can block on the broker: since the protection applier re-reads each
// position LIVE before amending, a pass opens WS sessions serially, and
// `wsReconcile` is `withRetry(..., 2)` at a 25s timeout with 2s/4s backoff —
// 81s worst case for a single read. One hung apply parked the whole band,
// flipped `protection_band` red, and — because the audit runs AFTER the keeper
// and the guardian — delayed the next pass's stop ratchet.
//
// A source scan, and a last resort: the alternative is a test that waits out a
// real 45-second budget. Comments are stripped first, because the block above
// the call explains the budget and names it.
// ---------------------------------------------------------------------------

test('the protection audit runs under the same band budget as every other job', async () => {
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(new URL('./fast-monitor.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// withBudget'), false, 'comment stripper works')

  const i = src.indexOf('runProtectionAuditBothSides(db, creds, deps)')
  assert.ok(i > 0, "the audit call is gone — this test's anchor is with it")
  // The call must sit inside a withBudget(...) invocation, not merely near one.
  const before = src.slice(Math.max(0, i - 400), i)
  assert.match(before, /withBudget\(\s*'protection_audit'/,
    'the protection audit must be wrapped, or one hung broker read parks the whole band')
  // And the budget must actually be observed, not discarded.
  const after = src.slice(i, i + 400)
  assert.match(after, /paRes\.error/, 'a budget whose timeout is ignored is not a budget')
})

test('withBudget really does abandon a wait that overruns', async () => {
  // The property the scan above depends on. Without this, the scan pins a call
  // to a function that might not bound anything.
  const t0 = Date.now()
  const res = await withBudget('never', 40, () => new Promise(() => {}))
  assert.equal(res.timedOut, true)
  assert.match(res.error.message, /exceeded its/)
  assert.ok(Date.now() - t0 < 2000)
})

// ---------------------------------------------------------------------------
// Wave 5 (first-principles audit 19-09-2026 §K item 15): the tick's overrun
// as a measured share, written by the tick path itself.
// ---------------------------------------------------------------------------
import { tickShares, TICK_RECORD_MIN_MS } from './fast-monitor.js'

test('tickShares: skipped over expected ticks, busy over the window, capped and rounded; empty window → null', () => {
  // 10 min at 3 s = 200 expected ticks; 20 skipped = 10 %; 60 s busy = 10 %.
  assert.deepEqual(tickShares({ sampleMs: [30_000, 30_000], skipped: 20, windowMs: 600_000, everyMs: 3_000 }), { skipShare: 0.1, busyShare: 0.1, expectedTicks: 200 })
  // A young monitor is judged on its uptime: 30 s at 3 s = 10 expected.
  assert.equal(tickShares({ sampleMs: [], skipped: 5, windowMs: 30_000, everyMs: 3_000 }).skipShare, 0.5)
  assert.equal(tickShares({ sampleMs: [900_000], skipped: 999, windowMs: 600_000, everyMs: 3_000 }).skipShare, 1, 'capped')
  assert.equal(tickShares({ sampleMs: [], skipped: 0, windowMs: 0, everyMs: 3_000 }).skipShare, null)
  assert.equal(TICK_RECORD_MIN_MS, 5_000)
})

test('the TICK path writes the pass record without the band, counts every skip in the window, and does not need the band to have run', async () => {
  const db = initDB(':memory:')
  const hb = { beat: () => {} }
  let t = 1_000_000
  // A tick that outlives its cadence several times over: the ticker skips
  // its own next firings while it runs, and each skip is a sample. The fake
  // clock is pushed past the 5 s throttle before the read, so the record
  // read is one written AFTER the skips, not the first (throttled) one.
  const stop = startFastMonitor(db, () => ({ ready: false }), {
    tickMs: 5, bandMs: 10_000, heartbeat: hb, clock: () => t,
    runTick: async () => { await sleep(40); t += 40 }, runBand: async () => {},
  })
  await sleep(120)
  t += TICK_RECORD_MIN_MS
  await sleep(60)
  stop()
  const rec = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.ok(rec, 'the record exists although the band never ran')
  assert.equal(rec.band.lastMs, null, 'the band figures are blank, not invented')
  assert.ok(rec.tick.skipped10m >= 3, `skips in the window are counted: ${rec.tick.skipped10m}`)
  assert.ok(rec.tick.skipShare10m > 0 && rec.tick.skipShare10m <= 1, `skipShare10m ${rec.tick.skipShare10m}`)
  assert.ok(rec.tick.busyShare10m > 0 && rec.tick.busyShare10m <= 1, `busyShare10m ${rec.tick.busyShare10m}`)
})

test('the tick-path record is throttled to once per TICK_RECORD_MIN_MS (the first write lands, the next inside the window does not)', async () => {
  const db = initDB(':memory:')
  let t = 1_000_000
  const clock = () => t
  const stop = startFastMonitor(db, () => ({ ready: false }), {
    tickMs: 5, bandMs: 10_000, heartbeat: { beat: () => {} }, clock,
    runTick: async () => { t += 1 },   // each tick "takes" 1 ms on the fake clock
    runBand: async () => {},
  })
  await sleep(40)
  const first = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.ok(first, 'first tick wrote the record')
  await sleep(40)
  const second = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.equal(second.at, first.at, 'inside the 5 s throttle the record is not re-written')
  t += TICK_RECORD_MIN_MS
  await sleep(40)
  const third = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.notEqual(third.at, first.at, 'past the throttle it is')
  stop()
})


test('a timed-out band step joins its in-flight work instead of duplicating it', async () => {
  const { runBandStep } = await import('./fast-monitor.js')
  const db = {}
  let release, calls = 0
  const work = () => { calls++; return new Promise(resolve => { release = resolve }) }
  await assert.rejects(runBandStep(db, 'slow', work, 5), /budget/)
  await assert.rejects(runBandStep(db, 'slow', work, 5), /budget/)
  assert.equal(calls, 1)
  assert.equal(await runBandStep(db, 'independent', async () => 'checked', 50), 'checked')
  release('done')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await runBandStep(db, 'slow', async () => 'next pass', 50), 'next pass')
})

test('band steps surface returned operation errors as failures', async () => {
  const { runBandStep } = await import('./fast-monitor.js')
  await assert.rejects(runBandStep({}, 'failure', async () => ({ errors: ['broker rejected'] })), /broker rejected/)
})


test('a failed sidecar probe cannot skip the protection watchdog', async () => {
  const { runProtectionBand } = await import('./fast-monitor.js')
  const checked = []
  await assert.rejects(runProtectionBand({}, { ready: false }, {
    due: key => key !== 'log_inspector',
    heartbeat: {
      probeCppExec: async () => { throw new Error('probe unavailable') },
      checkHeartbeats: () => checked.push('heartbeats'),
      checkAccountAuthorization: () => checked.push('accounts'),
    },
  }), /probe unavailable/)
  assert.deepEqual(checked, ['heartbeats', 'accounts'])
})
