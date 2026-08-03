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

import { getState, setState } from '../db.js'
import { auditControllerEvent } from './phase-audit.js'

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
  // Answers "is every open position actually protected right now?" — the one
  // question no controller asked before 2026-07-29, when an ETHUSD short was
  // found to have closed with no stop loss at all while the ledger called it
  // "stopped beyond the SL". A stalled protection audit is itself dangerous:
  // it means nothing is checking, so it gets a heartbeat like everything else.
  protection_audit: { label: 'Position protection audit', tiedToLoop: true, factor: 3 },
  // D6 — the daily ATR baseline the volatility gate reads. If this stops
  // running, atr_history goes stale and every symbol quietly reads as NORMAL
  // volatility: a verdict none of them earned, and indistinguishable from a
  // real one. Daily cadence, generous grace — it is once per ~288 loops.
  atr_refresh: { label: 'ATR baseline refresh', expectedSec: 86_400, factor: 2 },
  // The check AFTER the risk gate decides (owner 2026-08-03). Answers "why
  // didn't it trade" from the DB every cycle. It is itself a controller, so a
  // stalled auditor is visible rather than being mistaken for a clean day —
  // an auditor that silently stops is the exact bug it was built to detect.
  decision_audit: { label: 'Post-decision audit', tiedToLoop: true, factor: 3 },
}

const FAIL_ALERT_AT = 3 // consecutive in-controller failures before alerting

function loopSecFrom(db) {
  const n = Number(getState(db, 'loop_interval_min'))
  return (Number.isFinite(n) && n >= 1 ? n : 5) * 60
}

/**
 * The loop's REAL period, which is not its configured interval.
 *
 * loop.js re-arms with `delay = max(10s, interval - elapsed)`, so the
 * interval is a FLOOR between cycles, not a period. When a cycle takes
 * longer than the interval — routine, since a cycle is dozens of broker
 * round-trips — the true period is `elapsed + 10s`, and the configured
 * number says nothing about it.
 *
 * Measured on production 02-08-2026: `loop_interval_min` was 1 (60s) while
 * cycles ran ~3.5 minutes, so EIGHT tiedToLoop controllers sat permanently
 * "stalled" — main_loop, burn_in, pending_orders, order_monitor,
 * trade_guards, profit_keeper, adaptive_breaker, autopilot — every one of
 * them with `consecutive_failures: 0` and a heartbeat 3 minutes old. A
 * watchdog that is always red cannot report a real stall, which is worse
 * than having no watchdog: the owner learns to ignore it, and the one time
 * it means something, it looks the same as the other 287 times that day.
 *
 * So the expectation follows what the loop can actually achieve: the larger
 * of the configured interval and the last observed cycle duration. `factor`
 * still supplies the grace on top, so a genuine hang trips it exactly as
 * before — a hang produces NO new `last_loop_ms` (loop.js writes it only
 * after a cycle completes, loop.js:3411), so the expectation stays at the
 * last healthy period while the age climbs past it.
 *
 * Capped at OBSERVED_LOOP_CEIL_SEC. Without a ceiling, one pathological
 * cycle — a broker timeout storm, a 40-minute reconcile — would raise the
 * expectation for every cycle after it, and at factor 3 that is hours of
 * deliberate blindness bought from a single outlier. The cap keeps the
 * worst case bounded: a cycle slower than the ceiling reads as stalled,
 * which is the correct verdict for a loop that slow.
 */
export const OBSERVED_LOOP_CEIL_SEC = 900 // 15 min; ×3 grace = 45 min blind at worst

function loopPeriodSecFrom(db, loopSec) {
  const lastMs = Number(getState(db, 'last_loop_ms'))
  if (!Number.isFinite(lastMs) || lastMs <= 0) return loopSec
  // +10s: loop.js's own minimum breather between cycles.
  const observedSec = Math.min(Math.ceil(lastMs / 1000) + 10, OBSERVED_LOOP_CEIL_SEC)
  return Math.max(loopSec, observedSec)
}

/**
 * The period every loop-tied expectation is measured against. Callers that
 * pass an explicit `loopSec` (tests, and anything wanting the configured
 * number) keep it verbatim; production passes nothing and gets the observed
 * period. Shared by the watchdog and the panel ON PURPOSE — a panel that
 * says "ok" while the alerter says "stalled" is its own bug.
 */
