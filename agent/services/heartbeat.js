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
import { createHash } from 'node:crypto'
import { refusedKeyFor } from '../lib/token-refused.js'
import { auditControllerEvent } from './phase-audit.js'
import { checkProtectionFreshness, protectionFreshnessFrom } from './protection-freshness.js'
import { ctraderEnv } from '../lib/ctrader-env.js'

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
  // THE 60-SECOND PROTECTION BAND, on its own ticker (owner § 7,453·C,
  // 08-09-2026). Loss cap, ratchet, trade guards, profit keeper, loss
  // guardian and the protection audit used to run inside the 3-second tick
  // behind a once-a-minute gate, so a slow band skipped spike ticks and a
  // slow spike pass delayed protection. The band now ticks by itself, beats
  // ok only when it finished inside its 60s, and writes what it measured —
  // tick and band durations, 10-minute maxima, overrun — as its record. A
  // band that is running but overrunning is an error here, not a warn:
  // "protection every minute" is the claim, and a 90s band breaks it.
  protection_band:  { label: 'Protection band (60s)',  expectedSec: 60,   factor: 4, effect: { key: 'fast_monitor_pass_json', kind: 'json', maxAgeSec: 240 } },
  burn_in:          { label: 'Burn-in engine',         tiedToLoop: true,  factor: 3 },
  // Wave 5 (§K·15): retired with its producer (lib/entry-producers.js
  // pending_fib_orders). The loop no longer runs or beats the phase; the
  // watchdog ignores it and the panel labels it, so a controller that is
  // not scheduled cannot read as stalled.
  pending_orders:   { label: 'Pending-order manager',  tiedToLoop: true,  factor: 3, retired: '2026-09-19 Wave 5: producer retired — phase not scheduled' },
  // EVERY THIRD LOOP, not every loop (measured 08-09-2026, § 7,453·C): both
  // of these beat inside loop.js's reconcile block, gated `loopCount % 3 ===
  // 0`, so their real cadence is ~3 minutes on a 1-minute loop. Expected as
  // a single loop with grace 3, the threshold sat exactly on the cadence and
  // the phase audit flapped stalled/recovered four times in 30 minutes on a
  // healthy controller. Same fix weekend_bank got for the same block.
  order_monitor:    { label: 'Order-fill monitor',     tiedToLoop: true,  loopMultiplier: 3, factor: 3 },
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
  autopilot:        { label: 'Strategy autopilot',     tiedToLoop: true,  factor: 3, effect: { key: 'autopilot_last_run_ms', kind: 'ms' } },
  hours_refresh:    { label: 'Market-hours refresh',   expectedSec: 86_400, factor: 2 },
  // Daily per-account budget planner (§7,437·B·3, 08-09-2026): one account
  // rebuilt per loop cycle when its record is a day old, so the beat lands
  // several times a day; the record is what the gates read.
  fundable_universe: { label: 'Fundable universe (daily)', expectedSec: 86_400, factor: 2, effect: { key: 'fundable_universe_last_json', kind: 'json', maxAgeSec: 30 * 3600 } },
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
  protection_audit: { label: 'Position protection audit', expectedSec: 60, factor: 4, effect: { key: 'acct:*:protection_audit_last_json', kind: 'protection' } },
  // The speech-act log inspector (owner invariants 2-4, 31-08-2026): reads
  // every decision sink and emits falsifiable findings. On the fast monitor's
  // band so it keeps inspecting when the loop is the broken thing.
  log_inspector:    { label: 'Log inspector (speech-act)', expectedSec: 300, factor: 4, effect: { key: 'log_inspector_last_json' } },
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
  edge_watchdog:    { label: 'Edge watchdog',          tiedToLoop: true,  factor: 3, effect: { key: 'edge_watchdog_last_json' } },
  // D6 — the daily ATR baseline the volatility gate reads. If this stops
  // running, atr_history goes stale and every symbol quietly reads as NORMAL
  // volatility: a verdict none of them earned, and indistinguishable from a
  // real one. Daily cadence, generous grace — it is once per ~288 loops.
  atr_refresh: { label: 'ATR baseline refresh', expectedSec: 86_400, factor: 2, effect: { key: 'atr_refresh_last_json' } },
  // The check AFTER the risk gate decides (owner 2026-08-03). Answers "why
  // didn't it trade" from the DB every cycle. It is itself a controller, so a
  // stalled auditor is visible rather than being mistaken for a clean day —
  // an auditor that silently stops is the exact bug it was built to detect.
  decision_audit: { label: 'Post-decision audit', tiedToLoop: true, factor: 3, effect: { key: 'decision_audit_last_json' } },
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
  pnl_reconcile: { label: 'P&L reconciliation', tiedToLoop: true, loopMultiplier: 3, factor: 3 }, // reconcile block, every 3rd loop — see order_monitor
  // The weekend LLM watch is a budgeted sub-phase, and runBudgetedSubPhase
  // beats a sub-phase's name FAILED when it overruns its budget. This name
  // was never registered, so that failed beat landed on a row the panel
  // never rendered (blueprint audit, 02-09-2026 — the loss_guardian shape
  // above, again). It only runs when closed-market positions exist and the
  // LLM is available, so its expectation is a week rather than a cadence:
  // absence is normal, a FAILED beat is the thing to see.
  weekend_watch: { label: 'Weekend watch (LLM)', expectedSec: 7 * 86_400, factor: 2 },
  // The two phases that CLOSE positions and DISARM accounts on their own
  // authority had no row at all (blueprint audit, 02-09-2026). Each is a
  // try/catch in loop.js whose failure was a log line per cycle — a phase
  // throwing every cycle for a week was indistinguishable from one that
  // found nothing to do. Loop-tied: both run inside the per-cycle risk
  // block, and both are beaten at the END of their phase so a throw is a
  // FAILED beat, not silence.
  equity_stop:         { label: 'Equity stop (daily drawdown)', tiedToLoop: true, factor: 3 },
  performance_breaker: { label: 'Performance breaker',          tiedToLoop: true, factor: 3 },
  // THREE SWEEPS THAT RAN WITHOUT A RECORD (§7,437·B·5, 08-09-2026). The
  // closed-market limit sweep, the FX-leg refresh and the cross-side equity
  // read each ran every cycle and wrote nothing a reader could date, so a
  // sweep that stopped would have looked identical to one that never had
  // anything to do. Each now beats where it runs; the equity read sits inside
  // the every-3rd-cycle reconcile block, hence its multiplier.
  closed_market_sweep: { label: 'Closed-market limit sweep', tiedToLoop: true, factor: 3 },
  fx_legs_refresh:     { label: 'FX-leg refresh',            tiedToLoop: true, factor: 3 },
  cross_side_equity:   { label: 'Cross-side equity read',    tiedToLoop: true, loopMultiplier: 3, factor: 4 },
  // Wave 3 (19-09-2026): the nightly mark-to-market equity row per account,
  // once every 24 h on a persisted stamp. Stale only after two missed nights.
  equity_snapshot:     { label: 'Nightly equity snapshot',    expectedSec: 24 * 3600, factor: 2 },
  // Wave 5 (§K item 16): the daily Telegram report, once every 24 h on the
  // loop's persisted cursor; its record is the last text as posted.
  daily_report:        { label: 'Daily report (Telegram)',    expectedSec: 24 * 3600, factor: 2, effect: { key: 'daily_report_last_json', kind: 'json', maxAgeSec: 30 * 3600 } },
}

