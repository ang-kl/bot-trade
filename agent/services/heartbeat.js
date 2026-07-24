// ---------------------------------------------------------------------------
// agent/services/heartbeat.js — controller heartbeats + stall watchdog.
//
// Owner (2026-07-17): "Build the controller-heartbeat monitor to reliability."
// Every background controller (JS agents) and the C++ exec engine records a
// beat each time it runs; a watchdog on the INDEPENDENT 30s fast-monitor
// ticker flags anything that stops beating — so a silently dead main loop is
// detected and alerted, not discovered days later from an unmanaged position.
//
// Semantics: a beat means "the controller's code executed" (even if it
// decided to do nothing). A controller that has NEVER beaten shows as idle,
// not stalled — burn-in on a box that never armed it isn't an incident.
// Stall = last beat older than expected interval × grace factor. Alerts fire
// once per stall (and once on recovery); repeated in-controller failures
// (consecutive_failures ≥ 3) alert once per failure streak.
//
// The C++ engine ("the agents" in the owner's words) is covered by an active
// probe: the sidecar's GET /health is polled from the ticker when
// EXEC_ENGINE=cpp, and the result is recorded as the cpp_exec heartbeat.
// Honest limit: if the WHOLE Node process dies, nothing here runs — that is
// Railway's restart/healthcheck domain, documented in CPP-ROADMAP.md.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

// Registry: every watched controller. `tiedToLoop` controllers run once per
// main-loop cycle, so their expected interval follows loop_interval_min.
// `loopMultiplier` covers a controller tied to every Nth loop rather than
// every loop (weekend_bank runs inside loop.js's reconcile phase, gated
// `loopCount % 3 === 0` — without this its expected interval was computed as
// a single loop, so a normal ~15min cadence with one slightly-long cycle
// tripped a false STALLED before the real interval was ever exceeded).
// `factor` is the grace multiplier before a missing beat counts as a stall.
export const CONTROLLERS = {
  main_loop:        { label: 'Main loop',              tiedToLoop: true,  factor: 3 },
  fast_monitor:     { label: 'Fast position monitor',  expectedSec: 30,   factor: 10 },
  burn_in:          { label: 'Burn-in engine',         tiedToLoop: true,  factor: 3 },
  pending_orders:   { label: 'Pending-order manager',  tiedToLoop: true,  factor: 3 },
  order_monitor:    { label: 'Order-fill monitor',     tiedToLoop: true,  factor: 3 },
  trade_guards:     { label: 'Trade guards',           tiedToLoop: true,  factor: 3 },
  profit_keeper:    { label: 'Profit keeper',          tiedToLoop: true,  factor: 3 },
  adaptive_breaker: { label: 'Adaptive breaker',       tiedToLoop: true,  factor: 3 },
  autopilot:        { label: 'Strategy autopilot',     tiedToLoop: true,  factor: 3 },
  hours_refresh:    { label: 'Market-hours refresh',   expectedSec: 86_400, factor: 2 },
  weekend_bank:     { label: 'Weekend profit bank',    tiedToLoop: true, loopMultiplier: 3, factor: 4 },
  weekend_loss_flag: { label: 'Weekend loss flag',     tiedToLoop: true, loopMultiplier: 3, factor: 4 },
  guardian:         { label: 'Tick guardian',          expectedSec: 30,   factor: 10 },
  cpp_exec:         { label: 'C++ exec engine',        expectedSec: 120,  factor: 3 },
}

const FAIL_ALERT_AT = 3 // consecutive in-controller failures before alerting

function loopSecFrom(db) {
  const n = Number(getState(db, 'loop_interval_min'))
  return (Number.isFinite(n) && n >= 1 ? n : 5) * 60
}

function expectedSecFor(def, loopSec) {
  return def.tiedToLoop ? loopSec * (def.loopMultiplier || 1) : def.expectedSec
}

/** Record one controller run. ok=false increments the failure streak. */
export function beat(db, name, { ok = true, error = null, now = new Date() } = {}) {
  const ts = now.toISOString()
  const okInt = ok ? 1 : 0
  const errText = ok ? null : String(error || 'unknown error').slice(0, 500)
  db.prepare(
    `INSERT INTO controller_heartbeats
       (name, last_run_at, last_ok_at, last_error, consecutive_failures, runs, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_ok_at = CASE WHEN ? = 1 THEN excluded.last_run_at ELSE last_ok_at END,
       last_error = CASE WHEN ? = 1 THEN last_error ELSE excluded.last_error END,
       consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
       runs = runs + 1,
       updated_at = excluded.updated_at`
  ).run(name, ts, ok ? ts : null, errText, ok ? 0 : 1, ts, okInt, okInt, okInt)
}

