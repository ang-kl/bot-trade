// Event-loop lag, sampled per loop sub-phase.
//
// Why this exists (2026-07-28). With the phases finally named, one production
// cycle broke down as: scan 60.2s, monitor 52.6s, pending orders 29.4s, profit
// keeper 12.0s — and all four risk breakers at 2ms each. So 99% of the cycle
// sits in four phases dominated by broker I/O.
//
// That leaves two completely different explanations for "reads stall 8-29s",
// with two completely different fixes:
//
//   A. The phases are mostly WAITING. The event loop is free during those
//      awaits, so HTTP handlers run promptly — and if reads still stall, the
//      cause is outside this process (proxy, CDN, sidecar, client). Yielding or
//      offloading work would fix nothing.
//
//   B. The phases are many small CPU bursts BETWEEN waits — protobuf decode,
//      indicator math over bar arrays, JSON, synchronous SQLite. Then a request
//      queues behind however much CPU is left in the phase, and the fix is to
//      cut round-trips or move work off this thread.
//
// Wall-clock per phase cannot tell A from B. Event-loop delay can: it measures
// how long a callback that was ready to run actually had to wait.
//
// IMPLEMENTATION NOTE — perf_hooks.monitorEventLoopDelay was tried first and
// rejected on evidence: on this runtime it reported ~10.2ms max (i.e. roughly
// its own resolution) through a deliberate 220ms block, because libuv coalesces
// the skipped timer ticks. An instrument that cannot see a 220ms block is worse
// than none here, since a low reading is exactly the conclusion we would act on.
// So this uses the plain self-rescheduling timer probe: expected fire time vs
// actual, which catches blocks directly and is verified to do so in the tests.
import { BOOT_ORIGIN_MS, inStartupWindow } from './boot-clock.js'

const PROBE_MS = Math.max(20, Number(process.env.LAG_PROBE_MS) || 100)

// Only stalls at least this long get a CPU ratio recorded. Below it the sample
// is dominated by ordinary jitter and the ratio would be noise presented as
// evidence — which is worse than no number.
const STALL_MS_FOR_CPU_RATIO = 250

// ---------------------------------------------------------------------------
// THE TAP (V3 M1, P1/P4-1). sampleLag() below READS AND RESETS `stats`: the
// loop calls it at every phase boundary to attribute lag to the phase that
// just ended. Any second caller would steal those samples and corrupt
// loopPhaseLag — and a process-wide lag figure read on a timer (the 30-second
// ALIVE line in lib/diagnostics.js) misses every stall that does not happen to
// straddle its due time. So the probe itself feeds a second, NON-DESTRUCTIVE
// record that nothing resets:
//
//   · a histogram of every probe's lateness since the tap started;
//   · one-minute slots (two hours kept) with the same histogram, so a window
//     can be summarised without keeping 72,000 raw samples;
//   · the worst stall since start, with WHEN and the main loop's phase label
//     at the time (markLagPhase). The label names what the loop was doing, not
//     proof of the cause: an HTTP handler or the fast monitor can block while
//     the loop sleeps — and a stall labelled 'idle' says exactly that;
//   · the worst stall inside the startup window (boot-clock.js).
//
// Percentiles come from the histogram, so they are UPPER BOUNDS: p99LeMs is
// "99 % of probes were at most this late". The edges include 1,000 and 5,000
// on purpose — the proposed limits (p99 under 1,000 ms, max under 5,000 ms) —
// so grading against them is exact, not interpolated.
// ---------------------------------------------------------------------------

/** Histogram bucket upper edges (ms, inclusive). One more bucket holds > the last edge. */
export const LAG_BUCKET_EDGES_MS = Object.freeze([10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000])
export const TAP_SLOT_MS = 60_000
export const TAP_SLOTS = 120

let timer = null
let stats = null
let tap = null
let lagPhase = 'boot'

/** Index of the histogram bucket a lateness of `ms` falls in. Pure. */
export function lagBucketIndex(ms, edges = LAG_BUCKET_EDGES_MS) {
  const v = Math.max(0, Number(ms) || 0)
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i
  return edges.length
}

