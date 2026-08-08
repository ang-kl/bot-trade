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
import { checkProtectionFreshness, protectionFreshnessFrom } from './protection-freshness.js'

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
  // MOVED OFF THE LOOP (2026-08-04, Operating Goal Plan §70.7). Both of these
  // move stops and close positions, and both used to run inside the 5-minute
  // cycle — so a long scan stopped break-even moves, trailing and profit locks
  // at exactly the moment a fast market makes them matter. They now run in the
  // fast monitor's 60s band, and their expectation is a FIXED 60s rather than
  // "one loop": a threshold derived from observed loop cadence stretches as
  // the loop degrades, so the alarm quietly follows the failure it exists to
  // catch. Grace of 4 covers a budgeted pass that abandons its wait.
  trade_guards:     { label: 'Trade guards',           expectedSec: 60,   factor: 4 },
  profit_keeper:    { label: 'Profit keeper',          expectedSec: 60,   factor: 4 },
  adaptive_breaker: { label: 'Adaptive breaker',       tiedToLoop: true,  factor: 3 },
  autopilot:        { label: 'Strategy autopilot',     tiedToLoop: true,  factor: 3 },
  hours_refresh:    { label: 'Market-hours refresh',   expectedSec: 86_400, factor: 2 },
  weekend_bank:     { label: 'Weekend profit bank',    tiedToLoop: true, loopMultiplier: 3, factor: 4 },
  weekend_loss_flag: { label: 'Weekend loss flag',     tiedToLoop: true, loopMultiplier: 3, factor: 4 },
  guardian:         { label: 'Tick guardian',          expectedSec: 30,   factor: 10 },
  cpp_exec:         { label: 'C++ exec engine',        expectedSec: 120,  factor: 3 },
  // Two-sidecar Phase 2. Safe to declare unconditionally: rows are created by
  // beat(), and checkHeartbeats skips a name with no row — so with one sidecar
  // configured this never appears, rather than reading as a STALLED controller
  // that does not exist.
  cpp_exec_demo:    { label: 'C++ exec engine (demo)', expectedSec: 120,  factor: 3 },
  // Answers "is every open position actually protected right now?" — the one
  // question no controller asked before 2026-07-29, when an ETHUSD short was
  // found to have closed with no stop loss at all while the ledger called it
  // "stopped beyond the SL". A stalled protection audit is itself dangerous:
  // it means nothing is checking, so it gets a heartbeat like everything else.
  // Runs on BOTH paths deliberately (§43 asks for redundancy, and the audit
  // only reads): the loop's reconcile phase AND the fast monitor's 60s band.
  // The faster path sets the expectation — fixed, not loop-derived, for the
  // same reason as above.
  protection_audit: { label: 'Position protection audit', expectedSec: 60, factor: 4 },
  // NEVER REGISTERED UNTIL 2026-08-04. loss-guardian.js has been amending stops
  // and closing positions since it shipped, and beat `loss_guardian` on every
  // loop cycle — a name absent from this registry, so heartbeatView skipped it
  // and the panel never showed it. The one writer whose job is to put a stop on
  // a position that has NONE was the one writer nobody could see running.
  // Now on the fast monitor's 60s band with the other level-4 writers.
  loss_guardian:    { label: 'Loss Guardian',          expectedSec: 60,   factor: 4 },
  // Found by the same test, same defect: both beat every loop cycle to a name
  // this registry did not contain, so neither has ever been visible. Neither
  // writes to a position — pending_signals re-checks queued setups against a
  // fresh scan, edge_watchdog watches strategy decay — so they are loop-tied
  // like their peers rather than moved.
  pending_signals:  { label: 'Pending-signal retry',   tiedToLoop: true,  factor: 3 },
  edge_watchdog:    { label: 'Edge watchdog',          tiedToLoop: true,  factor: 3 },
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
  // §41's level 5 — "per-minute management policy" — which until 2026-08-04 was
  // the one authority level with no code behind it at all. It reads the
  // position-event journal and reports when a lower-authority writer took a
  // stop the owner placed by hand. It writes nothing to a position, so its own
  // ticker is safe (§36.2.3 forbids duplicating an ACTING layer, not an
  // observing one) and §43 asks for exactly that: its own path, its own light.
  minute_review: { label: 'Per-minute review', expectedSec: 60, factor: 4 },
  // §70.9. The P&L repair had NO heartbeat, so a backfill that stopped was
  // invisible until the daily-loss veto fired hours later on a total it could
  // no longer trust — the "silence is not health" shape this repo has now hit
  // four times. Loop-tied because it runs in the reconcile phase.
  pnl_reconcile: { label: 'P&L reconciliation', tiedToLoop: true, factor: 3 },
}

