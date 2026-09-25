// event-loop-lag — the instrument that decides how #121 gets fixed, so it has
// to be trustworthy in both directions: it must SEE a block, and it must not
// invent one when the process was merely waiting.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  startLagMonitor, sampleLag, _resetForTests,
  lagTapSummary, lagTapStartupWorst, markLagPhase, lagBucketIndex, histogramPercentileLe, LAG_BUCKET_EDGES_MS,
} from './event-loop-lag.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const blockFor = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) { /* deliberately block the event loop */ }
}

test('sampleLag returns null before the monitor is started', () => {
  _resetForTests()
  assert.equal(sampleLag(), null)
})

test('a real block shows up as lag', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)         // let the probe take a baseline sample
  sampleLag()              // discard the baseline window
  blockFor(220)
  await sleep(150)         // let the delayed probe fire and be recorded
  const lag = sampleLag()
  assert.ok(lag, 'expected a sample')
  // Generous threshold: CI machines are noisy and the point is only that a
  // ~220ms block is visible, not that the number is exact.
  assert.ok(lag.maxMs >= 100, `expected lag to reflect the block, got ${lag.maxMs}ms`)
})

test('waiting on a timer is NOT reported as blocking', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  await sleep(400)         // idle: the loop is free the whole time
  const lag = sampleLag()
  assert.ok(lag, 'expected a sample')
  // This is the distinction the whole module exists for. If idling registered
  // as lag, the instrument could not tell "phase was waiting on the broker"
  // from "phase was hogging the thread".
  assert.ok(lag.maxMs < 100, `idle time should not read as blocking, got ${lag.maxMs}ms`)
})

test('sampling resets the window, so phases do not inherit each other', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  blockFor(200)
  await sleep(150)
  const blocked = sampleLag()
  await sleep(300)
  const idle = sampleLag()
  assert.ok(blocked.maxMs > idle.maxMs, `expected the block window (${blocked.maxMs}ms) to exceed the idle window (${idle.maxMs}ms)`)
})

test('reported fields are finite numbers or explicit nulls, never NaN', async () => {
  _resetForTests()
  startLagMonitor()
  const lag = sampleLag()
  for (const k of ['maxMs', 'meanMs']) {
    const v = lag[k]
    assert.ok(v === null || Number.isFinite(v), `${k} was ${v}`)
  }
})

test('a CPU-burning block reports cpuRatio near 1 — "our code is holding the thread"', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  blockFor(400)              // a busy-wait: burns CPU while blocking
  await sleep(150)
  const lag = sampleLag()
  assert.ok(lag.maxMs >= 100, `expected a visible stall, got ${lag.maxMs}ms`)
  assert.ok(lag.worstStallCpuRatio !== null, 'the worst stall should carry a CPU ratio')
  // Busy-waiting consumes CPU for essentially the whole stall.
  assert.ok(lag.worstStallCpuRatio > 0.5,
    `a busy-wait should burn CPU, got ratio ${lag.worstStallCpuRatio}`)
})

test('idle time reports a LOW cpuRatio — the distinction the field exists for', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  await sleep(400)           // sleeping: no CPU consumed
  const lag = sampleLag()
  assert.ok(lag.cpuRatio !== null)
  assert.ok(lag.cpuRatio < 0.5, `idle should not look CPU-bound, got ${lag.cpuRatio}`)
})

// ---------------------------------------------------------------------------
// V3 M1 (P1/P4-1): the NON-DESTRUCTIVE TAP. sampleLag() reads and resets its
// window at every loop phase boundary, so a second reader would steal the
// loop's samples; the tap is fed by the same 100 ms probe and never reset.
// ---------------------------------------------------------------------------