/**
 * Nearest-rank percentile from bucket counts, as an UPPER BOUND: the upper
 * edge of the bucket holding the rank, capped at the observed max (the top
 * bucket has no edge of its own). Null when there are no samples. Pure.
 */
export function histogramPercentileLe(counts, p, maxMs, edges = LAG_BUCKET_EDGES_MS) {
  const n = counts.reduce((a, b) => a + b, 0)
  if (!n) return null
  const rank = Math.max(1, Math.ceil(n * p))
  let cum = 0
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i]
    if (cum >= rank) {
      const edge = i < edges.length ? edges[i] : Infinity
      return Math.round(Math.min(edge, Number(maxMs) || 0) * 10) / 10
    }
  }
  return Math.round((Number(maxMs) || 0) * 10) / 10
}

function freshCounts() { return new Array(LAG_BUCKET_EDGES_MS.length + 1).fill(0) }

function freshTap(nowMs) {
  return { startedAt: nowMs, n: 0, sumMs: 0, maxMs: 0, worst: null, startupWorst: null, counts: freshCounts(), slots: [] }
}

/**
 * Name what the MAIN LOOP is doing, for the tap's stall record. loop.js calls
 * this from phase() with the stable phase key, and 'idle' between cycles.
 */
export function markLagPhase(name) {
  lagPhase = String(name || 'unknown').slice(0, 60)
}

function tapRecord(late, now, phaseAtArm) {
  if (!tap) return
  const ms = Math.max(0, late)
  const b = lagBucketIndex(ms)
  tap.n += 1
  tap.sumMs += ms
  tap.counts[b] += 1
  const stall = { ms: Math.round(ms * 10) / 10, at: new Date(now).toISOString(), loopPhase: lagPhase, loopPhaseAtArm: phaseAtArm }
  if (ms > tap.maxMs || !tap.worst) { tap.maxMs = ms; tap.worst = stall }
  if (inStartupWindow(now, BOOT_ORIGIN_MS) && (!tap.startupWorst || ms > tap.startupWorst.ms)) tap.startupWorst = stall
  const key = Math.floor(now / TAP_SLOT_MS)
  let slot = tap.slots[tap.slots.length - 1]
  if (!slot || slot.key !== key) {
    slot = { key, startMs: key * TAP_SLOT_MS, n: 0, maxMs: 0, worst: null, counts: freshCounts() }
    tap.slots.push(slot)
    if (tap.slots.length > TAP_SLOTS) tap.slots.splice(0, tap.slots.length - TAP_SLOTS)
  }
  slot.n += 1
  slot.counts[b] += 1
  if (ms > slot.maxMs || !slot.worst) { slot.maxMs = ms; slot.worst = stall }
}

function fresh() {
  return { maxMs: 0, sumMs: 0, samples: 0, wallMs: 0, cpuMs: 0, worstStallCpuRatio: null }
}

// CPU consumed by THIS process, in ms. Used to tell "our JS is burning the
// thread" apart from "the container is not being given CPU".
const cpuMs = () => {
  const c = process.cpuUsage()
  return (c.user + c.system) / 1000
}

function schedule() {
  const expected = Date.now() + PROBE_MS
  const startWall = Date.now()
  const startCpu = cpuMs()
  const phaseAtArm = lagPhase
  timer = setTimeout(() => {
    const now = Date.now()
    const late = now - expected
    // The tap first, and unconditionally: it must see every probe whatever
    // sampleLag() has done to `stats` since the last one.
    tapRecord(late, now, phaseAtArm)
    if (stats && late >= 0) {
      if (late > stats.maxMs) stats.maxMs = late
      stats.sumMs += late
      stats.samples += 1

      // THE DECIDING MEASUREMENT (2026-07-28). Production blocks for ~53s at a
      // time across phases that do completely different work, which does not
      // look like one slow function. Two very different causes produce that:
      //
      //   our JS holds the thread  → the process BURNS CPU while late
      //                              (cpu/wall ≈ 1 on a single-threaded loop)
      //   the container is starved → the process gets NO CPU while late
      //                              (cpu/wall ≈ 0) — a platform/quota problem
      //
      // Wall-clock lag alone cannot tell these apart, and the fixes are
      // opposite: rewrite our code, versus change the plan or the deployment.
      const dWall = now - startWall
      const dCpu = cpuMs() - startCpu
      stats.wallMs += dWall
      stats.cpuMs += dCpu
      // Record the ratio during the WORST stall specifically — an average over
      // a mostly-idle window would wash the stall out.
      if (late >= STALL_MS_FOR_CPU_RATIO && dWall > 0 && late >= stats.maxMs) {
        stats.worstStallCpuRatio = Math.round((dCpu / dWall) * 100) / 100
      }
    }
    schedule()
  }, PROBE_MS)
  // Never hold the process open — this is diagnostics, not work.
  if (typeof timer.unref === 'function') timer.unref()
}