const FAIL_ALERT_AT = 3 // consecutive in-controller failures before alerting

// Last exec-guard sync failure, {at, side, error}; null once a push succeeds.
// Written by the probe below and by loop.js's equity-stop push; read by
// GET /state/heartbeats as `execGuardSync`.
export const EXEC_GUARD_SYNC_ERROR_KEY = 'exec_guard_sync_last_error_json'

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

// ---------------------------------------------------------------------------
// THE RECORD, NOT THE RUNNER (§7,437·B·5). A beat says the controller's code
// executed; it says nothing about whether the thing the controller exists to
// produce was produced. The protection audit was the measured case (CLAUDE.md
// failure mode #3): a ticker beating every 50 seconds beside a record that
// had not moved in a week. protection-freshness.js answered that for ONE
// controller; this generalises it. A registry entry may name an `effect`:
//   { key, kind?: 'json' | 'ms' | 'protection', maxAgeSec? }
// `json` (default) reads `{at}` from the agent_state JSON at `key`; `ms`
// reads a millisecond string; `protection` delegates to the per-account
// merge in protection-freshness.js. The freshness limit defaults to the same
// window the stall check uses (expected × factor) so "record stale" and
// "runner stalled" cannot disagree about what "too old" means.
//
// The verdict is computed AT READ TIME from the record's own timestamp.
// Nothing here is stamped by the writer, so a writer that stops cannot leave
// a green flag behind — the reading ages on its own.
// ---------------------------------------------------------------------------
function effectAtMs(db, effect) {
  if (!effect?.key) return NaN
  try {
    const raw = getState(db, effect.key)
    if (raw == null || raw === '') return NaN
    if (effect.kind === 'ms') return Number(raw)
    return Date.parse(JSON.parse(raw)?.at || '')
  } catch { return NaN }
}

/**
 * Freshness of a controller's effect record. Same shape for every kind so the
 * panel and the goal table read one field.
 * @returns {{hasRecord:boolean, at:string|null, ageSec:number|null, maxAgeSec:number, fresh:boolean, key:string, summary:string}|null}
 */
export function effectRecord(db, name, { nowMs = Date.now(), loopSec = null, protection = null } = {}) {
  const def = CONTROLLERS[name]
  if (!def?.effect) return null
  const expected = expectedSecFor(def, effectiveLoopSec(db, loopSec))
  const maxAgeSec = Number.isFinite(def.effect.maxAgeSec) ? def.effect.maxAgeSec : expected * def.factor
  if (def.effect.kind === 'protection') {
    const p = protection || protectionFreshnessFrom(db, { nowMs })
    return { hasRecord: p.hasReading, at: p.at, ageSec: p.ageSec, maxAgeSec: p.maxAgeSec, fresh: p.fresh, key: def.effect.key, summary: p.summary }
  }
  const t = effectAtMs(db, def.effect)
  const hasRecord = Number.isFinite(t)
  const ageSec = hasRecord ? Math.max(0, Math.round((nowMs - t) / 1000)) : null
  const fresh = hasRecord && ageSec <= maxAgeSec
  const summary = !hasRecord
    ? `no record at ${def.effect.key} — the controller may beat, but nothing it produced can be dated`
    : fresh
      ? `record ${Math.round(ageSec / 60)}m old (limit ${Math.round(maxAgeSec / 60)}m)`
      : `RECORD ${Math.round(ageSec / 60)}m OLD — past the ${Math.round(maxAgeSec / 60)}m limit; the runner may be beating, its product is not current`
  return { hasRecord, at: hasRecord ? new Date(t).toISOString() : null, ageSec, maxAgeSec, fresh, key: def.effect.key, summary }
}

/**
 * One word per controller for the goal table and the panel: the status
 * ladder (idle/stalled/error/warn/ok) plus the record's own age.
 *   never_ran     — no beat on record
 *   stalled/error — the runner itself
 *   record_stale  — the runner is fine, its product is past the limit (or absent)
 *   warn/ok       — as status
 */
export function verdictOf(status, product) {
  if (status === 'idle') return 'never_ran'
  if (status === 'stalled' || status === 'error') return status
  if (product && !product.fresh) return 'record_stale'
  return status
}

/**
 * Record one controller run. ok=false increments the failure streak.
 *
 * `detail` — the controller's own account of THIS run (pnl_reconcile passes
 * its reconciliation state) — is persisted as `last_detail_json` and shown
 * by heartbeatView. It was accepted and dropped until 02-09-2026: loop.js
 * had been passing it for weeks to a function whose signature did not name
 * it. Written verbatim per beat, null when a run carries none, so a stale
 * detail is never presented as the current run's.
 */