test('the tap and sampleLag BOTH see one planted 220 ms block — and sampleLag resetting its window does not take it from the tap', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()                       // the loop's phase boundary: discard the baseline
  markLagPhase('decision audit')
  blockFor(220)
  await sleep(150)
  const phaseWindow = sampleLag()   // the loop reads (and RESETS) its window first
  assert.ok(phaseWindow.maxMs >= 100, `sampleLag must still see the block, got ${phaseWindow.maxMs}ms`)
  sampleLag()                       // …and again, as the next phase boundary would
  const tap = lagTapSummary()
  assert.ok(tap, 'the tap is on while the monitor runs')
  assert.ok(tap.maxMs >= 100, `the tap must keep the block after two resets, got ${tap.maxMs}ms`)
  assert.ok(tap.worst && tap.worst.ms >= 100, JSON.stringify(tap.worst))
  assert.equal(tap.worst.loopPhase, 'decision audit', 'the stall names the loop phase it happened in')
  assert.match(tap.worst.at, /^\d{4}-\d{2}-\d{2}T/)
  const last10 = lagTapSummary({ windowMs: 10 * 60_000 })
  assert.ok(last10.maxMs >= 100, 'the windowed view sees it too')
  // The process started seconds ago, so the block is inside the startup window.
  assert.ok(lagTapStartupWorst()?.ms >= 100, JSON.stringify(lagTapStartupWorst()))
  _resetForTests()
})

test('the tap is null before the monitor starts; an idle window reads low and never invents a stall', async () => {
  _resetForTests()
  assert.equal(lagTapSummary(), null)
  startLagMonitor()
  await sleep(350)
  const tap = lagTapSummary()
  assert.ok(tap.n >= 2, `expected probes, got ${tap.n}`)
  assert.ok(tap.maxMs < 100, `idle is not a stall, got ${tap.maxMs}ms`)
  assert.equal(tap.histogram.counts.reduce((a, b) => a + b, 0), tap.n, 'every probe lands in exactly one bucket')
  assert.deepEqual(tap.histogram.edgesMs, [...LAG_BUCKET_EDGES_MS])
  _resetForTests()
})

test('bucket edges are inclusive, and the proposed limits (1,000 / 5,000 ms) are edges so grading against them is exact', () => {
  assert.ok(LAG_BUCKET_EDGES_MS.includes(1000) && LAG_BUCKET_EDGES_MS.includes(5000))
  assert.equal(lagBucketIndex(0), 0)
  assert.equal(lagBucketIndex(10), 0)
  assert.equal(lagBucketIndex(10.1), 1)
  assert.equal(lagBucketIndex(1000), LAG_BUCKET_EDGES_MS.indexOf(1000))
  assert.equal(lagBucketIndex(1001), LAG_BUCKET_EDGES_MS.indexOf(1000) + 1)
  assert.equal(lagBucketIndex(-5), 0, 'an early timer is 0 ms late, not negative')
  assert.equal(lagBucketIndex(99_999), LAG_BUCKET_EDGES_MS.length, 'past the last edge → the open top bucket')
})

test('histogram percentiles on a known sample set are nearest-rank UPPER BOUNDS, capped at the observed max', () => {
  const counts = new Array(LAG_BUCKET_EDGES_MS.length + 1).fill(0)
  // 100 probes: 90 at ≤10 ms, 5 at ≤250, 4 at ≤1000, 1 at 4,200 ms
  const samples = [...Array(90).fill(3), ...Array(5).fill(200), ...Array(4).fill(900), 4200]
  for (const s of samples) counts[lagBucketIndex(s)]++
  assert.equal(histogramPercentileLe(counts, 0.5, 4200), 10)
  assert.equal(histogramPercentileLe(counts, 0.95, 4200), 250, 'rank 95 is the last of the ≤250 bucket')
  assert.equal(histogramPercentileLe(counts, 0.99, 4200), 1000, 'rank 99 is the last of the ≤1000 bucket')
  assert.equal(histogramPercentileLe(counts, 1, 4200), 4200, 'the ≤5000 bucket is capped at the observed max')
  assert.equal(histogramPercentileLe(new Array(12).fill(0), 0.99, 0), null, 'no samples → null, never 0')
  // one sample past the top edge: the percentile is the observed max, not Infinity
  const top = new Array(LAG_BUCKET_EDGES_MS.length + 1).fill(0)
  top[lagBucketIndex(45_000)]++
  assert.equal(histogramPercentileLe(top, 0.5, 45_000), 45_000)
})