/** Start sampling. Idempotent — safe to call from module scope. */
export function startLagMonitor() {
  if (timer) return true
  stats = fresh()
  tap = freshTap(Date.now())
  schedule()
  return true
}

/**
 * The tap, summarised — never resets anything. `windowMs` null/omitted: since
 * the tap started. Otherwise the one-minute slots overlapping the last
 * `windowMs` (rounded OUT to whole slots; `coveredFrom` says where the data
 * starts). Null when the monitor was never started; `n: 0` and null figures
 * when the window holds no probe — an honest unknown, never a zero.
 */
export function lagTapSummary({ windowMs = null, nowMs = Date.now() } = {}) {
  if (!timer || !tap) return null
  let counts, n, maxMs, worst, coveredFrom
  if (windowMs == null) {
    counts = tap.counts.slice(); n = tap.n; maxMs = tap.maxMs; worst = tap.worst
    coveredFrom = new Date(tap.startedAt).toISOString()
  } else {
    const from = nowMs - Number(windowMs)
    const slots = tap.slots.filter(s => s.startMs + TAP_SLOT_MS > from && s.startMs <= nowMs)
    counts = freshCounts(); n = 0; maxMs = 0; worst = null
    for (const s of slots) {
      n += s.n
      for (let i = 0; i < counts.length; i++) counts[i] += s.counts[i]
      if (s.worst && (!worst || s.maxMs > maxMs)) { maxMs = s.maxMs; worst = s.worst }
    }
    coveredFrom = slots.length ? new Date(Math.max(slots[0].startMs, tap.startedAt)).toISOString() : null
  }
  return {
    windowMs: windowMs == null ? null : Number(windowMs),
    coveredFrom,
    probeMs: PROBE_MS,
    n,
    maxMs: n ? Math.round(maxMs * 10) / 10 : null,
    p50LeMs: histogramPercentileLe(counts, 0.5, maxMs),
    p95LeMs: histogramPercentileLe(counts, 0.95, maxMs),
    p99LeMs: histogramPercentileLe(counts, 0.99, maxMs),
    worst: n ? worst : null,
    histogram: { edgesMs: [...LAG_BUCKET_EDGES_MS], counts },
  }
}

/** The worst probe lateness inside the startup window (boot-clock.js), or null. */
export function lagTapStartupWorst() {
  return tap?.startupWorst ?? null
}

/**
 * Read the lag accumulated since the last sample, then start a new window.
 *
 * Returns null when the monitor was never started, and nulls inside the object
 * when a window collected no samples — an honest "unknown", never a zero that
 * would read as "the loop was free".
 */
export function sampleLag() {
  if (!timer) return null
  const s = stats
  stats = fresh()
  if (!s || s.samples === 0) {
    return { maxMs: null, meanMs: null, samples: 0, cpuRatio: null, worstStallCpuRatio: null }
  }
  return {
    maxMs: Math.round(s.maxMs * 10) / 10,
    meanMs: Math.round((s.sumMs / s.samples) * 10) / 10,
    samples: s.samples,
    // Over the whole window: ~1 means this process was busy computing, ~0 means
    // it was waiting or was not scheduled at all.
    cpuRatio: s.wallMs > 0 ? Math.round((s.cpuMs / s.wallMs) * 100) / 100 : null,
    // During the worst stall only — the number that names the cause.
    worstStallCpuRatio: s.worstStallCpuRatio,
  }
}

/** Test seam — stop the probe so a fresh one can be started. */
export function _resetForTests() {
  if (timer) clearTimeout(timer)
  timer = null
  stats = null
  tap = null
  lagPhase = 'boot'
}