function ageSecOf(row, now) {
  const t = Date.parse(row.last_run_at || '')
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now.getTime() - t) / 1000)
}

/**
 * Watchdog pass: flag stalls (beat too old), alert once per stall and once on
 * recovery; alert once per failure streak at FAIL_ALERT_AT. Runs from the
 * fast-monitor ticker so it survives a dead main loop. Returns the events it
 * raised (tests assert on these).
 */
// Deploy grace window (owner 2026-07-24: every merge → Railway restart →
// a burst of STALLED/RECOVERED pairs; "these are common?"). For the first
// GRACE_SEC after process boot the watchdog stays quiet: stalls caused by
// the rebuild gap are expected, recoveries clear silently, and ONE
// "service restarted" notice replaces the flood. Real stalls that persist
// past the grace window alert exactly as before.
export const BOOT_GRACE_SEC = 300
let bootAtMs = Date.now()
let restartNoticeSent = false
export function _resetBootStateForTests(ms = Date.now()) { bootAtMs = ms; restartNoticeSent = false }

export function checkHeartbeats(db, { now = new Date(), notify = null, loopSec = null, bootMs = null } = {}) {
  const lsec = loopSec ?? loopSecFrom(db)
  const say = (text) => { try { notify?.(text) } catch { /* alerting must never throw */ } }
  const events = []
  const rows = db.prepare('SELECT * FROM controller_heartbeats').all()
  // Negative elapsed (injected past `now` in tests, or clock skew) is NOT
  // grace — grace only covers the real minutes right after this boot.
  const bootElapsedSec = (now.getTime() - (bootMs ?? bootAtMs)) / 1000
  const inGrace = bootElapsedSec >= 0 && bootElapsedSec < BOOT_GRACE_SEC
  for (const row of rows) {
    const def = CONTROLLERS[row.name]
    if (!def) continue
    const expected = expectedSecFor(def, lsec)
    const limit = expected * def.factor
    const age = ageSecOf(row, now)

    if (age > limit && !row.stalled) {
      if (inGrace) {
        // Deploy gap — expected. One consolidated notice instead of a
        // per-controller flood; the stalled flag stays clear so the later
        // recovery is silent too. A stall persisting past the grace window
        // trips the normal alert on a later pass.
        if (!restartNoticeSent) {
          restartNoticeSent = true
          say(`♻️ Service restarted (deploy) — controllers resuming. Stall alerts paused for the first ${Math.round(BOOT_GRACE_SEC / 60)} minutes; anything still stalled after that will alert.`)
          events.push({ name: row.name, event: 'restart_notice' })
        }
        continue
      }
      db.prepare('UPDATE controller_heartbeats SET stalled = 1 WHERE name = ?').run(row.name)
      const ageMin = Math.round(age / 60)
      say(`🔴 CONTROLLER STALLED: ${def.label} last ran ${ageMin}m ago (expected every ~${Math.round(expected / 60) || 1}m). Positions may be unmanaged — check the Railway service.`)
      events.push({ name: row.name, event: 'stalled', ageSec: Math.round(age) })
    } else if (age <= limit && row.stalled) {
      db.prepare('UPDATE controller_heartbeats SET stalled = 0 WHERE name = ?').run(row.name)
      if (inGrace) {
        events.push({ name: row.name, event: 'recovered_silent' })
        continue
      }
      say(`🔵 CONTROLLER RECOVERED: ${def.label} is beating again.`)
      events.push({ name: row.name, event: 'recovered' })
    }

    if (row.consecutive_failures >= FAIL_ALERT_AT && !row.fail_alerted) {
      db.prepare('UPDATE controller_heartbeats SET fail_alerted = 1 WHERE name = ?').run(row.name)
      say(`🔴 CONTROLLER FAILING: ${def.label} has failed ${row.consecutive_failures}× in a row — last error: ${row.last_error || 'unknown'}`)
      events.push({ name: row.name, event: 'failing', failures: row.consecutive_failures })
    } else if (row.consecutive_failures === 0 && row.fail_alerted) {
      db.prepare('UPDATE controller_heartbeats SET fail_alerted = 0 WHERE name = ?').run(row.name)
      say(`🔵 CONTROLLER RECOVERED: ${def.label} succeeded after a failure streak.`)
      events.push({ name: row.name, event: 'failure_recovered' })
    }
  }
  return events
}