function effectiveLoopSec(db, loopSec) {
  return loopSec ?? loopPeriodSecFrom(db, loopSecFrom(db))
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

/**
 * When did this controller last SUCCEED, in epoch ms? 0 if never.
 *
 * Exists so a daily controller can schedule itself against its own durable
 * record instead of an in-memory tick counter. #170: `atr_refresh` was gated
 * on `loopCount % 288 === 11`, and `loopCount` is a module-level variable that
 * resets to 0 on every process start — so on a host that restarts more often
 * than ~55 minutes the daily sweep never fires at all. The heartbeat row is
 * already the answer to "when did this last work"; nothing new needs storing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {number} epoch ms, or 0 when the controller has never succeeded
 */
export function lastOkMs(db, name) {
  try {
    const row = db.prepare('SELECT last_ok_at FROM controller_heartbeats WHERE name = ?').get(name)
    const t = Date.parse(row?.last_ok_at || '')
    return Number.isFinite(t) ? t : 0
  } catch { return 0 }
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

// Durable trail: every stall/recovery/failure event also lands in action_log
// via auditControllerEvent, so "which controller was dead at HH:MM" is
// answerable later — Telegram alerts evaporate, rows do not.
export function checkHeartbeats(db, { now = new Date(), notify = null, loopSec = null, bootMs = null } = {}) {
  const lsec = effectiveLoopSec(db, loopSec)
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
      auditControllerEvent(db, { controller: row.name, event: 'stalled', detail: `last ran ${ageMin}m ago (expected ~${Math.round(expected / 60) || 1}m)` })
    } else if (age <= limit && row.stalled) {
      db.prepare('UPDATE controller_heartbeats SET stalled = 0 WHERE name = ?').run(row.name)
      if (inGrace) {
        events.push({ name: row.name, event: 'recovered_silent' })
        continue
      }
      say(`🔵 CONTROLLER RECOVERED: ${def.label} is beating again.`)
      events.push({ name: row.name, event: 'recovered' })
      auditControllerEvent(db, { controller: row.name, event: 'recovered' })
    }

    if (row.consecutive_failures >= FAIL_ALERT_AT && !row.fail_alerted) {
      db.prepare('UPDATE controller_heartbeats SET fail_alerted = 1 WHERE name = ?').run(row.name)
      say(`🔴 CONTROLLER FAILING: ${def.label} has failed ${row.consecutive_failures}× in a row — last error: ${row.last_error || 'unknown'}`)
      events.push({ name: row.name, event: 'failing', failures: row.consecutive_failures })
      auditControllerEvent(db, { controller: row.name, event: 'failing', detail: `${row.consecutive_failures}x in a row — last error: ${row.last_error || 'unknown'}` })
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
  const lsec = effectiveLoopSec(db, loopSec)
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
 * Does the sidecar's authorised-account roster still match the registry's?
 *
 * WHY THIS EXISTS (2026-07-30). The owner disabled account 46979908 in the
 * registry. Node correctly stopped dispatching to it — and the sidecar went on
 * reporting it as authorised, through two full loop cycles. Neither half was
 * broken:
 *
 *   · `ensureSidecarSession` DOES include the roster in its memo key
 *     (exec-engine.js:112), so a shrunk roster is a new key.
 *   · the sidecar DOES rebuild its roster from scratch on /connect
 *     (cpp-exec/src/engine.cpp:95 clears accountIds_ before refilling).
 *
 * The gap is that nothing CALLS the push. ensureSidecarSession runs only on
 * exec paths — order, amend, close, cancel, reconcile — so with autotrade off
 * and no orders flowing, a roster change is never communicated. "Disabled"
 * then means "not dispatched" while the sidecar retains live authorisation to
 * trade that account, and those are not the same thing. This probe already runs
 * every ~30s, so it is the right place to notice.
 *
 * Set comparison, not array equality: order and duplicates are not meaningful,
 * and ids arrive as numbers from the sidecar and strings from the registry.
 *
 * @param {Array<string|number>|null|undefined} sidecarAccounts  from GET /health
 * @param {Array<string|number>|null|undefined} credsAccountIds  from getCtraderCreds
 * @returns {{drifted: boolean, extra: string[], missing: string[]}}
 *   `extra` = authorised at the sidecar but NOT enabled in the registry — the
 *   direction that matters, because it is authorisation the owner revoked.
 */
export function rosterDrift(sidecarAccounts, credsAccountIds) {
  const norm = (a) => new Set((Array.isArray(a) ? a : []).map(x => String(x)).filter(Boolean))
  // AN UNREPORTED ROSTER IS UNKNOWN, NOT EMPTY — the same rule already applied
  // to the creds side below, and its absence here cost real behaviour. While
  // pingSidecar was dropping `accounts` (see exec-engine.js), `undefined`
  // normalised to the empty set, so `missing` was the entire registry and drift
  // was true on EVERY probe: an unconditional re-push dressed up as a check,
  // with the revoked-authorisation direction dead. `[]` is different and still
  // counts as drift — the sidecar saying "I hold nothing" is real information.
  if (sidecarAccounts == null) return { drifted: false, extra: [], missing: [], unknown: true }
  const have = norm(sidecarAccounts)
  const want = norm(credsAccountIds)
  // Nothing to compare against — a creds roster we could not build must never
  // be read as "the sidecar should have no accounts".
  if (want.size === 0) return { drifted: false, extra: [], missing: [] }
  const extra = [...have].filter(id => !want.has(id)).sort()
  const missing = [...want].filter(id => !have.has(id)).sort()
  return { drifted: extra.length > 0 || missing.length > 0, extra, missing }
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
    // 02-08 incident: the sidecar sat "reconnecting" for 22 HOURS with
    // hasCredentials:true — it was retrying with a STALE access token. Node
    // had rotated the OAuth token since (maybeRefreshCtraderToken, ~daily)
    // but nothing re-pushed it: order paths were idle all weekend and this
    // branch only fired on missing credentials. A stale token is exactly as
    // dead as no token, so re-push fresh creds in BOTH cases — pushing the
    // token the sidecar already holds is one cheap /connect no-op, pushing a
    // rotated one revives the session within a probe interval.
    try {
      const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
      const pushed = exec.pushSidecarSession ? await exec.pushSidecarSession(getCtraderCreds(db)) : false
      if (pushed) error += ' — credentials re-pushed, session should return shortly'
    } catch { /* creds not ready or sidecar went away — next probe retries */ }
  } else if (ok && r.connected === true) {
    // Connected — now check the roster actually matches what is ENABLED.
    // Re-pushed rather than merely reported: leaving the sidecar authorised for
    // an account the owner disabled is the kind of divergence that only shows
    // up when something trades on it.
    try {
      const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
      const creds = getCtraderCreds(db)
      const drift = rosterDrift(r.accounts, creds.accountIds)
      // No `creds.ready` check here on purpose: pushSidecarSession already
      // returns false for not-ready creds and pushes nothing, so duplicating
      // that policy would just give it two places to drift out of step. Same
      // shape as the credential-less self-heal path above.
      if (drift.drifted && exec.pushSidecarSession) {
        const pushed = await exec.pushSidecarSession(creds)
        if (pushed) {
          console.warn(
            `[heartbeat] cpp roster drift corrected — sidecar had ${JSON.stringify(r.accounts)}, ` +
            `registry enables ${JSON.stringify(creds.accountIds)}` +
            (drift.extra.length ? ` (revoked: ${drift.extra.join(', ')})` : '') +
            (drift.missing.length ? ` (added: ${drift.missing.join(', ')})` : ''))
        }
      }
    } catch { /* creds not ready or sidecar went away — next probe retries */ }
  }
  if (ok && r.connected === true && r.lastReconcileAt == null) {
    ok = false
    error = 'connected but no reconcile pass has completed yet'
  } else if (ok && r.lastReconcileAt != null && nowMs - Number(r.lastReconcileAt) > STALE_RECONCILE_MS) {
    ok = false
    error = `last reconcile ${Math.round((nowMs - Number(r.lastReconcileAt)) / 60_000)}m ago — engine loop looks stalled`
  }
  beat(db, 'cpp_exec', { ok, error, ...(deps.now ? { now: deps.now } : {}) })
  // Persist what the probe learned so a READ route never has to call the
  // sidecar itself. This probe already runs every ~2 minutes; making
  // /state/account-engineering re-fetch /health on every page load would put an
  // external HTTP hop inside a cached GET, which is exactly the shape of the
  // slow read routes already on the backlog. Stamped with the observation time
  // so the UI can say "as of 2 min ago" instead of implying it is live.
  try {
    setState(db, 'cpp_exec_health_json', JSON.stringify({
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : null,
      connected: r.connected ?? null,
      hasCredentials: r.hasCredentials ?? null,
      lastReconcileAt: r.lastReconcileAt ?? null,
      ok,
      error: error || null,
      at: new Date(nowMs).toISOString(),
    }))
  } catch { /* status reporting must never break the probe */ }
  return { ...r, ok, ...(error ? { error } : {}) }
}
