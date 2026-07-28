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
const PROBE_MS = Math.max(20, Number(process.env.LAG_PROBE_MS) || 100)

// Only stalls at least this long get a CPU ratio recorded. Below it the sample
// is dominated by ordinary jitter and the ratio would be noise presented as
// evidence — which is worse than no number.
const STALL_MS_FOR_CPU_RATIO = 250

let timer = null
let stats = null

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
  timer = setTimeout(() => {
    const now = Date.now()
    const late = now - expected
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
  schedule()
  return true
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
}
