// Per-phase V8 CPU profile — names the function that burns the thread.
//
// WHY THIS EXISTS (2026-07-28). event-loop-lag.js settled *whether* the loop is
// CPU-bound: the monitor phase blocks ~53s at a stretch with a worst-stall CPU
// ratio of 1.02, and autopilot at 1.01, while every broker-bound phase sits at
// 0.02-0.06. So our own JS is holding the thread — not Railway starving us.
//
// It cannot say WHICH code. Reading monitorOnePosition top to bottom does not
// answer it either: every step in that function looks cheap (one indexed SQLite
// write, a small prompt string, one HTTPS call). "Looks cheap" is exactly the
// reasoning that produced the last two wrong answers on this bug — the deeper
// bar fetch, and the broker transport — both of which measurement then killed.
//
// So: stop reading, sample. V8's own sampling profiler attributes time to real
// call frames, including native ones (a synchronous better-sqlite3 query, JSON,
// TLS, GC) which are invisible to any hand-placed timer. Turning it on for one
// named phase costs a few percent and answers the question directly instead of
// ranking suspects.
//
// Recurring phase profiles are OPT-IN via CPU_PROFILE_PHASES. The loop also
// requests ONE bounded first-cycle profile: phase handoffs and background
// callbacks were outside the retained scan trace during a measured 47s stall.
// It logs code locations/timings only, then returns to the opt-in policy.
import inspector from 'node:inspector'

// 5ms between samples. At the ~200s phases we are chasing that is ~40k samples,
// which is bounded memory, and still 10,000 samples inside a single 53s block —
// far more resolution than needed to name a hot frame.
// Read at phase start: index.js may load .env after importing this module.
const sampleIntervalUs = () => Math.max(200, Number(process.env.CPU_PROFILE_INTERVAL_US) || 5000)

let session = null
let activePhase = null
let startupAttempted = false
let startupStop = null
let diagnosticStop = null

// Codex · №12,410 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
// Same inspector owner as ordinary profiles; phase boundaries cannot cut this
// one-shot trace short. A blocked JS thread can delay the stop callback: report
// actual duration rather than claiming a hard real-time 120-second stop.
export function startDiagnosticProfile(onResult, { maxMs = 120_000 } = {}) {
  if (activePhase || typeof onResult !== 'function') return null
  let timer, stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    try {
      session.post('Profiler.stop', (error, result) => {
        diagnosticStop = null; activePhase = null
        try { onResult(error ? null : result?.profile || null) } catch { /* diagnostic sink */ }
      })
    } catch { diagnosticStop = null; activePhase = null; try { onResult(null) } catch { /* sink */ } }
  }
  try {
    if (!session) { session = new inspector.Session(); session.connect(); session.post('Profiler.enable') }
    session.post('Profiler.setSamplingInterval', { interval: 10_000 })
    session.post('Profiler.start')
    activePhase = 'operator-bounded'; diagnosticStop = stop
    timer = setTimeout(stop, Math.min(120_000, Math.max(1, Number(maxMs) || 120_000)))
    timer.unref?.()
    return stop
  } catch { diagnosticStop = null; activePhase = null; return null }
}

export function diagnosticProfileTimeline(profile) {
  if (!profile) return { available: false }
  const samples = profile.samples || [], deltas = profile.timeDeltas || []
  const windows = [], maxWindows = 120
  let elapsed = 0, bucket = null, omittedSamples = 0
  for (let i = 0; i < samples.length; i++) {
    const delta = deltas[i]
    if (!(delta > 0)) continue
    const second = Math.floor(elapsed / 1e6)
    elapsed += delta
    if (second >= maxWindows) { omittedSamples++; continue }
    if (!bucket || bucket.second !== second) { bucket = { second, samples: [], timeDeltas: [] }; windows.push(bucket) }
    bucket.samples.push(samples[i]); bucket.timeDeltas.push(delta)
  }
  return { available: true, sampleIntervalUs: 10_000, totalMs: elapsed / 1000, samples: samples.length,
    omittedSamples, windows: windows.map(b => ({ second: b.second,
      ...summarizeProfile({ nodes: profile.nodes, samples: b.samples, timeDeltas: b.timeDeltas }, { topN: 4 }) })) }
}

