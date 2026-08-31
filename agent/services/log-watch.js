// ---------------------------------------------------------------------------
// log-watch — real-time push on named log conditions, in-process.
//
// Owner order 01-09-2026 ("yes build the log-watch hook"), after three
// external candidates (a Railway dashboard, a GraphQL skill wrapper, a
// Loki/Grafana drain stack) all reduced to the same observation: this process
// already sees every log line it emits, so a matcher here plus the existing
// Telegram wiring gives push alerting with zero new services, zero new
// credentials, zero third-party code.
//
// Design constraints, each earned the hard way in this repo:
//
//   - RULES is a data table and the test iterates it (log-inspector.js
//     precedent): a rule nobody exercises is decoration (failure mode #3).
//   - The console wrap calls the ORIGINAL first and scans after, inside a
//     re-entrancy latch — notify() may itself log, and an alert that
//     re-triggers its own rule is an outbox that never drains.
//   - Every rule has a cooldown. An alert channel that repeats itself at log
//     frequency trains the owner to ignore it, which is worse than silence.
//   - scan() never throws. A monitoring hook that can crash the process it
//     monitors has inverted its own purpose.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const LOG_WATCH_DEFAULTS = {
  on: true,
  errorBurstN: 10,        // level-error lines within the window that make a burst
  errorBurstWindowMin: 5, // rolling window the burst is counted over
  cooldownMin: 30,        // default per-rule notify cooldown
}

/** Config from agent_state 'log_watch_json'; junk degrades to defaults. */
export function loadLogWatch(db) {
  try {
    const p = JSON.parse(getState(db, 'log_watch_json') || 'null')
    if (p && typeof p === 'object') {
      const num = (v, dflt, lo, hi) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
      }
      return {
        on: p.on !== false,
        errorBurstN: Math.round(num(p.errorBurstN, LOG_WATCH_DEFAULTS.errorBurstN, 2, 500)),
        errorBurstWindowMin: Math.round(num(p.errorBurstWindowMin, LOG_WATCH_DEFAULTS.errorBurstWindowMin, 1, 120)),
        cooldownMin: Math.round(num(p.cooldownMin, LOG_WATCH_DEFAULTS.cooldownMin, 1, 1440)),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...LOG_WATCH_DEFAULTS }
}

// Named conditions. `match` runs against one formatted line; `message` builds
// the alert from the match. `cooldownMin` overrides the config default where a
// condition's natural repeat rate differs (an admit is rare and precious; a
// stall repeating every probe is one fact, not thirty).
export const RULES = [
  {
    key: 'earned_floor_admit',
    match: (line) => /\[risk\] earned_floor admit:/.test(line),
    cooldownMin: 60,
    message: (line) =>
      `🎯 Earned-floor ADMIT — a below-3R proposal passed on its strategy's measured record.\n${line.slice(0, 300)}`,
  },
  {
    key: 'controller_stalled',
    match: (line) => /\[phase-audit\] controller \S+: stalled/.test(line),
    cooldownMin: 60,
    message: (line) => `🫀 Controller stalled.\n${line.slice(0, 300)}`,
  },
  {
    key: 'sidecar_restart',
    match: (line) => /\[heartbeat\] sidecar_restart:/.test(line),
    cooldownMin: 30,
    message: (line) => `♻️ Sidecar restarted (new bootId — in-memory counters zeroed).\n${line.slice(0, 300)}`,
  },
]

/**
 * Install the watch: wrap console.log/warn/error so every formatted line is
 * scanned after being emitted. Returns handles for tests ({ scan, uninstall,
 * _state }). Idempotent per process via the marker on console.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{notify: (text: string) => Promise<any>, now?: () => number}} deps
 */
let _installedState = null // latest install, for logWatchView
let _activeScan = null     // latest install's scan — the console wrap routes here,
                           // so a re-install (tests, hot paths) swaps the matcher
                           // without re-wrapping console

export function installLogWatch(db, { notify, now = Date.now } = {}) {
  const state = {
    firedAt: new Map(),   // rule key → last notify ms
    errorAt: [],          // rolling timestamps of level-error lines
    scanning: false,      // re-entrancy latch
  }

  const fire = (key, text, cooldownMin) => {
    const cfg = loadLogWatch(db)
    if (!cfg.on) return
    const cd = (cooldownMin ?? cfg.cooldownMin) * 60_000
    // A never-fired rule always fires — defaulting `last` to 0 would let a
    // small clock (tests; or a host with a weird epoch) suppress the FIRST
    // alert, which is the one the rule exists for.
    const last = state.firedAt.get(key)
    if (last != null && now() - last < cd) return
    state.firedAt.set(key, now())
    // Fire-and-forget: an alert failure must never block or crash the logger.
    Promise.resolve()
      .then(() => notify(text))
      .catch(() => {})
  }

  const scan = (line, level) => {
    if (state.scanning) return
    state.scanning = true
    try {
      for (const r of RULES) {
        if (r.match(line)) fire(r.key, r.message(line), r.cooldownMin)
      }
      if (level === 'error') {
        const cfg = loadLogWatch(db)
        const cutoff = now() - cfg.errorBurstWindowMin * 60_000
        state.errorAt.push(now())
        while (state.errorAt.length && state.errorAt[0] < cutoff) state.errorAt.shift()
        if (state.errorAt.length >= cfg.errorBurstN) {
          fire(
            'error_burst',
            `🚨 Error burst: ${state.errorAt.length} error-level log lines in ${cfg.errorBurstWindowMin} min. Latest:\n${line.slice(0, 300)}`,
          )
        }
      }
    } catch { /* never throws into the logger */ }
    state.scanning = false
  }

  _installedState = state
  _activeScan = scan
  if (!console.__logWatchInstalled) {
    _originals = { log: console.log, warn: console.warn, error: console.error }
    const wrap = (level) => (...args) => {
      _originals[level](...args)
      try {
        if (_activeScan) _activeScan(args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' '), level)
      } catch { /* ditto */ }
    }
    console.log = wrap('log')
    console.warn = wrap('warn')
    console.error = wrap('error')
    console.__logWatchInstalled = true
  }
  return { scan, uninstall: uninstallLogWatch, _state: state }
}

let _originals = null

/** Restore the unwrapped console (idempotent — tests, or emergency revert). */
export function uninstallLogWatch() {
  if (_originals) {
    console.log = _originals.log
    console.warn = _originals.warn
    console.error = _originals.error
    _originals = null
  }
  delete console.__logWatchInstalled
  _activeScan = null
}

/** Guard-inspects-itself view for /state/log-watch: config, rules, what fired. */
export function logWatchView(db) {
  const fired = {}
  if (_installedState) {
    for (const [k, ms] of _installedState.firedAt) fired[k] = new Date(ms).toISOString()
  }
  return {
    config: loadLogWatch(db),
    installed: console.__logWatchInstalled === true,
    rules: [...RULES.map((r) => r.key), 'error_burst'],
    fired, // empty until a rule notifies — "has this input ever arrived" is readable, not assumed
    errorsInWindow: _installedState ? _installedState.errorAt.length : 0,
  }
}

function safeString(v) {
  try {
    if (v instanceof Error) return v.message
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return '[unserializable]'
  }
}