const FAIL_ALERT_AT = 3 // consecutive in-controller failures before alerting

// The two sidecar-probe controllers. Only these can be DORMANT — see
// sideIsDormant — so only these pay for the dormancy lookup in heartbeatView.
const EXEC_SIDE_NAMES = new Set(['cpp_exec', 'cpp_exec_demo'])

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

  // TICKER LIVENESS IS NOT PRODUCT LIVENESS. Everything above this line asks
  // "did the controller beat?". For protection_audit that is the wrong
  // question: on 2026-08-06 it beat happily while its last completed reading
  // was 48 hours old, so the panel showed `ok` beside an answer from two days
  // earlier. Edge-triggered, so a two-day gap sends one alert rather than one
  // per sweep — see protection-freshness.js.
  const product = checkProtectionFreshness(db, {
    nowMs: now.getTime(), notify, audit: auditControllerEvent,
  })
  if (product.event) {
    events.push({
      name: 'protection_audit',
      event: product.event === 'stale' ? 'product_stale' : 'product_fresh',
      ageSec: product.freshness.ageSec,
    })
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
  // Read once, outside the loop — one controller consults it and the panel is
  // on a hot path.
  const protection = protectionFreshnessFrom(db, { nowMs: now.getTime() })
  return Object.entries(CONTROLLERS).map(([name, def]) => {
    const row = byName[name]
    const expected = expectedSecFor(def, lsec)
    const product = name === 'protection_audit' ? protection : null
    if (!row) {
      // IDLE, AND THE REASON WHY. Two very different things arrive here: a
      // controller that has never run (burn-in on a box that never armed it),
      // and a sidecar side with no enabled account to serve. The second one
      // used to arrive as ERROR with a climbing failure count; it must not now
      // arrive as a bare "idle" the operator has to interpret.
      const dormant = EXEC_SIDE_NAMES.has(name) ? dormancyOf(db, name) : null
      return { name, label: def.label, status: 'idle', expected_sec: expected, runs: 0,
        ...(dormant ? { dormant: true, last_error: dormant.reason, error_is_current: false } : {}),
        ...(product ? { work_product: product } : {}) }
    }
    const age = ageSecOf(row, now)
    let status = age > expected * def.factor
      ? 'stalled'
      : row.consecutive_failures >= FAIL_ALERT_AT
        ? 'error'
        : row.consecutive_failures > 0 ? 'warn' : 'ok'
    // THE CONTRADICTION, FIXED WHERE IT IS READ. A beating ticker with a stale
    // answer must not print `ok` — that is the exact reading that let a 48-hour
    // gap sit in plain sight. `warn`, not `stalled`: the process genuinely is
    // running, and overstating it as a stall would misdirect whoever acts on
    // it. `work_product` carries the age so the panel can say WHY.
    if (product && product.enabled && !product.fresh && status === 'ok') status = 'warn'
    return {
      ...(product ? { work_product: product } : {}),
      name,
      label: def.label,
      status,
      expected_sec: expected,
      age_sec: Number.isFinite(age) ? Math.round(age) : null,
      last_run_at: row.last_run_at,
      last_ok_at: row.last_ok_at,
      last_error: row.last_error,
      // IS THAT ERROR STILL TRUE? (owner, 04-08-2026, reading the panel:
      // "ATR baseline refresh {hasn't refresh since 9 AM yesterday}".)
      //
      // beat() keeps last_error across a later success on purpose — it is
      // useful forensics. But the panel printed it beside a controller that
      // had since run clean, so `atr_refresh` showed `unknown period "D1"`
      // (a bug fixed the day before, 185/185 symbols updated on its next run)
      // as though it were happening now. An error that cannot go away teaches
      // the operator to stop reading errors.
      //
      // consecutive_failures already knows the difference; this just says so,
      // so the UI can show a resolved error as history instead of as an alarm.
      error_is_current: row.consecutive_failures > 0,
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
 *     (exec-engine.js:176), so a shrunk roster is a new key.
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
/**
 * Which sidecar(s) to probe, and what each one is responsible for.
 *
 * PHASE 2 of the two-sidecar plan. `rosterDrift` was structurally blind: it
 * compared ONE sidecar's roster against `getCtraderCreds(db).accountIds`, which
 * is filtered `WHERE enabled = 1 AND is_live = ?` off the single global
 * `ctrader_is_live` flag. With that flag on LIVE the comparison set was
 * `{live account}` — which matched — so the four disconnected demo accounts
 * could never register as drift. The self-heal that should have caught the
 * 05-08 outage was incapable of seeing it.
 *
 * `isLive: null` means "this one sidecar serves whichever side the global flag
 * names" — today's deployment, and the branch that keeps behaviour identical.
 * Only when the two bases actually differ does this split into two responsible
 * probes, at which point each compares against its OWN side's registry rows.
 */
export function execSidesToProbe(exec) {
  const live = exec.execBaseFor(exec.EXEC_HOST_LIVE)
  const demo = exec.execBaseFor(exec.EXEC_HOST_DEMO)
  if (live === demo) return [{ name: 'cpp_exec', base: live, isLive: null }]
  return [
    { name: 'cpp_exec', base: live, isLive: true },
    // Safe to introduce unconditionally: heartbeat rows are created by beat(),
    // and checkHeartbeats skips a name with no row — so an unconfigured demo
    // side simply never appears rather than reading as STALLED.
    { name: 'cpp_exec_demo', base: demo, isLive: false },
  ]
}

/** Enabled account ids on one side, primary first — the drift comparison set. */
function enabledOnSide(db, isLive) {
  try {
    return db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 AND is_live = ? ORDER BY account_id')
      .all(isLive ? 1 : 0).map(r => String(r.account_id))
  } catch { return null }
}

/** Where a side's probe result is persisted for the read path. */
const healthKeyFor = (name) => (name === 'cpp_exec' ? 'cpp_exec_health_json' : `${name}_health_json`)

export const DORMANT_REASON =
  'no enabled account on this side — nothing for this sidecar to serve'

/**
 * Has this sidecar side got anything to serve?
 *
 * THE COUNTER THAT COULD ONLY GO UP (owner, 08-08-2026, reading the panel:
 * "C++ exec engine — ERROR, 630 failing"). Every live account was disabled, so
 * `sideCreds` correctly returned `{ready: false}`, `pushSidecarSession`
 * correctly pushed nothing, the sidecar correctly stayed disconnected, and
 * `beat()` correctly recorded a failure — every step right, and the conclusion
 * wrong. "No account exists to authorise" was being reported as "the engine is
 * broken", once every two minutes, for ever.
 *
 * That is the same defect as an error string that cannot go away (see
 * `error_is_current` above): a row that is permanently red teaches the operator
 * to stop reading red, and the one time the live sidecar genuinely breaks it
 * will look exactly like this.
 *
 * DELIBERATELY THE NARROWEST STATEMENT THAT COVERS THE CASE: the accounts that
 * ARE enabled are all on the OTHER side. Three exclusions, each one a way this
 * could have silenced a probe that should have been shouting:
 *
 *   · `isLive === null` — the single sidecar serving whatever the global flag
 *     names. It always has work by definition, so it can never be dormant.
 *   · an unreadable registry — "we could not count the accounts" is not "there
 *     are none". A probe silenced by a SQLITE_BUSY is how a real outage hides.
 *   · nothing enabled ANYWHERE — a fresh or half-seeded registry. That is an
 *     unconfigured agent, not a side with no work, and the operator needs to
 *     see the probe rather than a reassuring "idle".
 */
export function sideIsDormant(db, side) {
  if (!side || side.isLive === null || side.isLive === undefined) return false
  const mine = enabledOnSide(db, side.isLive)
  const theirs = enabledOnSide(db, !side.isLive)
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return false
  return mine.length === 0 && theirs.length > 0
}

/**
 * Record "nothing to serve" — which is not a beat, and not a failure.
 *
 * Deleting the row is the mechanism on purpose: `heartbeatView` already returns
 * `status: 'idle'` for a controller with no row, and `checkHeartbeats` iterates
 * rows, so a dormant side stops alerting without a new status needing to be
 * invented. Merely SKIPPING the probe would be worse than the bug — the row's
 * age would keep growing until it read STALLED, which claims the engine died.
 *
 * The snapshot carries the reason so the panel can say WHY it is idle instead
 * of leaving the operator to guess. `accounts: null` because this side was not
 * probed: an empty array would assert the sidecar authorises nothing, which we
 * did not ask it.
 */
function markSideDormant(db, side, nowMs) {
  try { db.prepare('DELETE FROM controller_heartbeats WHERE name = ?').run(side.name) } catch { /* telemetry only */ }
  try {
    setState(db, healthKeyFor(side.name), JSON.stringify({
      accounts: null, connected: null, hasCredentials: null, lastReconcileAt: null,
      ok: null, error: null, dormant: true, reason: DORMANT_REASON,
      side: side.isLive ? 'live' : 'demo',
      at: new Date(nowMs).toISOString(),
    }))
  } catch { /* status reporting must never break the probe */ }
}

/** The dormancy note a side left behind, if it is currently dormant. */
function dormancyOf(db, name) {
  try {
    const snap = JSON.parse(getState(db, healthKeyFor(name)) || 'null')
    return snap?.dormant === true ? snap : null
  } catch { return null }
}

export async function probeCppExec(db, deps = {}) {
  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  if (exec.execEngineMode() !== 'cpp') return null
  const sides = typeof exec.execBaseFor === 'function'
    ? execSidesToProbe(exec)
    : [{ name: 'cpp_exec', base: undefined, isLive: null }]
  const nowMs = (deps.now ?? new Date()).getTime()
  let primary = null
  for (const side of sides) {
    if (sideIsDormant(db, side)) { markSideDormant(db, side, nowMs); continue }
    const out = await probeOneSidecar(db, exec, side, deps)
    if (side.name === 'cpp_exec') primary = out
  }
  return primary
}

/**
 * Credentials for the sidecar this probe is responsible for.
 *
 * `isLive === null` is today's single-sidecar case and returns exactly what the
 * old code used — `getCtraderCreds(db)` with no override — so nothing changes.
 * A split passes an explicit side, which flips both the host and the
 * `WHERE is_live = ?` roster filter to match the process being probed.
 */
async function sideCreds(db, side) {
  const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
  if (side.isLive === null) return getCtraderCreds(db)
  const ids = enabledOnSide(db, side.isLive) || []
  // The side's own primary: the globally selected account when it belongs to
  // this side, else the first enabled row on it. Without a primary the sidecar
  // has nothing to authorise first, so there is nothing to push.
  const selected = getState(db, 'ctrader_account_id')
  const primary = selected && ids.includes(String(selected)) ? String(selected) : ids[0]
  if (!primary) return { ready: false, accountIds: ids }
  return getCtraderCreds(db, { accountId: primary, isLive: side.isLive })
}

/**
 * Push a rotated OAuth token that nothing else would ever push.
 *
 * `ensureSidecarSession` memoises on a key that includes the access token, so
 * rotation invalidates it — but only LAZILY, on the next trading call. On a
 * healthy-but-idle session nothing pushes at all. That is the documented 22-hour
 * outage: the sidecar sat "reconnecting" with `hasCredentials: true`, retrying
 * with a token Node had already replaced, all weekend, because no order path ran
 * to notice. The connected-branch below never fired because it only handled a
 * DOWN session.
 *
 * With two sidecars an idle demo side makes this more likely, not less.
 */
const TOKEN_PUSH_KEY = 'cpp_exec_token_push_json'
async function repushRotatedToken(db, exec, side) {
  const refreshedAt = getState(db, 'ctrader_token_refreshed_at')
  if (!refreshedAt) return false
  let seen = {}
  try { seen = JSON.parse(getState(db, TOKEN_PUSH_KEY) || '{}') } catch { seen = {} }
  if (seen[side.name] === refreshedAt) return false
  try {
    const pushed = exec.pushSidecarSession ? await exec.pushSidecarSession(await sideCreds(db, side)) : false
    // Record the stamp on ANY outcome, not only success. A not-ready credential
    // set is not going to become ready because we retried in 2 minutes, and
    // re-pushing every probe forever is the unconditional-re-push shape this
    // file already records as having cost real behaviour once.
    seen[side.name] = refreshedAt
    try { setState(db, TOKEN_PUSH_KEY, JSON.stringify(seen)) } catch { /* best effort */ }
    return pushed
  } catch { return false }
}

async function probeOneSidecar(db, exec, side, deps = {}) {
  const r = await exec.pingSidecar(side.base ? { base: side.base } : {})
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
      const pushed = exec.pushSidecarSession ? await exec.pushSidecarSession(await sideCreds(db, side)) : false
      if (pushed) error += ' — credentials re-pushed, session should return shortly'
    } catch { /* creds not ready or sidecar went away — next probe retries */ }
  } else if (ok && r.connected === true) {
    // Connected — now check the roster actually matches what is ENABLED.
    // Re-pushed rather than merely reported: leaving the sidecar authorised for
    // an account the owner disabled is the kind of divergence that only shows
    // up when something trades on it.
    try {
      const creds = await sideCreds(db, side)
      // THE COMPARISON SET IS THIS SIDECAR'S OWN SIDE. Comparing a live
      // sidecar's roster against a demo registry (or vice versa) can never
      // converge — the sets describe two different processes — so drift would
      // be true on every probe forever, re-pushing each time and logging a
      // "correction" that did not happen.
      const drift = rosterDrift(r.accounts, creds.accountIds)
      // No `creds.ready` check here on purpose: pushSidecarSession already
      // returns false for not-ready creds and pushes nothing, so duplicating
      // that policy would just give it two places to drift out of step. Same
      // shape as the credential-less self-heal path above.
      // Rotation first: a token that changed while this session was healthy and
      // idle is invisible to the drift check (the ROSTER still matches).
      if (await repushRotatedToken(db, exec, side)) {
        console.warn(`[heartbeat] ${side.name}: rotated access token re-pushed to a healthy idle session`)
      }
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
  beat(db, side.name, { ok, error, ...(deps.now ? { now: deps.now } : {}) })
  // Persist what the probe learned so a READ route never has to call the
  // sidecar itself. This probe already runs every ~2 minutes; making
  // /state/account-engineering re-fetch /health on every page load would put an
  // external HTTP hop inside a cached GET, which is exactly the shape of the
  // slow read routes already on the backlog. Stamped with the observation time
  // so the UI can say "as of 2 min ago" instead of implying it is live.
  try {
    setState(db, healthKeyFor(side.name), JSON.stringify({
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : null,
      connected: r.connected ?? null,
      hasCredentials: r.hasCredentials ?? null,
      lastReconcileAt: r.lastReconcileAt ?? null,
      ok,
      error: error || null,
      // Which side this snapshot describes. null = one sidecar serving whatever
      // the global flag names, i.e. today. checkAccountAuthorization reads this
      // to know whether the roster it is holding can answer for an account.
      side: side.isLive === null ? null : (side.isLive ? 'live' : 'demo'),
      at: new Date(nowMs).toISOString(),
    }))
  } catch { /* status reporting must never break the probe */ }
  return { ...r, ok, ...(error ? { error } : {}) }
}

// ---------------------------------------------------------------------------
// ACCOUNT AUTHORISATION WATCH (05-08-2026)
//
// THE INCIDENT THIS EXISTS FOR. All four demo accounts sat `enabled = 1` in the
// registry while absent from the sidecar's authorised roster. Every dispatch for
// them was short-circuited at loop.js's connectivity gate with an `account_probe`
// skip — 965 of them in 24h — and ZERO trades opened in twelve hours against 87
// the day before. Nothing said a word. It surfaced only because the owner asked
// why entries had stopped.
//
// Why the existing checks could not catch it, and why this is a SEPARATE check:
//
//   · `cpp_exec` answers "is the sidecar alive". It was alive and connected —
//     just holding one side's accounts. A green heartbeat was the truth and was
//     still useless.
//   · `rosterDrift` (below, :373) answers "does the roster match what we asked
//     for", and it compares against a creds roster already filtered to ONE side
//     by the global ctrader_is_live flag. The missing accounts were never in the
//     comparison set, so drift was structurally undetectable.
//
// This check asks the only question that matters to the operator: IS EVERY
// ENABLED ACCOUNT ACTUALLY REACHABLE RIGHT NOW? It compares the registry against
// the roster with no side filter at all, which is precisely the thing neither
// check above does.
//
// It reads the roster the probe already persisted rather than making its own
// HTTP call — this runs on the 60s band, the probe on 120s, and a second hop
// inside a watchdog is how a watchdog becomes the outage.
// ---------------------------------------------------------------------------

/** How long an account must be continuously unreachable before it alerts. */
export const AUTH_ALERT_AFTER_MS = 5 * 60_000
/** Beyond this, the persisted health snapshot is too old to judge anything by. */
const HEALTH_STALE_MS = 5 * 60_000
const AUTH_WATCH_KEY = 'account_auth_watch_json'

/**
 * Alert when an enabled account is not authorised on the exec sidecar.
 *
 * Alerts ONCE per outage and once on recovery — never per tick. The 32,115
 * identical `unknown_daily_pnl` vetoes in one week are why de-duplication is a
 * requirement here and not a nicety: an alert that repeats is an alert that gets
 * muted, and a muted alert is the same as the silence this replaces.
 *
 * `unknown` NEVER alerts. A health blip, a js-mode deployment, or a sidecar that
 * did not report its roster are all "we cannot tell", and telling the owner an
 * account is down because we could not reach the thing that would know is how a
 * monitor teaches people to ignore it. Same fail-open rule sidecarRoster already
 * applies (exec-engine.js:281-287). The `cpp_exec` heartbeat covers the case
 * where the probe itself is the thing that is broken.
 *
 * @returns {{events: Array, roster: string[]|null, fresh: boolean}}
 */
export function checkAccountAuthorization(db, {
  now = new Date(), notify = null, afterMs = AUTH_ALERT_AFTER_MS,
} = {}) {
  const say = (text) => { try { notify?.(text) } catch { /* alerting must never throw */ } }
  const events = []
  const nowMs = now.getTime()

  const readSnap = (key) => {
    try { return JSON.parse(getState(db, key) || 'null') } catch { return null }
  }
  const health = readSnap('cpp_exec_health_json')
  // PHASE 2: a second sidecar publishes its own snapshot. Absent — today — every
  // account is evaluated against the single one, exactly as before.
  //
  // This matters because the roster and the registry are counted in different
  // units the moment a split exists: this check deliberately reads the registry
  // with NO side filter (that blindness is what made rosterDrift useless), so a
  // single roster measured against both sides would report every account on the
  // other side as `disconnected` while its own sidecar was perfectly healthy.
  // The alarm built for the 05-08 outage would then manufacture a fake one.
  const demoHealth = readSnap('cpp_exec_demo_health_json')
  const snapFor = (isLive) => (demoHealth && !isLive ? demoHealth : health)

  const rosterOf = (h) => (Array.isArray(h?.accounts) ? h.accounts.map(String) : null)
  const roster = rosterOf(health)
  const healthAtMs = health?.at ? Date.parse(health.at) : NaN
  // A snapshot older than the probe's own stall threshold tells us nothing about
  // NOW. Treat it as unknown rather than as evidence.
  const fresh = Number.isFinite(healthAtMs) && (nowMs - healthAtMs) < HEALTH_STALE_MS
  // REPRODUCE THE GATE'S CONDITION, WHICH IS NOT THE SAME AS THE PERSISTED `ok`.
  //
  // This alert describes the connectivity gate's behaviour, so it must agree
  // with the value that gate reads — sidecarRoster (exec-engine.js:293), whose
  // test is `h.ok && h.connected === true && Array.isArray(h.accounts)` where
  // `h.ok` is HTTP-level only (`res.ok && body?.ok === true`, :248).
  //
  // `health.ok` in the snapshot is NOT that value. probeCppExec overwrites it
  // with its own verdict before persisting, and two of those overwrites fire
  // while connected === true (:463 no reconcile yet, :466 reconcile stale). So
  // gating on the persisted `ok` is strictly NARROWER than the gate, and the
  // error mode is silence: sidecar up, session connected, roster holding only
  // the live account, engine loop stalled → sidecarRoster returns the roster and
  // loop.js:1173 skips all four demo accounts, while this check would say
  // "unknown" and never alert. That is the 05-08 outage plus a stalled loop —
  // and cpp_exec, which does go red, reports "last reconcile 10m ago": it names
  // the loop, not the four unreachable accounts. Exactly the gap this check
  // exists to close.
  //
  // `roster != null` stands in for the array test: probeCppExec persists
  // `accounts` non-null only when the ping returned an array, which already
  // implies a parsed /health body. `connected` is persisted raw.
  //
  // The 02-08 case is still covered — GET /health sets ok:true unconditionally
  // (main.cpp:272) and fills `accounts` from engine.accountIds(), empty after a
  // restart and stale after a WS drop, but `connected` is false there and
  // sidecarRoster returns null too, so both stay silent together.
  const sessionUp = health?.connected === true && roster != null

  /** The three facts this check needs about ONE account's own sidecar. */
  const viewFor = (isLive) => {
    const h = snapFor(isLive)
    if (h === health) return { roster, fresh, sessionUp }
    const rr = rosterOf(h)
    const atMs = h?.at ? Date.parse(h.at) : NaN
    return {
      roster: rr,
      fresh: Number.isFinite(atMs) && (nowMs - atMs) < HEALTH_STALE_MS,
      sessionUp: h?.connected === true && rr != null,
    }
  }

  // A FAILED READ IS NOT "NO ACCOUNTS ARE ENABLED", and conflating them wipes
  // every dwell timer and every `alerted` flag. `next` is built from this list,
  // so an empty list persists `{}` over the watch state: an account already
  // alerted and still down would restart its dwell, alert a SECOND time for one
  // continuous outage, and lose the flag that gates the recovery message.
  // That is the exact repeat-alert shape the docstring calls a requirement,
  // reintroduced by an unrelated SQLITE_BUSY. The `unknown` branch already
  // treats "cannot tell" as "carry the state"; this is the same epistemic
  // position, and only a flag can tell it apart from a legitimately empty
  // registry (which SHOULD clear).
  let accounts = []
  let registryRead = true
  try {
    accounts = db.prepare(
      'SELECT account_id, trader_login, is_live FROM accounts WHERE enabled = 1'
    ).all()
  } catch { accounts = []; registryRead = false }

  let watch = {}
  try { watch = JSON.parse(getState(db, AUTH_WATCH_KEY) || '{}') } catch { watch = {} }
  const next = {}

  for (const a of accounts) {
    const id = String(a.account_id)
    const prev = watch[id] || null
    // THIS ACCOUNT'S OWN SIDECAR, not whichever one EXEC_URL names.
    const view = viewFor(a.is_live === 1)
    const status = (view.roster == null || !view.fresh || !view.sessionUp)
      ? 'unknown'
      : view.roster.includes(id) ? 'active' : 'disconnected'

    // Carry the timer across an unknown window rather than restarting it: an
    // outage interrupted by a health blip is still one continuous outage, and
    // restarting the dwell on every blip is how a real stall never reaches the
    // threshold.
    if (status === 'unknown') {
      if (prev) next[id] = { ...prev, unknownSince: prev.unknownSince ?? nowMs }
      continue
    }

    if (status === 'disconnected') {
      let since = prev?.since ?? nowMs
      const alerted = prev?.alerted === true
      // A LONG BLIND WINDOW RE-ARMS THE DWELL. Carrying `since` is right for a
      // brief blip — the outage really was continuous. It is wrong when we
      // stopped looking for hours: flip EXEC_ENGINE to js overnight (no roster,
      // no gate, trading fine) and the first cpp probe next morning would fire
      // instantly, reporting "absent for 720m", with none of the five-minute
      // grace that exists so a restarting sidecar can re-authorise before
      // anyone is paged. The noisiest moment — a deploy or a mode flip — is
      // exactly where the dwell would already be spent.
      //
      // A blind window shorter than the dwell is still one outage and carries.
      // One longer than it starts the clock again, which also makes the minutes
      // in the message an observed span rather than mostly-unseen wall clock.
      // `alerted` is deliberately NOT reset: someone already told is not told
      // twice.
      if (prev?.unknownSince != null && (nowMs - prev.unknownSince) >= afterMs) {
        since = nowMs
      }
      const downMs = nowMs - since
      if (!alerted && downMs >= afterMs) {
        const side = a.is_live === 1 ? 'LIVE' : 'Demo'
        const label = a.trader_login ? `${side} ${a.trader_login} · ${id}` : `${side} ${id}`
        // DELIBERATELY STOPS AT "no order can be built". The query is
        // `enabled = 1` — wider than the entry roster, which getAutopilotAccounts
        // further filters to the `enter` capability (loop.js:224-249). The wide
        // query is right: a `manage_only` account off the roster cannot receive
        // closes or amends either, which is worth knowing. But saying "entries
        // are skipped" would be false for exactly those accounts, and a sentence
        // that is wrong for some of its subjects is how an alert loses its
        // reader.
        say(
          `🔌 ACCOUNT NOT AUTHORISED: ${label} has been enabled but absent from the exec sidecar's roster for ${Math.round(downMs / 60_000)}m. ` +
          'No order can be built for it until it reconnects.'
        )
        events.push({ accountId: id, event: 'unauthorized', downSec: Math.round(downMs / 1000) })
        auditControllerEvent(db, {
          controller: 'account_auth',
          event: 'unauthorized',
          detail: `${label} absent from the sidecar roster for ${Math.round(downMs / 60_000)}m`,
        })
        next[id] = { since, alerted: true }
      } else {
        next[id] = { since, alerted }
      }
      continue
    }

    // active — announce recovery only to someone who heard the alarm.
    if (prev?.alerted) {
      const side = a.is_live === 1 ? 'LIVE' : 'Demo'
      const label = a.trader_login ? `${side} ${a.trader_login} · ${id}` : `${side} ${id}`
      say(`🔗 ACCOUNT REAUTHORISED: ${label} is back on the exec sidecar's roster and can receive orders again.`)
      events.push({ accountId: id, event: 'reauthorized' })
      auditControllerEvent(db, { controller: 'account_auth', event: 'reauthorized', detail: label })
    }
  }

  // Only persist what we actually observed. See the registryRead note above:
  // writing `{}` after a failed read is how a transient becomes a duplicate page.
  if (registryRead) {
    try { setState(db, AUTH_WATCH_KEY, JSON.stringify(next)) } catch { /* watch state is best-effort */ }
  }
  return { events, roster, fresh }
}