/**
 * Sample the entire first cycle, including phase handoff writes and independent
 * callbacks. Never re-arm in this process; stop on completion/error or after
 * 120s. A blocked thread can delay that timer, so this is a target duration,
 * not a claim that diagnostics can interrupt synchronous application work.
 * Recurring phase profiles resume after this owner releases the inspector.
 */
export function startStartupProfile(onResult, { maxMs = 120_000 } = {}) {
  if (startupAttempted) return () => {}
  startupAttempted = true
  if (activePhase || typeof onResult !== 'function') return () => {}
  let timer
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    startupStop = null
    stopPhaseProfile(onResult)
  }
  try {
    if (!session) {
      session = new inspector.Session()
      session.connect()
      session.post('Profiler.enable')
    }
    // Fixed 10ms sampling bounds the ordinary 120s trace to about 12k samples;
    // operator-selected high-frequency phase sampling cannot amplify this.
    session.post('Profiler.setSamplingInterval', { interval: 10_000 })
    session.post('Profiler.start')
    activePhase = 'startup-first-cycle'
    startupStop = stop
    const duration = Math.min(120_000, Math.max(1, Number(maxMs) || 120_000))
    timer = setTimeout(stop, duration)
    timer.unref?.()
    return stop
  } catch {
    activePhase = null
    startupStop = null
    return () => {}
  }
}

/** Which phases the operator asked to profile. Null (the default) = none. */
export function profileEnabledFor(key) {
  const raw = String(process.env.CPU_PROFILE_PHASES || '').trim()
  if (!raw) return false
  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean)
  return wanted.includes('*') || wanted.includes(key)
}