/**
 * Full status view for /state/heartbeats and the Desk panel. Includes every
 * registered controller, even ones that have never beaten (status 'idle').
 */
export function heartbeatView(db, { now = new Date(), loopSec = null } = {}) {
  const lsec = loopSec ?? loopSecFrom(db)
  const byName = {}
  for (const row of db.prepare('SELECT * FROM controller_heartbeats').all()) byName[row.name] = row
  return Object.entries(CONTROLLERS).map(([name, def]) => {
    const row = byName[name]
    const expected = expectedSecFor(def, lsec)
    if (!row) {
      return { name, label: def.label, status: 'idle', expected_sec: expected, runs: 0 }
    }
    const age = ageSecOf(row, now)
    const status = age > expected * def.factor
      ? 'stalled'
      : row.consecutive_failures >= FAIL_ALERT_AT
        ? 'error'
        : row.consecutive_failures > 0 ? 'warn' : 'ok'
    return {
      name,
      label: def.label,
      status,
      expected_sec: expected,
      age_sec: Number.isFinite(age) ? Math.round(age) : null,
      last_run_at: row.last_run_at,
      last_ok_at: row.last_ok_at,
      last_error: row.last_error,
      consecutive_failures: row.consecutive_failures,
      runs: row.runs,
    }
  })
}

/**
 * Active liveness probe of the C++ exec engine: polls the sidecar's
 * GET /health and records the result as the cpp_exec heartbeat. No-op (and
 * no cpp_exec row → 'idle') when EXEC_ENGINE isn't cpp.
 */
export async function probeCppExec(db, deps = {}) {
  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  if (exec.execEngineMode() !== 'cpp') return null
  const r = await exec.pingSidecar()
  // The sidecar's GET /health says ok:true whenever its HTTP server answers
  // — even while the broker WS behind it has never connected or completed a
  // reconcile pass. Owner saw exactly that lie: "C++ exec engine" beating
  // steadily on the Controllers panel while pending-order-manager racked up
  // 14 straight "no reconcile data yet" failures. Health here means "the
  // ENGINE is doing its job", so the broker-session fields /health already
  // reports are now part of the verdict, with the real cause as the error.
  const nowMs = (deps.now ?? new Date()).getTime()
  const STALE_RECONCILE_MS = 5 * 60_000 // engine loop reconciles ~every 30s; 5m of silence is a stall
  let ok = r.ok === true
  let error = ok ? null : (r.error || 'health check failed')
  if (ok && r.connected === false) {
    ok = false
    error = r.hasCredentials === false
      ? 'broker session down — no credentials pushed to the sidecar yet'
      : 'broker session down — sidecar is reconnecting to cTrader'
    // M4 self-heal: a live sidecar with NO credentials means it restarted
    // and lost them while the agent (and its push memo) kept running —
    // nothing else would ever re-push, because ensureSidecarSession
    // memoizes on the unchanged (host, roster, token) key. Re-push here so
    // the broker session returns within one probe interval (~30s) instead
    // of waiting for the next agent redeploy. Best-effort: a failed push
    // keeps the heartbeat red and retries on the next probe.
    if (r.hasCredentials === false) {
      try {
        const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
        const pushed = exec.pushSidecarSession ? await exec.pushSidecarSession(getCtraderCreds(db)) : false
        if (pushed) error += ' — credentials re-pushed, session should return shortly'
      } catch { /* creds not ready or sidecar went away — next probe retries */ }
    }
  } else if (ok && r.connected === true && r.lastReconcileAt == null) {
    ok = false
    error = 'connected but no reconcile pass has completed yet'
  } else if (ok && r.lastReconcileAt != null && nowMs - Number(r.lastReconcileAt) > STALE_RECONCILE_MS) {
    ok = false
    error = `last reconcile ${Math.round((nowMs - Number(r.lastReconcileAt)) / 60_000)}m ago — engine loop looks stalled`
  }
  beat(db, 'cpp_exec', { ok, error, ...(deps.now ? { now: deps.now } : {}) })
  return { ...r, ok, ...(error ? { error } : {}) }
}