export function beat(db, name, { ok = true, error = null, detail = null, now = new Date() } = {}) {
  const ts = now.toISOString()
  const okInt = ok ? 1 : 0
  const errText = ok ? null : String(error || 'unknown error').slice(0, 500)
  let detailJson = null
  if (detail != null) {
    try {
      const s = JSON.stringify(detail)
      detailJson = s.length > 4000 ? JSON.stringify({ truncated: true, bytes: s.length }) : s
    } catch { detailJson = JSON.stringify({ unserialisable: true }) }
  }
  db.prepare(
    `INSERT INTO controller_heartbeats
       (name, last_run_at, last_ok_at, last_error, consecutive_failures, runs, updated_at, last_detail_json)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_ok_at = CASE WHEN ? = 1 THEN excluded.last_run_at ELSE last_ok_at END,
       last_error = CASE WHEN ? = 1 THEN last_error ELSE excluded.last_error END,
       consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
       runs = runs + 1,
       updated_at = excluded.updated_at,
       last_detail_json = excluded.last_detail_json`
  ).run(name, ts, ok ? ts : null, errText, ok ? 0 : 1, ts, detailJson, okInt, okInt, okInt)
}

function parseDetail(row) {
  if (row?.last_detail_json == null) return null
  try { return JSON.parse(row.last_detail_json) } catch { return null }
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
    // A retired controller is not scheduled, so its silence is not a stall.
    if (def.retired) continue
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
    if (def.retired) {
      // Labelled, not judged: the last beat (if any) is history, the verdict
      // says why nothing is expected. The goal table skips `retired` rows.
      return { name, label: def.label, status: 'retired', verdict: 'retired', retired: true, note: def.retired,
        expected_sec: null, runs: row?.runs ?? 0, last_run_at: row?.last_run_at ?? null, last_ok_at: row?.last_ok_at ?? null,
        last_error: null, error_is_current: false, consecutive_failures: 0, detail: null }
    }
    // Every controller with a declared effect gets its record dated here —
    // the protection audit's per-account merge is one kind among several.
    const product = def.effect ? effectRecord(db, name, { nowMs: now.getTime(), loopSec: lsec, protection }) : null
    if (!row) {
      // IDLE, AND THE REASON WHY. Two very different things arrive here: a
      // controller that has never run (burn-in on a box that never armed it),
      // and a sidecar side with no enabled account to serve. The second one
      // used to arrive as ERROR with a climbing failure count; it must not now
      // arrive as a bare "idle" the operator has to interpret.
      const dormant = EXEC_SIDE_NAMES.has(name) ? dormancyOf(db, name, now.getTime()) : null
      return { name, label: def.label, status: 'idle', verdict: verdictOf('idle', product), expected_sec: expected, runs: 0,
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
    // Generalised 08-09-2026: any controller whose record is past its limit
    // prints `warn`, not just the protection audit (`enabled` was the audit's
    // own opt-out; a plain record has none).
    if (product && product.enabled !== false && !product.fresh && status === 'ok') status = 'warn'
    return {
      ...(product ? { work_product: product } : {}),
      name,
      label: def.label,
      status,
      verdict: verdictOf(status, product),
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
      detail: parseDetail(row),
    }
  })
}

/**
 * Does the sidecar's authorised-account roster still match the registry's?
 *
 * WHY THIS EXISTS (2026-07-30). The owner disabled account ACCT-DEMO-3 in the
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
export function rosterDrift(sidecarAccounts, credsAccountIds, refusedAccounts = null) {
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
  // B2 (18-09-2026): TRIED AND REFUSED IS NOT MISSING. The live token does
  // not cover …2148 / …9009; the sidecar tried them on every push, was refused
  // (CH_ACCESS_TOKEN_INVALID), and reported 1/3 — so `missing` held the two
  // for ever, the heartbeat re-pushed the same roster every ~2 minutes and
  // logged each push as a "correction" at error level. An account the
  // sidecar has already tried is reported separately, not re-pushed: pushing
  // it again cannot change what the token authorises.
  const refused = norm(refusedAccounts)
  const missing = [...want].filter(id => !have.has(id) && !refused.has(id)).sort()
  const refusedWanted = [...want].filter(id => refused.has(id)).sort()
  return { drifted: extra.length > 0 || missing.length > 0, extra, missing, refused: refusedWanted }
}

/** State key holding the accounts a sidecar's token was refused for (B2). Lives in
 *  lib/token-refused.js since B7 so the equity sweep and the reactive refresh can
 *  read it without importing the heartbeat; re-exported for its existing readers. */
export { refusedKeyFor }

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
  // FOURTH EXCLUSION, AND THE ONE THAT IS NOT IN THE REGISTRY (review, 08-08).
  // The three above all ask `accounts.enabled`. Dispatch does not: every
  // fast-monitor writer runs on `getCtraderCreds(db)`, which prepends the
  // globally-selected account with NO enabled test (ctrader-creds.js:44) and
  // picks its host from `ctrader_is_live`. So with the flag on `live` and a
  // DISABLED live account selected, `enabledOnSide(true)` is empty while trade
  // guards, profit keeper, the session-open guard and the protection audit all
  // keep dispatching to that live sidecar — and this function would delete its
  // heartbeat row and stop probing it. A sidecar carrying stop amendments would
  // then have no beat, no probe and no watchdog, under a panel saying it has
  // nothing to serve. That is strictly worse than the 630 this change removes.
  //
  // `sideCreds` already distrusts the selected id; `getCtraderCreds` does not,
  // and dormancy must not inherit the looser view. A side the flag names still
  // carries traffic, whatever the registry says about it.
  //
  // Resolved the SAME way getCtraderCreds resolves it — state key first, env
  // fallback second (ctrader-creds.js:22). Reading only the state key would
  // agree today (index.js seeds it from env at boot and nothing clears it) and
  // disagree the moment that seeding changes, which is the kind of drift that
  // is absent rather than impossible. Matching the resolution makes it the
  // latter.
  //
  // Wrapped for the same reason enabledOnSide is: a throw here propagates out of
  // probeCppExec, and fast-monitor wraps the probe and the watchdogs in ONE try
  // — so a SQLITE_BUSY on these two reads would skip checkHeartbeats and
  // checkAccountAuthorization for that tick. Unreadable means "assume it has
  // work", the same fail-safe direction as everywhere else here.
  try {
    const flagIsLive = getState(db, 'ctrader_is_live') === 'true'
    const selected = getState(db, 'ctrader_account_id') || ctraderEnv('accountId')
    if (flagIsLive === side.isLive && selected) return false
  } catch { return false }
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
  // Deleting the row also discards `stalled` and `fail_alerted`, so a side that
  // had already sent "🔴 CONTROLLER FAILING" will never send the matching
  // recovery line — the row simply vanishes. That is intended: it did not
  // recover to "working", it recovered to "nothing to serve", and announcing a
  // recovery would claim the first thing. A missing recovery message here is
  // not a dropped alert.
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

