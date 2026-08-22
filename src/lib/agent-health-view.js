// Presentation logic for the agent health panel. Separate from the component
// so the readings — which are the substance — are testable without a DOM.

/** Worst-first, so a list of these can be reduced with a plain index compare. */
export const SEVERITY = ['error', 'warn', 'ok', 'unknown']

export const CONTROLLER_TONE = {
  stalled: 'down',
  error: 'down',
  warn: 'warning',
  ok: 'on',
  idle: 'neutral',
}

export function worst(a, b) {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b
}

/**
 * Is the browser running the same build as the agent?
 *
 * THE POINT OF THE WHOLE PANEL. The sidebar has always shown a version, and a
 * version on its own answers nothing: the interesting question is whether the
 * two halves AGREE. A stale browser bundle and an agent that failed to
 * redeploy look identical from the UI — both show "the number I expected" on
 * one side and are wrong on the other.
 *
 * `unknown` is a real answer and is not dressed up as agreement: the agent
 * reports a commit only when Railway injects one (RAILWAY_GIT_COMMIT_SHA), so
 * a local or self-hosted agent legitimately has none, and claiming a match
 * there would be an invention.
 */
export function deployReading({ uiVersion, uiCommit, agentVersion, agentCommit }) {
  const ui = short(uiCommit)
  const ag = short(agentCommit)
  if (!ag) {
    return {
      state: 'unknown',
      text: 'The agent does not report a build commit, so UI and agent versions cannot be compared.',
    }
  }
  if (!ui) {
    return { state: 'unknown', text: 'This UI build carries no commit, so the two cannot be compared.' }
  }
  if (ui === ag) {
    return { state: 'ok', text: `UI and agent are on the same build (${ui}).` }
  }
  return {
    state: 'warn',
    text: `UI is on ${ui}${uiVersion ? ` (v${uiVersion})` : ''} but the agent is on ${ag}`
      + `${agentVersion ? ` (v${agentVersion})` : ''}. Either this browser is holding a stale bundle`
      + ' — a hard reload settles that — or the agent has not finished redeploying.',
  }
}

const short = (c) => (c ? String(c).slice(0, 7) : null)

/**
 * Roll the controller list up to one state plus the rows worth naming.
 *
 * `stalled` is folded into `error` for the ROLLUP but kept verbatim on the
 * row: they need the same attention and a two-word vocabulary in a summary
 * dot would be noise, while the row is where the distinction is actionable.
 */
export function controllerReading(controllers) {
  const rows = Array.isArray(controllers) ? controllers : []
  if (rows.length === 0) return { state: 'unknown', counts: {}, bad: [], total: 0 }
  const counts = {}
  const bad = []
  let state = 'ok'
  for (const c of rows) {
    counts[c.status] = (counts[c.status] || 0) + 1
    if (c.status === 'stalled' || c.status === 'error') { state = worst(state, 'error'); bad.push(c) }
    else if (c.status === 'warn') { state = worst(state, 'warn'); bad.push(c) }
  }
  // Worst first, then the most overdue.
  const rank = { stalled: 0, error: 1, warn: 2 }
  bad.sort((a, b) => (rank[a.status] - rank[b.status]) || overdue(b) - overdue(a))
  return { state, counts, bad, total: rows.length }
}

/** How many seconds past its expected cadence a controller is (0 if inside). */
export function overdue(c) {
  const age = Number(c?.age_sec)
  const exp = Number(c?.expected_sec)
  if (!Number.isFinite(age) || !Number.isFinite(exp) || exp <= 0) return 0
  return Math.max(0, Math.round(age - exp))
}

/** Compact duration for cadences and ages: 45s, 12m, 3h, 2d. */
export function dur(sec) {
  // Number(null) is 0, not NaN — so a missing age would have rendered as "0s",
  // i.e. "ran just now", which is the opposite of what a null means here.
  if (sec == null || sec === '') return '—'
  const s = Number(sec)
  if (!Number.isFinite(s) || s < 0) return '—'
  if (s < 90) return `${Math.round(s)}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

/**
 * The loop's own state. A loop that is mid-cycle is NOT a problem, however
 * long the cycle has run, until it passes the watchdog deadline — cycles
 * legitimately take minutes. Below that deadline this reports the phase and
 * says nothing alarming.
 */
export function loopReading(health, nowMs = Date.now()) {
  if (!health) return { state: 'unknown', text: 'No answer from the agent.' }
  if (health.status && health.status !== 'ok') {
    return { state: 'error', text: `Agent status: ${health.status}.` }
  }
  const startedMs = health.loopStartedAt ? Date.parse(String(health.loopStartedAt).replace(' ', 'T')) : NaN
  const watchdogMin = Number(health.watchdogMinutes)
  const phase = health.loopPhase || 'idle'
  if (Number.isFinite(startedMs) && Number.isFinite(watchdogMin) && watchdogMin > 0) {
    const runningMin = (nowMs - startedMs) / 60_000
    if (runningMin > watchdogMin) {
      return {
        state: 'error',
        text: `The current cycle has been in "${phase}" for ${Math.round(runningMin)}m, past the ${watchdogMin}m watchdog deadline.`,
      }
    }
    return { state: 'ok', text: `Cycle ${health.loopCount ?? '—'} · phase "${phase}" · ${Math.round(runningMin)}m into this cycle.` }
  }
  return { state: 'ok', text: `Cycle ${health.loopCount ?? '—'} · phase "${phase}".` }
}

/** Copy-to-clipboard form. */
export function toText({ health, controllers, deploy, loop, atr }) {
  const ctl = controllerReading(controllers)
  return [
    'Agent health',
    `deploy: ${deploy.state} — ${deploy.text}`,
    `loop: ${loop.state} — ${loop.text}`,
    `uptime ${health?.uptime != null ? dur(health.uptime) : '—'} · last cycle ${health?.lastLoopMs ? `${Math.round(health.lastLoopMs / 1000)}s` : '—'}`,
    `controllers: ${ctl.total} total — ${Object.entries(ctl.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    ...ctl.bad.map(c => `    ${c.status}: ${c.label || c.name} · last run ${c.age_sec != null ? dur(c.age_sec) : '—'} ago, expected every ${dur(c.expected_sec)}${c.last_error ? (c.error_is_current === false ? ` · last error (resolved): ${c.last_error}` : ` · ${c.last_error}`) : ''}`),
    atr ? `atr refresh: ${JSON.stringify(atr)}` : 'atr refresh: no record',
    health?.errorsToday ? `errors today: ${health.errorsToday}` : 'errors today: 0',
    health?.lastError ? `last error: ${health.lastError}` : '',
  ].filter(Boolean).join('\n')
}