// Node's own frames and dependency frames are noise when the question is "which
// of OUR functions"; but they are the ANSWER when the burner is native (GC, a
// sync sqlite call, TLS). So keep them and just shorten the path.
function shortUrl(url) {
  if (!url) return ''
  const clean = String(url).replace(/^file:\/\//, '')
  const parts = clean.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

/**
 * Fold a raw .cpuprofile into "which frames actually held the thread".
 *
 * Self time only — inclusive time would put runLoop at 100% and say nothing.
 * timeDeltas[i] is the gap preceding samples[i]; attributing it to that sample
 * is the standard reading and is what makes the totals add up to wall time.
 */
export function summarizeProfile(profile, { phase = null, topN = 12 } = {}) {
  const nodes = profile?.nodes || []
  const samples = profile?.samples || []
  const deltas = profile?.timeDeltas || []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const parentOf = new Map()
  for (const node of nodes) {
    for (const child of node.children || []) parentOf.set(child, node.id)
  }

  // Native SQLite samples have names such as `all` or `run` but no URL.
  // Collapsing every call site under that name loses the query's owner.
  // Keep a bounded attribution to the nearest application frame, skipping
  // dependency wrappers. This contains code locations only, never SQL or args.
  const applicationCaller = id => {
    const seen = new Set([id])
    for (let depth = 0; depth < 32; depth++) {
      id = parentOf.get(id)
      if (id == null || seen.has(id)) break
      seen.add(id)
      const f = byId.get(id)?.callFrame
      if (!f?.url || f.url.includes('/node_modules/') || !f.url.includes('/agent/')
        || f.url.endsWith('/services/diagnostic-sql.js')) continue
      return `${f.functionName || '(anonymous)'} @ ${shortUrl(f.url)}:${(f.lineNumber ?? -1) + 1}`
    }
    return null
  }

  const selfUs = new Map()
  let totalUs = 0
  for (let i = 0; i < samples.length; i++) {
    const d = deltas[i]
    if (!(d > 0)) continue
    totalUs += d
    selfUs.set(samples[i], (selfUs.get(samples[i]) || 0) + d)
  }

  // Same function sampled under different call paths appears as several nodes;
  // merge them, otherwise a hot function hides as ten small ones.
  const byFrame = new Map()
  const callersByFrame = new Map()
  for (const [id, us] of selfUs) {
    const f = byId.get(id)?.callFrame
    if (!f) continue
    const where = shortUrl(f.url)
    const label = f.functionName || (where ? '(anonymous)' : '(unknown)')
    const key = where ? `${label} @ ${where}:${(f.lineNumber ?? -1) + 1}` : label
    byFrame.set(key, (byFrame.get(key) || 0) + us)
    // Idle/program/GC are runtime buckets, not work caused by the interrupted
    // caller. Do not relabel them as database or application execution.
    if (!where && !label.startsWith('(')) {
      const caller = applicationCaller(id)
      if (caller) {
        if (!callersByFrame.has(key)) callersByFrame.set(key, new Map())
        const callers = callersByFrame.get(key)
        callers.set(caller, (callers.get(caller) || 0) + us)
      }
    }
  }

  const ms = (us) => Math.round(us / 100) / 10
  const top = [...byFrame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, us]) => ({
      frame,
      selfMs: ms(us),
      pct: totalUs > 0 ? Math.round((us / totalUs) * 1000) / 10 : null,
      ...(callersByFrame.has(frame) ? { callers: [...callersByFrame.get(frame)]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([caller, callerUs]) => ({ frame: caller, selfMs: ms(callerUs) })) } : {}),
    }))

  // (idle) and (program) are V8's "not running JS" buckets. Splitting them out
  // keeps the headline honest: 90% idle means the phase waited, whatever the
  // top JS frame says.
  const bucket = (name) => ms(byFrame.get(name) || 0)
  return {
    phase,
    totalMs: ms(totalUs),
    samples: samples.length,
    idleMs: bucket('(idle)'),
    programMs: bucket('(program)'),
    gcMs: bucket('(garbage collector)'),
    top,
  }
}

/**
 * Begin profiling `key`, if the operator armed that phase. Returns true when a
 * profile actually started. Never throws — a diagnostic must not be able to
 * take the trading loop down.
 */
export function startPhaseProfile(key) {
  if (activePhase || !profileEnabledFor(key)) return false
  try {
    if (!session) {
      session = new inspector.Session()
      session.connect()
      session.post('Profiler.enable')
    }
    session.post('Profiler.setSamplingInterval', { interval: sampleIntervalUs() })
    session.post('Profiler.start')
    activePhase = key
    return true
  } catch {
    activePhase = null
    return false
  }
}

/**
 * Stop the running profile and hand the summary to `onResult`.
 *
 * Asynchronous by necessity (the inspector protocol is callback-based) while
 * every caller in loop.js's phase() is synchronous — hence a sink rather than a
 * return value. `onResult(null)` is never called: no profile means no call, so
 * a caller can persist unconditionally.
 */
export function stopPhaseProfile(onResult) {
  // Phase boundaries must not end the continuous first-cycle trace. Its own
  // once-only stop clears this guard before using the shared stop operation.
  if (startupStop || diagnosticStop) return false
  if (!activePhase || !session) return false
  const phase = activePhase
  activePhase = null
  try {
    session.post('Profiler.stop', (err, res) => {
      if (err || !res?.profile) return
      try { onResult(summarizeProfile(res.profile, { phase })) } catch { /* diagnostics are best-effort */ }
    })
    return true
  } catch {
    return false
  }
}

/** Test seam — tear the session down so a fresh one can be built. */
export function _resetForTests() {
  diagnosticStop?.()
  startupStop?.()
  try { session?.disconnect() } catch { /* already gone */ }
  session = null
  activePhase = null
  startupAttempted = false
}
