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
// Deliberately OPT-IN via CPU_PROFILE_PHASES (comma-separated phase keys, e.g.
// "monitor,autopilot"). Left off, this module does nothing at all: no inspector
// session, no sampling, no allocation. Diagnostics that are always on become
// part of the problem they are meant to explain.
import inspector from 'node:inspector'

// 5ms between samples. At the ~200s phases we are chasing that is ~40k samples,
// which is bounded memory, and still 10,000 samples inside a single 53s block —
// far more resolution than needed to name a hot frame.
const SAMPLE_INTERVAL_US = Math.max(200, Number(process.env.CPU_PROFILE_INTERVAL_US) || 5000)

let session = null
let activePhase = null

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
  for (const [id, us] of selfUs) {
    const f = byId.get(id)?.callFrame
    if (!f) continue
    const where = shortUrl(f.url)
    const label = f.functionName || (where ? '(anonymous)' : '(unknown)')
    const key = where ? `${label} @ ${where}:${(f.lineNumber ?? -1) + 1}` : label
    byFrame.set(key, (byFrame.get(key) || 0) + us)
  }

  const ms = (us) => Math.round(us / 100) / 10
  const top = [...byFrame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, us]) => ({
      frame,
      selfMs: ms(us),
      pct: totalUs > 0 ? Math.round((us / totalUs) * 1000) / 10 : null,
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
    session.post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US })
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
  try { session?.disconnect() } catch { /* already gone */ }
  session = null
  activePhase = null
}