/**
 * The dormancy note a side left behind — only as current as the probe that
 * wrote it.
 *
 * THE AGE TEST IS NOT DECORATION (review, 08-08). Every other reader of these
 * snapshots applies HEALTH_STALE_MS, for the reason spelled out in
 * checkAccountAuthorization: a snapshot older than the probe's own stall
 * threshold tells us nothing about NOW. Nothing clears this flag except a later
 * probe of the same side, and two ordinary changes stop that call happening at
 * all — EXEC_ENGINE set to `js` (probeCppExec returns before any side is
 * touched) and the split collapsing to one sidecar (execSidesToProbe drops
 * cpp_exec_demo). Either would leave the panel asserting a current, specific
 * reason for a controller nothing is evaluating any more — which is the same
 * "an error that cannot go away" defect this whole change is against.
 *
 * Expired, it falls back to the honest generic idle text.
 */
function dormancyOf(db, name, nowMs) {
  try {
    const snap = JSON.parse(getState(db, healthKeyFor(name)) || 'null')
    if (snap?.dormant !== true) return null
    const atMs = snap.at ? Date.parse(snap.at) : NaN
    return Number.isFinite(atMs) && (nowMs - atMs) < HEALTH_STALE_MS ? snap : null
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
  // PR-1b (20-09-2026): the tick fire ledger turns each ACCEPTED tick fire in
  // the sidecar's ring into the one approved risk_events row its close needs
  // for `direction_reason` — the field that made every tick close fail capture
  // with `missing: direction_reason`.
  //
  // ONCE PER HEARTBEAT, NOT ONCE PER SIDE (checker round). Its high-water mark
  // is a single cursor over the `cpp_decisions` TABLE, which already holds
  // every side's rows; running it inside the per-side probe would have driven
  // one global cursor from a per-side call site — correct only by luck, and
  // the shape this repo keeps paying for. Here it runs after BOTH sides'
  // decision pulls, so one pass sees both sides' rows. Its own try: a ledger
  // failure must never fail the beat.
  try {
    const run = deps.runTickFireLedger ?? (await import('./tick-fire-ledger.js')).runTickFireLedger
    run(db, { now: nowMs })
  } catch (err) { console.warn(`[heartbeat] tick fire ledger failed: ${err?.message || err}`) }
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
/** AUDIT 11-09-2026: the sidecar side an account lives on, for an on-demand push. */
export function sideForAccount(db, exec, accountId) {
  let isLive = null
  try { const r = db.prepare('SELECT is_live FROM accounts WHERE account_id = ?').get(String(accountId)); if (r) isLive = Number(r.is_live) === 1 } catch { isLive = null }
  const sides = execSidesToProbe(exec)
  return sides.find(s => s.isLive === isLive) || sides.find(s => s.isLive === null) || null
}

export async function sideCreds(db, side) {
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
/** B7: a short fingerprint of the token VALUE — what the sidecar holds is the
 *  token, not the time it was fetched. Never the token itself in state. */
export function accessTokenFingerprint(token) {
  if (!token) return null
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

async function repushRotatedToken(db, exec, side) {
  // B7 (18-09-2026): compare the TOKEN, not the refresh stamp. The stamp
  // moved every ~3 minutes while the reactive refresh was firing on refused
  // extra accounts, and each move re-pushed credentials to both sidecars —
  // tearing the live broker session down each time — although the sidecar
  // may well have held the very token being pushed.
  // No refresh has ever happened → the sidecar holds the only token there is
  // (pushed at boot); nothing to compare yet.
  if (!getState(db, 'ctrader_token_refreshed_at')) return false
  const fp = accessTokenFingerprint(getState(db, 'ctrader_access_token'))
  if (!fp) return false
  let seen = {}
  try { seen = JSON.parse(getState(db, TOKEN_PUSH_KEY) || '{}') } catch { seen = {} }
  if (seen[side.name] === fp) return false
  try {
    const pushed = exec.pushSidecarSession ? await exec.pushSidecarSession(await sideCreds(db, side)) : false
    // Record the stamp on ANY outcome, not only success. A not-ready credential
    // set is not going to become ready because we retried in 2 minutes, and
    // re-pushing every probe forever is the unconditional-re-push shape this
    // file already records as having cost real behaviour once.
    seen[side.name] = fp
    try { setState(db, TOKEN_PUSH_KEY, JSON.stringify(seen)) } catch { /* best effort */ }
    return pushed
  } catch { return false }
}

// Pull the sidecar's decision ring into cpp_decisions (2026-08-31 plan,
// invariant 1). Cursor {bootId, lastSeq} per side in agent_state; INSERT OR
// IGNORE + the UNIQUE(side, boot_id, seq) index make the pull idempotent. A
// bootId change is itself recorded as a synthetic `node/sidecar_restart` row
// — a restart zeroes every in-memory counter, which the inspector must know.
const CPP_DECISIONS_CURSOR_KEY = 'cpp_decisions_cursor_json'
async function pullDecisionsIntoDb(db, exec, side, health) {
  let cursors = {}
  try { cursors = JSON.parse(getState(db, CPP_DECISIONS_CURSOR_KEY) || '{}') } catch { cursors = {} }
  const cur = cursors[side.name] || { bootId: '', lastSeq: 0 }
  const pulled = await exec.pullSidecarDecisions({
    after: cur.bootId === health.bootId ? cur.lastSeq : 0,
    bootId: cur.bootId,
    ...(side.base ? { base: side.base } : {}),
  })
  if (!pulled) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cpp_decisions
       (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  if (cur.bootId && pulled.bootId !== cur.bootId) {
    ins.run(side.name, pulled.bootId, 0, Date.now(), 'node', 'sidecar_restart',
            null, null, '', `previous boot ${cur.bootId} — in-memory counters zeroed`)
    // log-watch.js matches this exact prefix (rule 'sidecar_restart').
    console.log(`[heartbeat] sidecar_restart: ${side.name} — previous boot ${cur.bootId}, new boot ${pulled.bootId}`)
  }
  for (const e of pulled.entries) {
    if (!e || !Number.isFinite(Number(e.seq))) continue
    ins.run(side.name, pulled.bootId, Number(e.seq), Number(e.tsMs) || null,
            String(e.component || 'unknown'), String(e.kind || 'unknown'),
            e.accountId != null ? String(e.accountId) : null,
            Number.isFinite(Number(e.symbolId)) ? Number(e.symbolId) : null,
            e.code != null ? String(e.code).slice(0, 300) : null,
            e.detail != null ? String(e.detail).slice(0, 500) : null)
  }
  cursors[side.name] = { bootId: pulled.bootId, lastSeq: pulled.latestSeq }
  setState(db, CPP_DECISIONS_CURSOR_KEY, JSON.stringify(cursors))
}

// P3a: the tick recorder's status, stored per side under <side>_tick_json
// for GET /state/tick-recorder, with a log line on every state change
// (RECORDING / PAUSED_RESERVE / WARN / OFF / ERROR) and one per ~30 minutes
// while recording, so the spool's growth and the mount's free bytes are on
// record without a token.
export const TICK_STATUS_LOG_EVERY_MS = 30 * 60_000
export async function pullTickStatus(db, exec, side, nowMs = Date.now()) {
  const status = await exec.sidecarTickStatus(side.base ? { base: side.base } : {})
  if (!status) return null
  const key = `${side.name}_tick_json`
  let prev = null
  try { prev = JSON.parse(getState(db, key) || 'null') } catch { prev = null }
  const record = { at: new Date(nowMs).toISOString(), side: side.name, status, lastLoggedAt: prev?.lastLoggedAt ?? null }
  const changed = !prev || prev.status?.state !== status.state || prev.status?.recording !== status.recording
  const due = !record.lastLoggedAt || nowMs - Date.parse(record.lastLoggedAt) >= TICK_STATUS_LOG_EVERY_MS
  if (status.enabled !== false && (changed || (status.recording && due))) {
    const ev = status.events || {}, seg = status.segments || {}, disk = status.disk || {}
    const gb = (n) => (Number(n) / 1e9).toFixed(2)
    console.log(`[tick] ${side.name} recorder ${status.state}${status.recording ? '' : ' (switch off)'}: ${ev.total ?? 0} events (${ev.changed ?? 0} changed, ${ev.dropped ?? 0} dropped, ${ev.gaps ?? 0} gaps), ${seg.sealed ?? 0} segments sealed (${gb(seg.sealedBytes)} GB) + ${gb(seg.openBytes)} GB open, mount ${gb(disk.availBytes)} GB free of ${gb(disk.totalBytes)} GB (${disk.usagePct ?? '?'}% used, reserve ${gb(disk.reserveBytes)} GB)${status.reason ? ` — ${status.reason}` : ''}`)
    record.lastLoggedAt = new Date(nowMs).toISOString()
  }
  try { setState(db, key, JSON.stringify(record)) } catch { /* best effort */ }
  // P3b: one sample per hour into tick_status_samples — the measured
  // events/sec and bytes/day the storage model is judged against.
  try {
    if (status.enabled !== false) {
      const hourMs = Math.floor(nowMs / 3_600_000) * 3_600_000
      const ev = status.events || {}, seg = status.segments || {}, disk = status.disk || {}
      db.prepare(`INSERT OR IGNORE INTO tick_status_samples (side, at_ms, state, recording, events, changed, dropped, gaps, bytes_written, sealed, avail_bytes, symbols, per_symbol)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(side.name, hourMs, String(status.state || ''), status.recording ? 1 : 0, Number(ev.total) || 0, Number(ev.changed) || 0, Number(ev.dropped) || 0, Number(ev.gaps) || 0,
             Number(seg.bytesWritten) || 0, Number(seg.sealed) || 0, Number(disk.availBytes) || 0,
             Array.isArray(status.perSymbol) ? status.perSymbol.length : 0,
             JSON.stringify(Array.isArray(status.perSymbol) ? status.perSymbol.map(p => [p.symbolId, p.events]) : []).slice(0, 8000))
    }
  } catch { /* table absent on an old schema */ }
  return record
}

// P6a: the shadow portfolio's closed trades, pulled per side with a cursor
// (bootId + seq) into tick_shadow_trades — idempotent, restart-aware. The
// per-side summary the sidecar reports (/tick-status.shadowPortfolio) is
// already stored inside <side>_tick_json by pullTickStatus.
export const TICK_SHADOW_CURSOR_KEY = 'tick_shadow_cursor_json'
// P6b: the tick permit feeder (services/tick-permits.js). Pushes only when
// an account on this side is in TICK_MOMENTUM or the sidecar still lists
// one (its /health tick.entry.accounts > 0) — an idle side costs nothing.
let lastTickEntryPush = new Map() // side.name → count pushed
export async function feedTickPermits(db, exec, side, nowMs = Date.now()) {
  const { tickEntryAccountsFor, runTickPermitFeeder, takeTickRepush } = await import('./tick-permits.js')
  const want = tickEntryAccountsFor(db, side)
  let reported = null
  try { reported = JSON.parse(getState(db, `${side.name}_tick_json`) || 'null')?.status?.entry?.accounts ?? null } catch { reported = null }
  // PR-3: a bar fill on an account of this side marks it for a re-push
  // (loop.js markTickRepush); the marks are taken here so the pass runs
  // even when nothing else asks for it.
  const repush = takeTickRepush(want)
  if (!want.length && !(Number(reported) > 0) && !(lastTickEntryPush.get(side.name) > 0) && !repush.length) return null
  const creds = await sideCreds(db, side)
  const r = await runTickPermitFeeder(db, side, { creds, now: nowMs })
  lastTickEntryPush.set(side.name, want.length)
  if (r.pushed) console.warn(`[heartbeat] ${side.name}: tick permits pushed${repush.length ? ` (re-push after a bar fill on ${repush.map(id => `…${id.slice(-4)}`).join(', ')})` : ''} — ${r.accounts.length} account(s) placing [${r.accounts.join(', ')}], ${r.permits} permit(s), ${r.refused.length} refused${r.paused.length ? `, paused ${r.paused.map(p => `${p.accountId} (${p.reason})`).join('; ')}` : ''}`)
  else if (r.error) console.warn(`[heartbeat] ${side.name}: tick permit push FAILED — ${r.error}`)
  for (const x of r.refused.slice(0, 5)) console.warn(`[heartbeat] ${side.name}: tick permit refused ${x.accountId} ${x.symbol}: ${x.reason}`)
  return r
}
export function _resetTickPermitPushForTests() { lastTickEntryPush = new Map() }

export async function pullTickShadow(db, exec, side) {
  let cursors = {}
  try { cursors = JSON.parse(getState(db, TICK_SHADOW_CURSOR_KEY) || '{}') } catch { cursors = {} }
  const cur = cursors[side.name] || { bootId: '', lastSeq: 0 }
  const pulled = await exec.pullSidecarShadow({ after: cur.lastSeq, bootId: cur.bootId, ...(side.base ? { base: side.base } : {}) })
  if (!pulled) return null
  // PR-L: the cost model the sidecar charged this trade rides on the row —
  // cost_class/commission_bps/slippage_bps. A sidecar that predates PR-L
  // sends none and the columns stay NULL, which is the truth about those
  // trades (spread-only), not a gap to fill in with today's schedule.
  const ins = db.prepare(`INSERT OR IGNORE INTO tick_shadow_trades
      (side, boot_id, seq, symbol_id, profile_hash, trade_side, signal_seq, entry_seq, exit_seq, entry, exit, stop, target, stop_distance, reason, hold_events, hold_ms, entry_ms, exit_ms, gross_r, net_r, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let inserted = 0
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  for (const t of pulled.trades) {
    if (!t || !Number.isFinite(Number(t.seq))) continue
    const r = ins.run(side.name, pulled.bootId, Number(t.seq), num(t.symbolId), t.profile != null ? String(t.profile).slice(0, 64) : null, t.side != null ? String(t.side) : null,
      num(t.signalSeq), num(t.entrySeq), num(t.exitSeq), num(t.entry), num(t.exit), num(t.stop), num(t.target), num(t.stopDistance),
      t.reason != null ? String(t.reason).slice(0, 32) : null, num(t.holdEvents), num(t.holdMs), num(t.entryMs), num(t.exitMs), num(t.grossR), num(t.netR),
      t.costClass ? String(t.costClass).slice(0, 32) : null,
      num(t.commissionWirePerSide), num(t.commissionBpsPerSide), num(t.slippageWirePerSide), num(t.slippageBpsPerSide))
    inserted += r.changes
  }
  if (cur.bootId && pulled.bootId !== cur.bootId) {
    // A restart loses every open shadow trade with it. They are written as
    // 'lost_restart' rows (no result) so the evidence counts what vanished
    // instead of pretending it never traded (Statistics auditor, 11-09-2026).
    let lostOpen = 0
    try { lostOpen = Number(JSON.parse(getState(db, `${side.name}_tick_json`) || 'null')?.status?.shadowPortfolio?.open) || 0 } catch { lostOpen = 0 }
    for (let i = 0; i < lostOpen; i++) ins.run(side.name, cur.bootId, 1_000_000_000 + i, null, null, null, null, null, null, null, null, null, null, null, 'lost_restart', null, null, null, Date.now(), null, null, null, null, null, null, null)
    console.log(`[tick] ${side.name} shadow ledger restarted (boot ${cur.bootId} → ${pulled.bootId}); ${pulled.trades.length} trade(s) re-read, ${lostOpen} open trade(s) lost`)
  }
  if (inserted > 0) console.log(`[tick] ${side.name} shadow portfolio: ${inserted} closed trade(s) recorded (ledger seq ${pulled.latestSeq}, ${pulled.total} this boot)`)
  cursors[side.name] = { bootId: pulled.bootId, lastSeq: pulled.latestSeq }
  setState(db, TICK_SHADOW_CURSOR_KEY, JSON.stringify(cursors))
  return { inserted, latestSeq: pulled.latestSeq, bootId: pulled.bootId }
}

/**
 * P3b: the measured rate over the last 24 h per side, from the hourly
 * samples: events/sec, bytes/day at the recorder's 40 B record, and the
 * projection against the plan's 2 GiB spool. Null fields when fewer than
 * two samples exist — a rate from one point is a guess, not a measurement.
 */
export function tickRate24h(db, side, nowMs = Date.now()) {
  let rows = []
  try {
    rows = db.prepare('SELECT at_ms, events, bytes_written, dropped, gaps, symbols FROM tick_status_samples WHERE side = ? AND at_ms >= ? ORDER BY at_ms')
      .all(side, nowMs - 24 * 3_600_000)
  } catch { rows = [] }
  if (rows.length < 2) return { side, samples: rows.length, eventsPerSec: null, bytesPerDay: null, spoolHoursAt2GiB: null, dropped: null, gaps: null }
  // Counters reset on a sidecar restart: sum only the non-negative deltas.
  let events = 0, bytes = 0, dropped = 0, gaps = 0
  for (let i = 1; i < rows.length; i++) {
    const d = (k) => Math.max(0, Number(rows[i][k]) - Number(rows[i - 1][k]))
    events += d('events'); bytes += d('bytes_written'); dropped += d('dropped'); gaps += d('gaps')
  }
  const spanS = Math.max(1, (rows[rows.length - 1].at_ms - rows[0].at_ms) / 1000)
  const eventsPerSec = events / spanS
  const bytesPerDay = (bytes / spanS) * 86_400
  return {
    side, samples: rows.length, spanHours: +(spanS / 3600).toFixed(2), symbols: rows[rows.length - 1].symbols,
    eventsPerSec: +eventsPerSec.toFixed(3), bytesPerDay: Math.round(bytesPerDay),
    spoolHoursAt2GiB: bytesPerDay > 0 ? +((2 * 1024 ** 3) / bytesPerDay * 24).toFixed(1) : null,
    dropped, gaps,
    model: 'docs/tick-momentum/storage-capacity.csv: 20 symbols × 5/20/100 events/s × 96 B = 0.83 / 3.3 / 16.6 GB/day; this recorder writes 40 B per event',
  }
}

// P2b-1: the execution-event journal, pulled the same way into cpp_events.
// The ledger's reconcile settles UNKNOWN intents from it (a late frame
// matched by clientMsgId, or any event whose label carries the intent tag).
const CPP_EVENTS_CURSOR_KEY = 'cpp_events_cursor_json'
export async function pullEventsIntoDb(db, exec, side, health) {
  if (typeof exec?.pullSidecarEvents !== 'function') return
  let cursors = {}
  try { cursors = JSON.parse(getState(db, CPP_EVENTS_CURSOR_KEY) || '{}') } catch { cursors = {} }
  const cur = cursors[side.name] || { bootId: '', lastSeq: 0 }
  const pulled = await exec.pullSidecarEvents({
    after: cur.bootId === health?.bootId ? cur.lastSeq : 0,
    bootId: cur.bootId,
    ...(side.base ? { base: side.base } : {}),
  })
  if (!pulled) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cpp_events
       (side, boot_id, seq, ts_ms, client_msg_id, payload_type, execution_type, order_id, position_id, account_id, symbol_id, error_code, label, solicited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  let inserted = 0
  for (const e of pulled.entries) {
    if (!e || !Number.isFinite(Number(e.seq))) continue
    const r = ins.run(side.name, pulled.bootId, Number(e.seq), Number(e.tsMs) || null,
      e.clientMsgId ? String(e.clientMsgId) : null,
      Number.isFinite(Number(e.payloadType)) ? Number(e.payloadType) : null,
      e.executionType ? String(e.executionType) : null,
      Number(e.orderId) > 0 ? String(e.orderId) : null,
      Number(e.positionId) > 0 ? String(e.positionId) : null,
      Number(e.accountId) > 0 ? String(e.accountId) : null,
      Number(e.symbolId) > 0 ? Number(e.symbolId) : null,
      e.errorCode ? String(e.errorCode).slice(0, 200) : null,
      e.label ? String(e.label).slice(0, 200) : null,
      e.solicited ? 1 : 0)
    inserted += r.changes
  }
  cursors[side.name] = { bootId: pulled.bootId, lastSeq: pulled.latestSeq }
  setState(db, CPP_EVENTS_CURSOR_KEY, JSON.stringify(cursors))
  return { inserted }
}

// Exported for tests: the probe's verdicts (feed staleness, trail-no-feed)
// and the ring pull are pinned against fake exec objects, no sockets.
export async function probeOneSidecar(db, exec, side, deps = {}) {
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
      const drift = rosterDrift(r.accounts, creds.accountIds, r.refusedAccounts)
      // B2: say ONCE, when the set changes, which enabled accounts the token
      // cannot authorise — and keep it where the accounts view can read it.
      try {
        const prev = getState(db, refusedKeyFor(side.name))
        const nowJson = JSON.stringify(drift.refused || [])
        if (prev !== nowJson) {
          setState(db, refusedKeyFor(side.name), nowJson)
          if (drift.refused?.length) {
            console.warn(`[heartbeat] ${side.name}: the broker token does not authorise ${drift.refused.length} enabled account(s) — ${drift.refused.map(a => `…${String(a).slice(-4)}`).join(', ')} — they stay requested, not re-pushed as drift; enable a token that covers them or disable them in the registry`)
          } else if (prev != null) {
            console.warn(`[heartbeat] ${side.name}: every enabled account is authorised again`)
          }
        }
      } catch { /* the note must never fail the probe */ }
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
  // FEED-STALENESS VERDICT (2026-08-31 supervision plan). The sidecar
  // reports feed FACTS (it has no notion of market hours); this side, which
  // does, renders the verdict. A wedged SpotFeed silently freezes the tick
  // trail AND VPO firing — before these checks it was invisible: /health
  // said ok as long as the HTTP thread answered. Both checks are gated on
  // the fields existing, so an older sidecar changes nothing.
  if (ok && r.spotFeed && typeof r.spotFeed === 'object') {
    const FEED_STALE_MS = Math.max(1, Number(process.env.FEED_STALE_MIN) || 10) * 60_000
    let marketOpen = true
    try {
      const { weekendQuietNow } = await import('../lib/quiet-hours.js')
      marketOpen = !weekendQuietNow(nowMs)
    } catch { /* unknown → assume open; a false alarm beats a silent freeze */ }
    const lastTick = Number(r.spotFeed.lastTickAtMs)
    if (marketOpen && Number.isFinite(lastTick) && lastTick > 0 && nowMs - lastTick > FEED_STALE_MS) {
      ok = false
      error = `spot feed silent for ${Math.round((nowMs - lastTick) / 60_000)}m with the market open — tick-trail and VPO are frozen`
    } else if (marketOpen && r.spotFeed.connected === false) {
      ok = false
      error = 'spot feed disconnected with the market open — tick-trail and VPO are frozen'
    }
  } else if (ok && r.spotFeed === null && r.trail && Number(r.trail.tracked) > 0) {
    // Trail engine armed with NO feed object at all: the wedge that stays
    // invisible from inside the process — the ratchet's input simply never
    // arrives, and amendsFailed never even increments.
    ok = false
    error = `trail engine tracks ${r.trail.tracked} position(s) but the spot feed is not running`
  }
  beat(db, side.name, { ok, error, ...(deps.now ? { now: deps.now } : {}) })
  // DECISION-RING PULL (invariant 1's transport): persist the sidecar's
  // decisions durably. Its own try — a failed pull must never fail the beat
  // (it degrades to a stale cursor retried next probe). Older sidecar → the
  // pull returns null and nothing happens.
  try {
    if (r.bootId && exec.pullSidecarDecisions) {
      await pullDecisionsIntoDb(db, exec, side, r)
      try { await pullEventsIntoDb(db, exec, side, r) } catch (err) { console.warn(`[heartbeat] events pull failed (${side.name}): ${err.message}`) }
    }
  } catch { /* next probe retries from the stored cursor */ }
  // GUARD SYNC (declarative convergence): only against a CONNECTED sidecar
  // that reported its guard — pushing at an older sidecar (guard:null) would
  // push blind on every probe forever.
  // A FAILED push is stamped, a clean pass clears it. syncExecGuard never
  // throws, so until 02-09-2026 a sidecar refusing the halt push on every
  // probe looked exactly like one that had converged — the guard "on", the
  // halt not bound, nothing anywhere saying so. /state/heartbeats reads it.
  const stampGuardSync = (error) => {
    try {
      setState(db, EXEC_GUARD_SYNC_ERROR_KEY, error == null
        ? null
        : JSON.stringify({ at: new Date(nowMs).toISOString(), side: side.name, error: String(error).slice(0, 500) }))
    } catch { /* state unwritable — the probe still beats */ }
  }
  try {
    if (r.connected === true && r.guard && typeof r.guard === 'object') {
      const { syncExecGuard } = await import('./exec-guard-sync.js')
      const sync = await syncExecGuard(db, exec, side, {
        reportedGuard: r.guard,
        reportedTick: r.tick ?? null, // P3a: the recorder's switch and subscription converge on the same push
        creds: await sideCreds(db, side),
        now: nowMs,
      })
      if (sync.pushed) {
        console.warn(`[heartbeat] ${side.name}: exec guard converged — halt=${sync.desired.halt} haltAccounts=[${sync.desired.haltAccounts.join(', ')}]${sync.desired.tickRecord ? ` tickRecord=true tickSymbolIds=[${(sync.desired.tickSymbolIds || []).join(', ')}] quoteSymbolIds=[${(sync.desired.quoteSymbolIds || []).join(', ')}]` : ''}`)
      }
      if (sync.error) console.warn(`[heartbeat] ${side.name}: exec guard push FAILED — ${sync.error}`)
      stampGuardSync(sync.error ?? null)
    }
  } catch (err) {
    // Guard convergence retries next probe — and the failure is on record.
    stampGuardSync(err?.message || String(err))
  }
  // P3a TICK RECORDER PULL: the recorder's full status (GET /tick-status)
  // is stored per side and a STATE CHANGE is logged — the Railway log is the
  // owner's read-back path while the bearer token is lost. Gated on the
  // sidecar reporting a `tick` object at all: an older sidecar, or one with
  // no TICK_SPOOL_PATH, changes nothing here.
  try {
    if (r.ok !== undefined && r.tick && typeof r.tick === 'object' && typeof exec.sidecarTickStatus === 'function') {
      await pullTickStatus(db, exec, side, nowMs)
      // P6a: the shadow portfolio's closed trades ride the same probe.
      if (typeof exec.pullSidecarShadow === 'function') {
        try { await pullTickShadow(db, exec, side) } catch (err) { console.warn(`[heartbeat] tick shadow pull failed (${side.name}): ${err.message}`) }
      }
      // P6b: the tick permit feeder rides the same probe — standing permits
      // for every TICK_MOMENTUM account on this side (none today), refreshed
      // well inside their 5-minute life; a push happens only when there is
      // an account to place for or a set to clear.
      try { await feedTickPermits(db, exec, side, nowMs) } catch (err) { console.warn(`[heartbeat] tick permit feeder failed (${side.name}): ${err.message}`) }
    }
  } catch { /* next probe retries */ }
  // Persist what the probe learned so a READ route never has to call the
  // sidecar itself. This probe already runs every ~2 minutes; making
  // /state/account-engineering re-fetch /health on every page load would put an
  // external HTTP hop inside a cached GET, which is exactly the shape of the
  // slow read routes already on the backlog. Stamped with the observation time
  // so the UI can say "as of 2 min ago" instead of implying it is live.
  try {
    setState(db, healthKeyFor(side.name), JSON.stringify({
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : null,
      refusedAccounts: Array.isArray(r.refusedAccounts) ? r.refusedAccounts.map(String) : null,
      connected: r.connected ?? null,
      hasCredentials: r.hasCredentials ?? null,
      lastReconcileAt: r.lastReconcileAt ?? null,
      // Feed/guard truth (2026-08-31): persisted so read routes and the log
      // inspector see what the probe saw without an HTTP hop. null = the
      // sidecar did not report it (older build), never a verdict.
      spotFeed: r.spotFeed ?? null,
      trail: r.trail ?? null,
      vpo: r.vpo ?? null,
      guard: r.guard ?? null,
      // Peer triangulation (PR-B): probe failed but the PEER reports this
      // sidecar ok → suspect the Node→sidecar path, not the sidecar. The
      // inspector reads this from the snapshot; no verdict is rendered here.
      peer: r.peer ?? null,
      bootId: r.bootId ?? null,
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
