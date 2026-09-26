// ---------------------------------------------------------------------------
// agent/services/p1p4-grade.js — the P1/P4 acceptance GRADER (V3 M3, P1/P4-3).
// Pure: no database, no network, no clock. The harness
// (scripts/v3-p1p4-acceptance.mjs) samples production GET-only and writes
// compact JSONL; this module turns those samples into Passed / Failed /
// Not Verifiable per criterion. The goal table (goal-table.js) reads its
// proposed limits from here so the two can never disagree.
//
// THE RULES IT ENFORCES (V3-SEQUENCE §1 item 17, the P1/P4 review):
//   · Every limit here is PROPOSED until the owner confirms it (closure:205,
//     H-P1-1). The grade says which: `limits: 'proposed'` is never acceptance.
//   · Grading uses RAW timestamps — the boot record's sinceBootMs, the audit's
//     `at`, the verifier's checkedAtMs, the fast monitor's lastCompletedAt —
//     and never a heartbeat verdict, because heartbeat.js (BOOT_GRACE_SEC, :406-422) suppresses stall
//     verdicts for the first 300 s after every boot, exactly the window graded.
//   · A Failed observation stays Failed: a later good sample never erases it
//     (closure:196-198). Combining is F > NV > P.
//   · Absent or stale data grades Not Verifiable, never Passed.
//   · A window with no visible browser tab (/health clients.visibleTabs 0)
//     is not representative: its Passed become Not Verifiable; Failed stay.
//   · Platform gateway errors (Railway's "Application failed to respond",
//     or no answer at all while the container swaps) are classified apart
//     from the application's own 5xx and never counted as an app failure.
//   · Recovery compares the pre-release snapshot PLUS changes attributable to
//     position_events (the cockpit journal, which carries the native trail
//     engine's polled amends), action_log rows (manual and automatic
//     entry-configuration changes are written there — ENTRY_CONFIG_ACTION_PATH
//     names every writer), and nothing else. A difference
//     the evidence does not explain is Failed when the evidence was read, and
//     Not Verifiable when it could not be.
// ---------------------------------------------------------------------------

import { LAG_BUCKET_EDGES_MS } from './event-loop-lag.js'

export const PASSED = 'Passed'
export const FAILED = 'Failed'
export const NOT_VERIFIABLE = 'Not Verifiable'

/**
 * The action_log paths that explain a change to an account's entry
 * configuration (mode, requested mode, revision, epoch, policy) across a
 * restart. Every writer of the entry-engine row, by the path it logs
 * (re-anchored 25-09 on main 87620f3):
 *   · entry-mode.js requestEntryMode, requestAdmittedBases → /actions/entry-mode
 *   · entry-mode.js requestEntryModePolicy (and the boot seed
 *     seedEntryModePolicyFromConfig) → /actions/entry-mode-policy
 *   · entry-mode.js acknowledgeEntryEpochs, markEntryModeBlocked →
 *     /entry-mode/ack, /entry-mode/blocked; entry-drain.js → /entry-mode/drain
 *   · entry-mode.js requestTickObservation (and the boot seed
 *     seedTickObservationFromConfig, which runs whenever
 *     config/tick-observation.json changes — i.e. at the very restart a
 *     merge of that file causes) → /actions/tick-observation
 *   · tick-validation.js importTickValidation → /actions/tick-validation
 * The last two raise configRevision without an entry-mode path; a regex
 * that matched only /entry-mode/ graded their revision bump "unexplained"
 * with the explaining row in hand (checker, 25-09).
 */
export const ENTRY_CONFIG_ACTION_PATH = /entry-mode|tick-observation|tick-validation/

/**
 * The proposed limits (owner to confirm or replace, H-P1-1 / H-P1-2). A null
 * is a limit the owner has to SET — there is no proposal to grade against,
 * so the criterion reports its value and grades Not Verifiable.
 */
export const P1P4_PROPOSED_LIMITS = Object.freeze({
  startupWindowMin: 15,          // BOOT → BOOT + 15 min (boot-clock.js)
  listeningMaxSec: 15,           // HTTP listening within 15 s of BOOT
  lagMaxMs: 5000,                // event-loop lag max strictly under 5,000 ms
  lagP99MaxMs: 1000,             // p99 strictly under 1,000 ms, shown by the histogram bound (p99Below)
  critical5xxMax: 0,             // /health, heartbeats, manifest, account and protection routes
  report5xxMax: null,            // H-P1-2: whether any report 5xx are tolerated
  recoverySec: 300,              // BOOT → BOOT + 300 s (heartbeat.js BOOT_GRACE_SEC)
  firstLoopMaxSec: null,         // the owner's bar; 60 s is only a proposal (closure:62)
  firstProtectionMaxSec: null,   // X for the first slow monitor, equity stop and breakers
  fastMonitorGraceSec: 60,       // first evaluation after boot within cadence + 60 s
  steadyMinHours: 2,             // a steady window of at least 2 h after the startup window
  mainLoopP95MaxSec: 60,
  fastMonitorSkipMaxPct: 10,     // the goal table's existing Wave 5 default (not owner-agreed)
  tickMaxMs: 6000,               // two 3 s cadences
  bandMaxMs: 60000,              // the protection band never overruns its 60 s cadence
  budgetOverrunsMax: 0,          // protection budget overruns per 10 min
  independentAgeMaxSec: 120,     // 2 × the verifier's 60 s reconcile cycle
  auditAgeMaxSec: 120,           // Node protection audit age
})

/** goal_table_json.targets key for a limit: startupWindowMin → p1p4StartupWindowMin. */
export function p1p4TargetKey(limit) {
  if (limit === 'fastMonitorSkipMaxPct') return 'fastMonitorSkipMaxPct' // the existing goal-table key
  return `p1p4${limit[0].toUpperCase()}${limit.slice(1)}`
}

/** The owner's confirmation stamp in goal_table_json.targets ('' = not confirmed). */
export const P1P4_CONFIRMED_KEY = 'p1p4LimitsConfirmedAt'

/** The goal-table target defaults these limits contribute (fastMonitorSkipMaxPct is already there). */
export function p1p4TargetDefaults() {
  const out = {}
  for (const [k, v] of Object.entries(P1P4_PROPOSED_LIMITS)) {
    if (k === 'fastMonitorSkipMaxPct') continue
    out[p1p4TargetKey(k)] = v
  }
  out[P1P4_CONFIRMED_KEY] = ''
  return out
}

/**
 * Limits from goal-table targets (the stored, owner-patched ones when present),
 * each falling back to the proposal. `confirmed` is true only when the owner
 * has stamped p1p4LimitsConfirmedAt with a date. Pure.
 */
export function p1p4LimitsFromTargets(targets) {
  const t = targets && typeof targets === 'object' ? targets : {}
  const limits = {}
  for (const [k, v] of Object.entries(P1P4_PROPOSED_LIMITS)) {
    const raw = t[p1p4TargetKey(k)]
    // Number(null) is 0 and Number(true) is 1: neither may become a limit.
    limits[k] = raw === null || raw === undefined || raw === '' || typeof raw === 'boolean' || !Number.isFinite(Number(raw)) ? v : Number(raw)
  }
  const stamp = t[P1P4_CONFIRMED_KEY]
  const confirmedAt = typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) ? stamp : null
  return { limits, confirmed: confirmedAt != null, confirmedAt }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Epoch ms from a number, an ISO string, or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC). Null when unreadable. */
export function toMs(x) {
  if (x == null || x === '') return null
  if (typeof x === 'number') return Number.isFinite(x) && x > 0 ? x : null
  const s = String(x)
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : null
}

const num = (x) => (x == null || x === '' || typeof x === 'boolean' || !Number.isFinite(Number(x)) ? null : Number(x))

/** Nearest-rank percentile of an ascending list; null when empty. */
export function percentileOf(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

/**
 * A p99 UPPER BOUND against the strict limit "p99 < limit" (H-P1-1; the
 * acceptance doc §6). The lag tap's percentile is the upper edge of the
 * histogram bucket holding the rank, capped at the observed max
 * (event-loop-lag.js histogramPercentileLe), so p99 lies in (lower edge,
 * bound]. The bound shows p99 < limit only when it is itself under the
 * limit, and shows p99 ≥ limit only when the bucket's lower edge is at or
 * above it. Between the two — a bound of exactly 1,000 ms against 1,000 —
 * the histogram cannot say: 'unknown', never a pass and never a failure.
 * Returns 'pass' | 'fail' | 'unknown', or null with no bound or no limit. Pure.
 */
export function p99Below(boundMs, limitMs, edges = LAG_BUCKET_EDGES_MS) {
  const b = num(boundMs)
  const lim = num(limitMs)
  if (b == null || lim == null) return null
  if (b < lim) return 'pass'
  const lower = edges.reduce((m, e) => (e < b && e > m ? e : m), 0)
  return lower >= lim ? 'fail' : 'unknown'
}

/** The reason line for an 'unknown' p99Below. */
export function p99Unknown(boundMs, limitMs) {
  return `the histogram bound (99 % of probes at most ${boundMs} ms) cannot show p99 < ${limitMs} ms — its bucket reaches the limit`
}

/** Failed wins over Not Verifiable wins over Passed; an empty list is Not Verifiable. */
export function combineVerdicts(verdicts) {
  if (verdicts.some(v => v === FAILED)) return FAILED
  if (verdicts.length && verdicts.every(v => v === PASSED)) return PASSED
  return NOT_VERIFIABLE
}

function crit(id, verdict, { value = null, limit = null, reason = null, detail = null, at = null } = {}) {
  return { id, verdict, value, limit, reason, ...(at ? { at } : {}), ...(detail != null ? { detail } : {}) }
}

/** A non-representative window cannot Pass; a Failed observation stays Failed. */
function unrepresentative(c, why) {
  if (c.verdict !== PASSED) return c
  return { ...c, verdict: NOT_VERIFIABLE, reason: `${why} — the reading met the limit, but the window is not representative` }
}

// ---------------------------------------------------------------------------
// Route classes. CRITICAL routes must not 5xx at all (proposed 0): the ones a
// protection reader or the Desk's account/protection panes depend on. Every
// other 5xx is a REPORT-class failure, counted and listed; whether any are
// tolerated is the owner's decision (H-P1-2).
// ---------------------------------------------------------------------------
// Every name below is a route state.js serves today (route-timing.js keys a
// matched request as mount + route pattern, e.g. /state/position/:id/cockpit).
const CRITICAL_ROUTES = [
  /^\/health$/,
  /^\/state\/(heartbeats|runtime-manifest|protection-audit|entry-engines|accounts|account-overview|account-money|account-phases|account-settings|account-capabilities|account-chrome|positions)$/,
  /^\/state\/position\/[^/]+(\/cockpit)?$/,
]

/** 'critical' | 'report' for a route key (route-timing.js keys: mount + pattern). */
export function routeClass(route) {
  const r = String(route || '')
  return CRITICAL_ROUTES.some(re => re.test(r)) ? 'critical' : 'report'
}

/**
 * Classify one of the harness's own requests. `platform` is the gateway
 * answering for the application (Railway's JSON 502 "Application failed to
 * respond", a non-JSON 5xx page, or a connection that failed outright);
 * `app_5xx` is the application's own 5xx with its JSON error body.
 * `timeout` is the harness's own deadline passing with no answer: it is NOT
 * called platform, because a main thread blocked past the deadline looks
 * exactly like this, and filing it as a gateway error would hide an
 * application stall. It is listed apart and never counted as a pass.
 */
export function classifyResponse({ status = null, bodyText = '', error = null, timedOut = false } = {}) {
  if (timedOut) return 'timeout'
  if (error || status == null) return 'platform'
  const s = Number(status)
  if (s >= 200 && s < 300) return 'ok'
  if (s === 401 || s === 403) return 'auth'
  if (s >= 500 && s < 600) {
    const text = String(bodyText || '')
    if (/Application failed to respond/i.test(text)) return 'platform'
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object') return 'platform'
    return 'app_5xx'
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Compaction. The raw bodies are large (/state/heartbeats is ~300 KB, almost
// all of it the watchdog's incident map); a sample keeps only what a
// criterion reads. No secret-shaped field is copied, and no tab identity
// (id, session, ip, timezone) — only counts and page names.
// ---------------------------------------------------------------------------

function firstStamp(f) {
  if (!f || typeof f !== 'object') return null
  const out = { sinceBootMs: num(f.sinceBootMs), at: f.at ?? null }
  for (const k of ['ok', 'ms', 'overran', 'accounts', 'errors', 'unauditable', 'positions', 'completed', 'checked', 'error']) {
    if (f[k] !== undefined) out[k] = typeof f[k] === 'string' ? f[k].slice(0, 120) : f[k]
  }
  return out
}

function lagWindow(w) {
  if (!w || typeof w !== 'object') return null
  return { n: num(w.n), maxMs: num(w.maxMs), p95LeMs: num(w.p95LeMs), p99LeMs: num(w.p99LeMs), coveredFrom: w.coveredFrom ?? null, worst: w.worst ? { ms: num(w.worst.ms), at: w.worst.at ?? null, loopPhase: w.worst.loopPhase ?? null } : null }
}

/** Compact an authenticated /health body. */
export function compactHealth(body) {
  if (!body || typeof body !== 'object') return null
  const cur = body.bootRecord?.current
  const lw = body.latencyWindows
  const fm = body.fastMonitor
  const cl = body.clients
  return {
    uptimeSec: num(body.uptime),
    commit: body.commit ?? null,
    status: body.status ?? null,
    authenticated: body.authenticated === true,
    loopCount: num(body.loopCount),
    lastLoopMs: num(body.lastLoopMs),
    loopPhase: typeof body.loopPhase === 'string' ? body.loopPhase.slice(0, 60) : null,
    fm: fm ? { at: fm.at ?? null, everyMs: num(fm.everyMs), lastMs: num(fm.lastMs), max10mMs: num(fm.max10mMs), skipShare10m: num(fm.skipShare10m), busyShare10m: num(fm.busyShare10m) } : null,
    boot: cur ? {
      bootId: cur.bootId ?? null,
      bootAt: cur.bootAt ?? null,
      commit: cur.commit ?? null,
      startupWindowMs: num(cur.startupWindowMs),
      listeningMs: num(cur.listening?.sinceBootMs),
      dbOpenedMs: num(cur.db?.openedSinceBootMs),
      startupLag: cur.startupLag ? { ms: num(cur.startupLag.ms), at: cur.startupLag.at ?? null, loopPhase: cur.startupLag.loopPhase ?? null } : null,
      http: cur.startupHttp ? {
        complete: cur.startupHttp.complete === true,
        total: cur.startupHttp.total ?? null,
        first5xx: cur.startupHttp.first5xx ?? null,
        routes: (Array.isArray(cur.startupHttp.routes) ? cur.startupHttp.routes : []).slice(0, 20).map(r => ({ route: String(r.route ?? ''), '4xx': num(r['4xx']) ?? 0, '5xx': num(r['5xx']) ?? 0, aborted: num(r.aborted) ?? 0 })),
      } : null,
      first: Object.fromEntries(Object.entries(cur.first || {}).map(([k, v]) => [k, firstStamp(v)])),
    } : null,
    prevBoot: body.bootRecord?.previous ? { bootId: body.bootRecord.previous.bootId ?? null, bootAt: body.bootRecord.previous.bootAt ?? null, commit: body.bootRecord.previous.commit ?? null } : null,
    lat: lw ? {
      mainLoop: lw.mainLoop ? { n: num(lw.mainLoop.n), p50: num(lw.mainLoop.p50), p95: num(lw.mainLoop.p95), p99: num(lw.mainLoop.p99), max: num(lw.mainLoop.max), from: lw.mainLoop.from ?? null } : null,
      lag10m: lagWindow(lw.eventLoopLag?.last10m),
      lagStart: lagWindow(lw.eventLoopLag?.sinceStart),
      overruns10m: num(lw.budgetOverruns?.total10m),
      overrunsByName10m: lw.budgetOverruns?.byName10m ?? null,
    } : null,
    // The owner's tabs only (NEW-1): /health's openTabs/visibleTabs already
    // exclude harness loads, and the visible-page list drops the rows tagged
    // `synthetic`, so a trace run cannot make a window representative. The
    // harness count rides beside them when the build reports it.
    tabs: cl ? {
      open: num(cl.openTabs),
      visible: num(cl.visibleTabs),
      pages: [...new Set((Array.isArray(cl.tabs) ? cl.tabs : []).filter(t => t && t.status === 'active' && !t.synthetic).map(t => String(t.page ?? '').slice(0, 40)))].slice(0, 10),
      ...(cl.synthetic && typeof cl.synthetic === 'object' ? { synthetic: { open: num(cl.synthetic.openTabs), visible: num(cl.synthetic.visibleTabs) } } : {}),
    } : null,
  }
}

/** Compact an authenticated /state/heartbeats body: runtime.accounts, the band, the fast monitor's receipts. */
export function compactHeartbeats(body) {
  const rt = body?.runtime
  if (!rt || typeof rt !== 'object') return null
  // Only ENABLED accounts are graded (a disabled account is not audited by
  // design); they are named apart so their absence is visible. A row with no
  // `enabled` field (an older build) counts as enabled.
  const all = Array.isArray(rt.accounts) ? rt.accounts : []
  const disabled = all.filter(a => a.enabled === false).map(a => String(a.accountId ?? ''))
  const accounts = all.filter(a => a.enabled !== false).map(a => {
    const ind = a.independentProtection || {}
    return {
      id: String(a.accountId ?? ''),
      env: a.environment ?? null,
      mode: a.entryMode ?? null,
      counts: a.entryCounts ? { unsent: num(a.entryCounts.unsent), inFlight: num(a.entryCounts.inFlight), unknown: num(a.entryCounts.unknown) } : null,
      audit: a.protection ? { at: a.protection.at ?? null, checked: num(a.protection.checked) } : null,
      ind: { at: num(ind.checkedAtMs), open: num(ind.openCount), missingSl: num(ind.missingSl), missingTp: num(ind.missingTp), error: ind.error ? String(ind.error).slice(0, 120) : null },
      pos: (Array.isArray(ind.positions) ? ind.positions : []).slice(0, 60).map(p => [String(p.positionId ?? ''), num(p.stopLoss), num(p.takeProfit)]),
    }
  })
  const band = rt.monitor?.band
  const work = rt.managementWork
  return {
    at: rt.at ?? null,
    accounts,
    ...(disabled.length ? { disabled } : {}),
    band: band ? { lastMs: num(band.lastMs), max10mMs: num(band.max10mMs), overran: band.overran === true, skippedBands: num(band.skippedBands) } : null,
    work: work && Array.isArray(work.positions) ? {
      at: work.at ?? null,
      positions: work.positions.slice(0, 80).map(p => ({ a: String(p.accountId ?? ''), id: String(p.positionId ?? ''), b: p.brokerPositionId == null ? null : String(p.brokerPositionId), owner: p.owner ?? null, done: p.lastCompletedAt ?? null, due: p.nextDueAt ?? null, state: p.state ?? null, cad: num(p.cadenceMs) })),
    } : null,
  }
}

/** Compact /state/entry-engines: mode, revision, epoch and policy per account. */
export function compactEntryEngines(body) {
  if (!body || !Array.isArray(body.accounts)) return null
  return {
    at: body.at ?? null,
    accounts: body.accounts.map(a => ({
      id: String(a.routingAccountId ?? a.accountId ?? ''),
      mode: a.effectiveEntryMode ?? null, req: a.requestedEntryMode ?? null,
      rev: num(a.configRevision), epoch: num(a.modeEpoch), policy: a.entryModePolicy ?? null,
      transition: a.transitionState ?? null,
      counts: a.entryCounts ? { unsent: num(a.entryCounts.unsent), inFlight: num(a.entryCounts.inFlight), unknown: num(a.entryCounts.unknown) } : null,
    })),
  }
}

/** Compact /state/goal-table: the targets (limits and confirmation) and the rows' verdicts. */
export function compactGoalTable(body) {
  if (!body || !Array.isArray(body.goals)) return null
  const targets = {}
  for (const [k, v] of Object.entries(body.targets || {})) if (k.startsWith('p1p4') || k === 'fastMonitorSkipMaxPct') targets[k] = v
  return {
    at: body.at ?? null,
    targets,
    summary: body.summary ?? null,
    goals: body.goals.map(g => ({ id: g.id, verdict: g.verdict, proposedVerdict: g.proposedVerdict ?? null, current: g.current ?? null })),
  }
}

/** Compact GET /actions/goal-table (targets only, no table computed — 0.28 s on 25-09). */
export function compactGoalTargets(body) {
  if (!body || typeof body.targets !== 'object' || body.targets == null) return null
  const targets = {}
  for (const [k, v] of Object.entries(body.targets)) if (k.startsWith('p1p4') || k === 'fastMonitorSkipMaxPct') targets[k] = v
  return { targets }
}

/** Compact /state/route-timings: status totals and every route that answered 5xx or aborted. */
export function compactRouteTimings(body) {
  if (!body || !Array.isArray(body.routes)) return null
  return {
    statusTotals: body.statusTotals ?? null,
    overflowRequests: num(body.overflowRequests),
    routes: body.routes.filter(r => r?.status && (Number(r.status['5xx']) > 0 || Number(r.status.aborted) > 0))
      .slice(0, 60).map(r => ({ route: String(r.route), n: num(r.requests), '5xx': num(r.status['5xx']) ?? 0, aborted: num(r.status.aborted) ?? 0, last5xx: r.last5xx ?? null })),
  }
}

/** Compact /state/runtime-manifest: the Node commit and the two sidecars' boot ids. */
export function compactManifest(body) {
  if (!body || !Array.isArray(body.items)) return null
  const v = (k) => body.items.find(i => i?.key === k)?.value ?? null
  return { nodeCommit: v('node.commit'), demoBootId: v('sidecar.demo.bootId'), liveBootId: v('sidecar.live.bootId') }
}

// ---------------------------------------------------------------------------
// Boots. A restart is an uptime reset, a commit change or a boot-record
// change between consecutive /health samples.
// ---------------------------------------------------------------------------

function sampleBootAt(s) {
  const d = s.data
  return toMs(d?.boot?.bootAt) ?? (num(d?.uptimeSec) != null ? s.t - d.uptimeSec * 1000 : null)
}

/** Split the samples into boots. Each boot keeps its health samples and the window it owns. */
export function splitBoots(samples) {
  const health = samples.filter(s => s.kind === 'health' && s.data).sort((a, b) => a.t - b.t)
  const boots = []
  let prev = null
  for (const s of health) {
    const d = s.data
    const reasons = []
    if (prev) {
      const p = prev.data
      if (num(d.uptimeSec) != null && num(p.uptimeSec) != null && d.uptimeSec < p.uptimeSec) reasons.push('uptime reset')
      if (d.commit && p.commit && d.commit !== p.commit) reasons.push('commit changed')
      if (d.boot?.bootId && p.boot?.bootId && d.boot.bootId !== p.boot.bootId) reasons.push('boot record changed')
    }
    if (!boots.length || reasons.length) {
      boots.push({ index: boots.length, bootAtMs: sampleBootAt(s), bootId: d.boot?.bootId ?? null, commit: d.commit ?? null, firstT: s.t, lastT: s.t, restartObserved: reasons.length > 0, reasons, health: [] })
    }
    const b = boots[boots.length - 1]
    b.lastT = s.t
    if (b.bootAtMs == null) b.bootAtMs = sampleBootAt(s)
    if (!b.bootId && d.boot?.bootId) b.bootId = d.boot.bootId
    b.health.push(s)
    prev = s
  }
  // The window each boot owns: from its BOOT (or first sample) to the next boot's.
  for (let i = 0; i < boots.length; i++) {
    const b = boots[i]
    b.fromMs = b.bootAtMs ?? b.firstT
    b.toMs = i + 1 < boots.length ? (boots[i + 1].bootAtMs ?? boots[i + 1].firstT) : Infinity
  }
  return boots
}

const inBoot = (b) => (s) => s.t >= b.fromMs && s.t < b.toMs

function representativeOf(healthSamples) {
  const withTabs = healthSamples.filter(s => s.data?.tabs && num(s.data.tabs.visible) != null)
  const visible = withTabs.filter(s => s.data.tabs.visible > 0)
  const pages = [...new Set(visible.flatMap(s => s.data.tabs.pages || []))]
  return {
    // The rule as written (V3-SEQUENCE item 17): a window in which no sample
    // saw a visible tab is not representative. Which pages were visible is
    // reported beside it; whether the Desk AND Performance must both be
    // visible (the load-window plan's wording) is the owner's call.
    representative: visible.length > 0,
    visibleShare: withTabs.length ? Math.round((visible.length / withTabs.length) * 1000) / 10 : null,
    samples: withTabs.length,
    pages,
    deskVisible: pages.some(p => /^\/desk(\/|$)/.test(p)),
    performanceVisible: pages.some(p => /^\/performance(\/|$)/.test(p)),
  }
}

// ---------------------------------------------------------------------------
// Startup window (BOOT → BOOT + 15 min), from the boot record: raw sinceBootMs.
// ---------------------------------------------------------------------------

/**
 * When the next restart came before `ms` after this boot's BOOT, the reason a
 * reading of this boot stays partial for good; null while the boot is live or
 * lasted past `ms`. A boot that ended early is not "still open" — the next
 * merge replaced it (25-09 22:08–22:10Z: three Node boots in 14 minutes) —
 * and its partial reading is never a pass. Pure.
 */
export function endedBefore(boot, ms) {
  if (boot?.bootAtMs == null || !Number.isFinite(boot.toMs) || boot.toMs >= boot.bootAtMs + ms) return null
  return `the boot ended at +${Math.round((boot.toMs - boot.bootAtMs) / 1000)} s (the next restart), before BOOT + ${Math.round(ms / 1000)} s — a partial reading, never a pass`
}

/** Grade one boot's startup window. `ownRequests` are the harness's own request records. */
export function gradeStartup(boot, limits, { ownRequests = [] } = {}) {
  const windowMs = limits.startupWindowMin * 60_000
  const recoveryMs = limits.recoverySec * 1000
  const withRecord = boot.health.filter(s => s.data.boot)
  const latest = withRecord[withRecord.length - 1] || null
  const rec = latest?.data.boot || null
  const sinceBoot = (s) => (boot.bootAtMs != null ? s.t - boot.bootAtMs : null)
  const latestSince = latest ? sinceBoot(latest) : null
  const windowDone = latestSince != null && latestSince >= windowMs
  const recoveryDone = latestSince != null && latestSince >= recoveryMs
  const out = []
  const noRecord = 'no boot record on /health (V3 M1 not deployed, or /health read without the read token)'
  const partialReading = endedBefore(boot, windowMs) ?? 'the startup window is still open (partial reading)'
  const partialCounts = endedBefore(boot, windowMs) ?? 'the startup window is still open (partial counts)'
  const notYet = endedBefore(boot, recoveryMs) ?? 'not yet'

  // Listening.
  if (!rec) out.push(crit('startup.listening', NOT_VERIFIABLE, { limit: limits.listeningMaxSec * 1000, reason: noRecord }))
  else if (rec.listeningMs == null) out.push(crit('startup.listening', NOT_VERIFIABLE, { limit: limits.listeningMaxSec * 1000, reason: 'listening not stamped' }))
  else out.push(crit('startup.listening', rec.listeningMs <= limits.listeningMaxSec * 1000 ? PASSED : FAILED, { value: rec.listeningMs, limit: limits.listeningMaxSec * 1000 }))

  // Worst stall in the window (the tap's startup worst covers the whole window).
  if (!rec) out.push(crit('startup.lag_max', NOT_VERIFIABLE, { limit: limits.lagMaxMs, reason: noRecord }))
  else {
    const worst = num(rec.startupLag?.ms)
    if (worst != null && worst >= limits.lagMaxMs) out.push(crit('startup.lag_max', FAILED, { value: worst, limit: limits.lagMaxMs, at: rec.startupLag.at, detail: { loopPhase: rec.startupLag.loopPhase, harnessOverlap: harnessOverlap([rec.startupLag.at], ownRequests) } }))
    else if (!windowDone) out.push(crit('startup.lag_max', NOT_VERIFIABLE, { value: worst, limit: limits.lagMaxMs, reason: partialReading }))
    else if (worst == null) out.push(crit('startup.lag_max', NOT_VERIFIABLE, { limit: limits.lagMaxMs, reason: 'no probe recorded in the startup window' }))
    else out.push(crit('startup.lag_max', PASSED, { value: worst, limit: limits.lagMaxMs }))
  }

  // p99 over the window: the tap's since-start histogram from the last sample
  // taken inside the window, when that sample covers nearly all of it.
  {
    const inWindow = withRecord.filter(s => { const d = sinceBoot(s); return d != null && d <= windowMs && s.data.lat?.lagStart?.n })
    const last = inWindow[inWindow.length - 1]
    const covered = last ? sinceBoot(last) : null
    if (!last) out.push(crit('startup.lag_p99', NOT_VERIFIABLE, { limit: limits.lagP99MaxMs, reason: 'no /health sample with the lag tap inside the startup window' }))
    else if (covered < windowMs - 90_000) out.push(crit('startup.lag_p99', NOT_VERIFIABLE, { value: last.data.lat.lagStart.p99LeMs, limit: limits.lagP99MaxMs, reason: `the last in-window sample covers ${Math.round(covered / 1000)} s of ${windowMs / 1000} s` }))
    else {
      const p99 = num(last.data.lat.lagStart.p99LeMs)
      const v = p99Below(p99, limits.lagP99MaxMs)
      out.push(crit('startup.lag_p99', v === 'pass' ? PASSED : v === 'fail' ? FAILED : NOT_VERIFIABLE, {
        value: p99, limit: limits.lagP99MaxMs,
        reason: p99 == null ? 'no percentile' : v === 'unknown' ? p99Unknown(p99, limits.lagP99MaxMs) : 'a histogram upper bound',
      }))
    }
  }

  // 5xx by route class: the application's own startup record, plus the
  // harness's own requests inside the window (app 5xx only; platform apart).
  {
    const own = ownRequests.filter(r => boot.bootAtMs != null && r.t >= boot.bootAtMs && r.t <= boot.bootAtMs + windowMs && r.cls === 'app_5xx')
    const byRoute = {}
    for (const r of rec?.http?.routes || []) if (r['5xx'] > 0) byRoute[r.route] = (byRoute[r.route] || 0) + r['5xx']
    const ownByRoute = {}
    for (const r of own) ownByRoute[r.route] = (ownByRoute[r.route] || 0) + 1
    for (const [k, n] of Object.entries(ownByRoute)) byRoute[k] = Math.max(byRoute[k] || 0, n)
    const critical = Object.entries(byRoute).filter(([r]) => routeClass(r) === 'critical')
    const report = Object.entries(byRoute).filter(([r]) => routeClass(r) === 'report')
    const critN = critical.reduce((a, [, n]) => a + n, 0)
    const repN = report.reduce((a, [, n]) => a + n, 0)
    const complete = rec?.http?.complete === true
    if (!rec?.http && !own.length) {
      out.push(crit('startup.critical_5xx', NOT_VERIFIABLE, { limit: limits.critical5xxMax, reason: noRecord }))
      out.push(crit('startup.report_5xx', NOT_VERIFIABLE, { limit: limits.report5xxMax, reason: noRecord }))
    } else {
      out.push(crit('startup.critical_5xx', critN > limits.critical5xxMax ? FAILED : complete ? PASSED : NOT_VERIFIABLE, {
        value: critN, limit: limits.critical5xxMax, detail: Object.fromEntries(critical),
        reason: critN > limits.critical5xxMax ? null : complete ? null : partialCounts,
      }))
      out.push(crit('startup.report_5xx', limits.report5xxMax == null ? NOT_VERIFIABLE : repN > limits.report5xxMax ? FAILED : complete ? PASSED : NOT_VERIFIABLE, {
        value: repN, limit: limits.report5xxMax, detail: Object.fromEntries(report),
        reason: limits.report5xxMax == null ? 'counted and listed; whether any are tolerated is the owner\'s decision (H-P1-2)' : complete ? null : partialCounts,
      }))
    }
  }

  // First protection band: completes, no overrun.
  const band = rec?.first?.band
  if (!rec) out.push(crit('startup.first_band', NOT_VERIFIABLE, { reason: noRecord }))
  else if (band) {
    const good = band.ok === true && band.overran !== true
    // A Failed band names its cause on the printed line (formatGrade prints
    // `reason`, not `detail`): 169d337 printed "Failed value 14790 limit
    // 60000" while "pnl_watch exceeded its 5s budget" sat only in detail.
    const why = good ? null : band.error ?? (band.overran === true ? 'the first band overran' : 'the first band reported ok=false')
    out.push(crit('startup.first_band', good ? PASSED : FAILED, { value: band.ms, limit: limits.bandMaxMs, at: band.at, reason: why, detail: { overran: band.overran ?? null, error: band.error ?? null } }))
  }
  else out.push(crit('startup.first_band', recoveryDone ? FAILED : NOT_VERIFIABLE, { reason: recoveryDone ? `no band completed by BOOT + ${limits.recoverySec} s` : notYet }))

  // First clean all-account Node audit within the recovery window.
  const clean = rec?.first?.cleanProtectionAudit
  if (!rec) out.push(crit('startup.first_clean_audit', NOT_VERIFIABLE, { limit: recoveryMs, reason: noRecord }))
  else if (clean && clean.sinceBootMs != null) out.push(crit('startup.first_clean_audit', clean.sinceBootMs <= recoveryMs ? PASSED : FAILED, { value: clean.sinceBootMs, limit: recoveryMs, at: clean.at, detail: { accounts: clean.accounts ?? null, unauditable: clean.unauditable ?? null } }))
  else out.push(crit('startup.first_clean_audit', recoveryDone ? FAILED : NOT_VERIFIABLE, { limit: recoveryMs, reason: recoveryDone ? `no clean all-account audit by BOOT + ${limits.recoverySec} s` + (rec.first?.protectionAudit ? ` (first audit: ok ${rec.first.protectionAudit.ok}, errors ${rec.first.protectionAudit.errors ?? '?'})` : '') : notYet }))

  // First loop: reported against the owner's bar; no bar, no verdict.
  const loop = rec?.first?.loop
  if (!rec) out.push(crit('startup.first_loop', NOT_VERIFIABLE, { limit: limits.firstLoopMaxSec, reason: noRecord }))
  else if (!loop) out.push(crit('startup.first_loop', NOT_VERIFIABLE, { limit: limits.firstLoopMaxSec, reason: 'the first loop has not ended' }))
  else if (loop.ok === false) out.push(crit('startup.first_loop', FAILED, { value: loop.ms, limit: limits.firstLoopMaxSec, reason: 'the first loop failed' }))
  else if (limits.firstLoopMaxSec == null) out.push(crit('startup.first_loop', NOT_VERIFIABLE, { value: loop.ms, reason: 'no bar set — the owner sets it (60 s is only a proposal, closure:62)' }))
  else out.push(crit('startup.first_loop', loop.ms <= limits.firstLoopMaxSec * 1000 ? PASSED : FAILED, { value: loop.ms, limit: limits.firstLoopMaxSec * 1000 }))

  // First slow monitor, equity stop and breakers — protection that runs only
  // in the main loop, so its first evaluation waits for the first loop.
  {
    const names = ['slowMonitor', 'equityStop', 'adaptiveBreaker', 'performanceBreaker']
    const got = Object.fromEntries(names.map(n => [n, rec?.first?.[n] ?? null]))
    const failedFirst = names.filter(n => got[n]?.ok === false)
    const values = Object.fromEntries(names.map(n => [n, got[n]?.sinceBootMs ?? null]))
    const worst = Math.max(...names.map(n => got[n]?.sinceBootMs ?? -1))
    if (!rec) out.push(crit('startup.first_protection', NOT_VERIFIABLE, { limit: limits.firstProtectionMaxSec, reason: noRecord }))
    else if (failedFirst.length) out.push(crit('startup.first_protection', FAILED, { value: values, limit: limits.firstProtectionMaxSec, reason: `first evaluation failed: ${failedFirst.join(', ')}` }))
    else if (limits.firstProtectionMaxSec != null && worst > limits.firstProtectionMaxSec * 1000) out.push(crit('startup.first_protection', FAILED, { value: values, limit: limits.firstProtectionMaxSec * 1000 }))
    else if (limits.firstProtectionMaxSec == null) out.push(crit('startup.first_protection', NOT_VERIFIABLE, { value: values, reason: 'no limit set — the owner sets X (H-P1-1)' }))
    else if (names.some(n => !got[n])) out.push(crit('startup.first_protection', NOT_VERIFIABLE, { value: values, limit: limits.firstProtectionMaxSec * 1000, reason: 'not every first evaluation is stamped yet' }))
    else out.push(crit('startup.first_protection', PASSED, { value: values, limit: limits.firstProtectionMaxSec * 1000 }))
  }

  const rep = representativeOf(boot.health.filter(s => boot.bootAtMs != null && s.t <= boot.bootAtMs + windowMs))
  const criteria = rep.representative ? out : out.map(c => unrepresentative(c, 'no visible browser tab in the startup window'))
  return { window: { fromMs: boot.bootAtMs, toMs: boot.bootAtMs == null ? null : boot.bootAtMs + windowMs, complete: windowDone }, representative: rep, criteria, verdict: combineVerdicts(criteria.map(c => c.verdict)) }
}

// ---------------------------------------------------------------------------
// Recovery (BOOT → BOOT + 300 s): the pre-release snapshot against the first
// sample after the recovery deadline, differences attributed to evidence.
// ---------------------------------------------------------------------------

function positionsMap(hb) {
  const m = new Map()
  for (const a of hb?.accounts || []) for (const [pid, sl, tp] of a.pos || []) m.set(`${a.id}:${pid}`, { account: a.id, positionId: pid, sl, tp })
  return m
}

function evidenceFor(evidence, key, fromMs, untilMs) {
  const [account, positionId] = key.split(':')
  // Journals are read up to the evidence read itself (journalsToMs): the
  // native trail poll journals an amend made while Node was down at the first
  // keeper pass after boot, which can land after the post sample.
  const journalTo = Math.max(untilMs, num(evidence?.window?.journalsToMs) ?? -Infinity)
  const journal = (evidence?.journals?.[key] || []).filter(e => { const t = toMs(e.at); return t != null && t >= fromMs && t <= journalTo })
  const actions = (evidence?.actionLog?.rows || []).filter(r => {
    const t = toMs(r.at)
    return t != null && t >= fromMs && t <= untilMs && (r.account_id == null || String(r.account_id) === account) && String(r.body || '').includes(positionId)
  })
  return [...journal.map(e => ({ source: 'position_events', at: e.at, kind: e.kind, by: e.source ?? null })), ...actions.map(r => ({ source: 'action_log', at: r.at, kind: `${r.method} ${r.path}` }))]
}

/** A post sample more than three heartbeat polls after the recovery deadline is not "at" it. */
export const RECOVERY_LATE_MS = 180_000
/** A pre-release snapshot older than this before BOOT is not the state the restart replaced. */
export const PRE_SNAPSHOT_MAX_AGE_MS = 10 * 60_000

/**
 * The samples a boot's recovery is judged on: the last heartbeats /
 * entry-engines / manifest samples BEFORE the restart (only when the harness
 * saw it), the first ones at or after BOOT + recoverySec, and the heartbeats
 * samples in between. Pure; shared by the grader and the harness's evidence
 * collection so both look at the same pair.
 */
export function recoverySamples(boot, limits, samples) {
  const deadline = boot.bootAtMs == null ? null : boot.bootAtMs + limits.recoverySec * 1000
  const of = (kind) => samples.filter(s => s.kind === kind && s.data).sort((a, b) => a.t - b.t)
  const hbAll = of('heartbeats')
  const eeAll = of('entryEngines')
  const mfAll = of('manifest')
  const preOf = (list) => (boot.restartObserved ? [...list].reverse().find(s => boot.bootAtMs != null && s.t < boot.bootAtMs) || null : null)
  const postOf = (list) => list.find(s => deadline != null && s.t >= deadline && s.t <= deadline + RECOVERY_LATE_MS && s.t < boot.toMs) || null
  const preHb = preOf(hbAll)
  return {
    deadline, preHb, postHb: postOf(hbAll), preEe: preOf(eeAll), postEe: postOf(eeAll),
    preMf: preOf(mfAll), postMf: mfAll.find(s => boot.bootAtMs != null && s.t >= boot.bootAtMs && s.t < boot.toMs) || null,
    between: hbAll.filter(s => boot.bootAtMs != null && s.t >= boot.bootAtMs && s.t < boot.toMs && (deadline == null || s.t <= deadline + RECOVERY_LATE_MS)),
    preOk: !!preHb && boot.bootAtMs - preHb.t <= PRE_SNAPSHOT_MAX_AGE_MS,
  }
}

/** Position keys ("account:positionId") whose SL/TP differ between two heartbeats samples, or that closed. */
export function changedPositionKeys(preHb, postHb) {
  const before = positionsMap(preHb?.data)
  const after = positionsMap(postHb?.data)
  const changed = []
  for (const [key, p] of before) {
    const q = after.get(key)
    if (!q) changed.push({ key, closed: true })
    else if (q.sl !== p.sl || q.tp !== p.tp) changed.push({ key, closed: false })
  }
  for (const key of after.keys()) if (!before.has(key)) changed.push({ key, opened: true })
  return changed
}

/** Grade one boot's recovery. `evidence` is the harness's evidence record for this boot (or null). */
export function gradeRecovery(boot, limits, { samples = [], evidence = null } = {}) {
  const out = []
  const { deadline, preHb, postHb, preEe, postEe, preMf, postMf, between, preOk } = recoverySamples(boot, limits, samples)
  const lateBy = RECOVERY_LATE_MS
  const noPre = boot.restartObserved ? 'no heartbeats sample within 10 min before the restart' : 'the harness did not observe this restart (it started after BOOT), so there is no pre-release snapshot'
  const noPost = endedBefore(boot, limits.recoverySec * 1000) ?? `no heartbeats sample within ${lateBy / 1000} s after BOOT + ${limits.recoverySec} s`

  const noAccounts = 'the sample lists no account'
  // R1 — independent readings retained (never cleared), advancing, fresh.
  if (!postHb) out.push(crit('recovery.independent_retained', NOT_VERIFIABLE, { reason: noPost }))
  else if (!postHb.data.accounts.length) out.push(crit('recovery.independent_retained', NOT_VERIFIABLE, { reason: noAccounts }))
  else {
    const fails = []
    const nv = []
    const preById = new Map((preHb?.data.accounts || []).map(a => [a.id, a]))
    for (const a of postHb.data.accounts) {
      const before = preById.get(a.id)
      const cleared = between.some(s => { const x = s.data.accounts.find(y => y.id === a.id); return before?.ind?.at && (!x || x.ind?.at == null) })
      if (cleared) { fails.push(`${a.id}: reading cleared after boot`); continue }
      const age = a.ind?.at == null ? null : Math.round((postHb.t - a.ind.at) / 1000)
      if (age == null) { fails.push(`${a.id}: no independent reading`); continue }
      if (age > limits.independentAgeMaxSec) { fails.push(`${a.id}: reading ${age} s old`); continue }
      if (before?.ind?.at != null && !(a.ind.at > before.ind.at)) fails.push(`${a.id}: reading did not advance past the pre-release one`)
      else if (!before) nv.push(`${a.id}: no pre-release reading to compare`)
    }
    for (const id of preById.keys()) if (!postHb.data.accounts.some(a => a.id === id)) fails.push(`${id}: account missing after boot`)
    out.push(crit('recovery.independent_retained', fails.length ? FAILED : (nv.length || !preOk) ? NOT_VERIFIABLE : PASSED, {
      value: `${postHb.data.accounts.length - fails.length}/${postHb.data.accounts.length}`, limit: limits.independentAgeMaxSec,
      at: new Date(postHb.t).toISOString(), reason: fails.length ? fails.join('; ') : !preOk ? noPre : nv.length ? nv.join('; ') : null,
    }))
  }

  // R2 — Node protection audit fresh for every account, from THIS boot.
  if (!postHb) out.push(crit('recovery.node_audit_fresh', NOT_VERIFIABLE, { reason: noPost }))
  else if (!postHb.data.accounts.length) out.push(crit('recovery.node_audit_fresh', NOT_VERIFIABLE, { reason: noAccounts }))
  else {
    const fails = []
    for (const a of postHb.data.accounts) {
      const at = toMs(a.audit?.at)
      if (at == null) { fails.push(`${a.id}: no audit`); continue }
      const age = Math.round((postHb.t - at) / 1000)
      if (age > limits.auditAgeMaxSec) fails.push(`${a.id}: audit ${age} s old`)
      else if (boot.bootAtMs != null && at < boot.bootAtMs) fails.push(`${a.id}: audit predates this boot`)
    }
    out.push(crit('recovery.node_audit_fresh', fails.length ? FAILED : PASSED, { value: `${postHb.data.accounts.length - fails.length}/${postHb.data.accounts.length}`, limit: limits.auditAgeMaxSec, at: new Date(postHb.t).toISOString(), reason: fails.join('; ') || null }))
  }

  // R3 — every fast-monitor position evaluated since boot within cadence + 60 s,
  // or explicitly quote_unavailable / observe_only. The first evaluation is
  // bounded from the samples: at a sample whose lastCompletedAt still predates
  // BOOT, no evaluation had happened yet.
  //
  // THE RECEIPT FILE MUST BE THIS BOOT'S. Every fast-monitor pass rewrites
  // fast_monitor_position_work_json with its own `at` — also when it holds no
  // position (fast-monitor.js POSITION_WORK_KEY) — and sets each receipt's
  // `state` afresh (it is not among the carried fields). A file still dated
  // before BOOT at the post sample (BOOT + 300 s or later) means no pass has
  // completed since the restart: exactly the case this criterion exists for,
  // so it is Failed, and the states in it are the previous process's and
  // exempt nothing (checker 25-09: a BOOT − 30 min file with both positions
  // quote_unavailable graded Passed "2/2"). An undated file cannot show its
  // states are this boot's: those positions are Not Verifiable, not exempt.
  if (!postHb || !postHb.data.work) out.push(crit('recovery.fast_monitor_resumed', NOT_VERIFIABLE, { reason: !postHb ? noPost : 'no fast-monitor receipts in the sample' }))
  else if (toMs(postHb.data.work.at) != null && boot.bootAtMs != null && toMs(postHb.data.work.at) < boot.bootAtMs) {
    const n = postHb.data.work.positions.filter(p => p.owner == null || p.owner === 'node_fast_monitor').length
    out.push(crit('recovery.fast_monitor_resumed', FAILED, {
      value: `0/${n}`, at: new Date(postHb.t).toISOString(),
      reason: `no fast-monitor pass written since BOOT — receipts at ${postHb.data.work.at}, ${Math.round((boot.bootAtMs - toMs(postHb.data.work.at)) / 1000)} s before BOOT, read at +${Math.round((postHb.t - boot.bootAtMs) / 1000)} s`,
    }))
  } else {
    const fails = []
    const nv = []
    const fileThisBoot = toMs(postHb.data.work.at) != null
    const mine = postHb.data.work.positions.filter(p => p.owner == null || p.owner === 'node_fast_monitor')
    for (const p of mine) {
      if (['quote_unavailable', 'observe_only'].includes(p.state)) {
        if (!fileThisBoot) nv.push(`${p.a}:${p.id} ${p.state} in an undated receipt file — not shown to be this boot's`)
        continue
      }
      const allowMs = (p.cad ?? 60_000) + limits.fastMonitorGraceSec * 1000
      const done = toMs(p.done)
      if (done == null || done < boot.bootAtMs) { fails.push(`${p.a}:${p.id} not evaluated since boot`); continue }
      if (done - boot.bootAtMs <= allowMs) continue
      // The first evaluation happened after the last sample that still showed a pre-boot receipt.
      const lastPre = [...between].reverse().find(s => { const w = s.data.work?.positions.find(x => x.a === p.a && x.id === p.id); const d = toMs(w?.done); return d != null && d < boot.bootAtMs })
      if (lastPre && lastPre.t - boot.bootAtMs > allowMs) fails.push(`${p.a}:${p.id} first evaluated after ${Math.round((lastPre.t - boot.bootAtMs) / 1000)} s (allowed ${allowMs / 1000} s)`)
      else nv.push(`${p.a}:${p.id} first evaluation somewhere before ${Math.round((done - boot.bootAtMs) / 1000)} s`)
    }
    out.push(crit('recovery.fast_monitor_resumed', fails.length ? FAILED : (nv.length || !mine.length) ? NOT_VERIFIABLE : PASSED, { value: `${mine.length - fails.length - nv.length}/${mine.length}`, reason: [...fails, ...nv].join('; ') || (mine.length ? null : 'no fast-monitor position to evaluate') }))
  }

  // R4 — SL/TP tuples and the entry configuration equal the pre-release
  // snapshot plus changes the evidence attributes.
  //
  // THE TUPLES ARE THE VERIFIER'S READING, NOT THE SAMPLE'S. /state/heartbeats
  // relays cpp-verify's last independent reading, which can predate BOOT at a
  // post sample taken after it (checker 25-09: a reading at BOOT − 20 s carried
  // into the BOOT + 310 s sample graded Passed while R1 beside it said Failed).
  // An account is compared only on a post reading taken after BOOT and after
  // the pre-release one; otherwise its positions are Not Verifiable, never
  // "unchanged".
  {
    if (!preOk || !postHb) out.push(crit('recovery.config_and_protection_unchanged', NOT_VERIFIABLE, { reason: !postHb ? noPost : noPre }))
    else {
      const fromMs = preHb.t - 60_000
      const toMsW = postHb.t + 60_000
      const before = positionsMap(preHb.data)
      const after = positionsMap(postHb.data)
      const unexplained = []
      const unverifiable = []
      const attributed = []
      const journalsRead = evidence?.journals && evidence.journalsOk !== false
      const actionsRead = evidence?.actionLog?.ok === true
      const stamp = (ms) => new Date(ms).toISOString()
      const preReadAt = new Map((preHb.data.accounts || []).map(a => [a.id, a.ind?.at ?? null]))
      const postReadAt = new Map((postHb.data.accounts || []).map(a => [a.id, a.ind?.at ?? null]))
      const notCompared = new Map() // account → why its post reading cannot stand for this boot
      for (const id of new Set([...preReadAt.keys(), ...postReadAt.keys()])) {
        const post = postReadAt.get(id) ?? null
        const pre = preReadAt.get(id) ?? null
        if (post == null) notCompared.set(id, 'no independent reading in the post sample')
        else if (post <= boot.bootAtMs) notCompared.set(id, `no post-boot independent reading (reading at ${stamp(post)}, BOOT ${stamp(boot.bootAtMs)})`)
        else if (pre != null && post <= pre) notCompared.set(id, `the post reading (${stamp(post)}) does not follow the pre-release one (${stamp(pre)})`)
      }
      const skipped = new Map() // account → position count left uncompared
      const accountOf = (key) => key.slice(0, key.indexOf(':'))
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const id = accountOf(key)
        if (notCompared.has(id)) skipped.set(id, (skipped.get(id) || 0) + 1)
      }
      for (const [id, why] of notCompared) unverifiable.push(`${id}: ${skipped.get(id) || 0} position(s) not compared — ${why}`)
      for (const [key, p] of before) {
        if (notCompared.has(accountOf(key))) continue
        const q = after.get(key)
        if (q && q.sl === p.sl && q.tp === p.tp) continue
        const ev = evidenceFor(evidence, key, fromMs, toMsW)
        const what = q ? `${key} SL ${p.sl}→${q.sl} TP ${p.tp}→${q.tp}` : `${key} closed`
        if (ev.length) attributed.push({ change: what, evidence: ev.slice(0, 3) })
        else if (q && journalsRead && (evidence.journals[key] !== undefined)) unexplained.push(what)
        else unverifiable.push(`${what} (no evidence read for it)`)
      }
      for (const key of after.keys()) if (!before.has(key) && !notCompared.has(accountOf(key))) {
        const ev = evidenceFor(evidence, key, fromMs, toMsW)
        if (ev.length) attributed.push({ change: `${key} opened`, evidence: ev.slice(0, 3) })
        else unverifiable.push(`${key} opened (no evidence read for it)`)
      }
      if (preEe && postEe) {
        const preById = new Map(preEe.data.accounts.map(a => [a.id, a]))
        for (const a of postEe.data.accounts) {
          const b = preById.get(a.id)
          if (!b) continue
          const diffs = ['mode', 'req', 'rev', 'epoch', 'policy'].filter(k => a[k] !== b[k]).map(k => `${k} ${b[k]}→${a[k]}`)
          if (!diffs.length) continue
          const rows = (evidence?.actionLog?.rows || []).filter(r => { const t = toMs(r.at); return t != null && t >= fromMs && t <= toMsW && String(r.account_id ?? '') === a.id && ENTRY_CONFIG_ACTION_PATH.test(String(r.path || '')) })
          const what = `${a.id} ${diffs.join(', ')}`
          if (rows.length) attributed.push({ change: what, evidence: rows.slice(0, 3).map(r => ({ source: 'action_log', at: r.at, kind: `${r.method} ${r.path}` })) })
          else if (actionsRead) unexplained.push(what)
          else unverifiable.push(`${what} (action_log not read)`)
        }
      } else unverifiable.push('entry configuration: no /state/entry-engines sample on both sides')
      out.push(crit('recovery.config_and_protection_unchanged', unexplained.length ? FAILED : unverifiable.length ? NOT_VERIFIABLE : PASSED, {
        value: { positionsBefore: before.size, positionsAfter: after.size, attributed: attributed.length, unexplained: unexplained.length, unverifiable: unverifiable.length, accountsNotCompared: notCompared.size },
        reason: [...unexplained.map(x => `unexplained: ${x}`), ...unverifiable].join('; ') || null,
        detail: attributed.length ? attributed.slice(0, 20) : null,
      }))
    }
  }

  // R5 — zero unsent, in-flight or unknown intents (the entry ledger's counts).
  if (!postHb) out.push(crit('recovery.intents_settled', NOT_VERIFIABLE, { reason: noPost }))
  else if (!postHb.data.accounts.length) out.push(crit('recovery.intents_settled', NOT_VERIFIABLE, { reason: noAccounts }))
  else {
    const open = postHb.data.accounts.filter(a => a.counts && (a.counts.unsent || a.counts.inFlight || a.counts.unknown)).map(a => `${a.id}: ${a.counts.unsent} unsent, ${a.counts.inFlight} in flight, ${a.counts.unknown} unknown`)
    const missing = postHb.data.accounts.filter(a => !a.counts).map(a => a.id)
    out.push(crit('recovery.intents_settled', open.length ? FAILED : missing.length ? NOT_VERIFIABLE : PASSED, { value: open.length, limit: 0, reason: open.join('; ') || (missing.length ? `no counts for ${missing.join(', ')}` : null) }))
  }

  // R6 — the five native deployments unchanged. Two (the sidecars' boot ids)
  // are readable GET-only; cpp-verify and the two scanners need Railway reads.
  {
    const pre = preMf
    const post = postMf
    const changed = pre && post ? ['demoBootId', 'liveBootId'].filter(k => pre.data[k] && post.data[k] && pre.data[k] !== post.data[k]) : []
    out.push(crit('recovery.native_deployments', changed.length ? FAILED : NOT_VERIFIABLE, {
      value: pre && post ? { demo: post.data.demoBootId === pre.data.demoBootId, live: post.data.liveBootId === pre.data.liveBootId } : null,
      reason: changed.length ? `sidecar boot id changed: ${changed.join(', ')}` : (pre && post ? 'the two sidecars kept their boot ids; ' : 'no runtime-manifest sample on both sides; ') + 'cpp-verify, cpp-scan-tick and cpp-scan-timeframe deployment ids need a Railway read',
    }))
  }

  return { deadlineMs: deadline, criteria: out, verdict: combineVerdicts(out.map(c => c.verdict)) }
}

/**
 * The harness's own requests (at least 1 s long) that were in flight at each
 * stall time. The slow one it can make is the full /state/goal-table (12,520
 * and 13,271 ms on 25-09, route-timings), which it reads only when
 * --goal-table-every-min opts in — off by default, the limits come from the
 * targets-only GET /actions/goal-table. A stall it caused is still a stall
 * (any reader of that route causes it too), so this annotates a failure and
 * never removes one.
 */
export function harnessOverlap(stallTimes, ownRequests) {
  const out = []
  for (const at of stallTimes) {
    const t = toMs(at)
    if (t == null) continue
    const r = ownRequests.find(q => (q.ms ?? 0) >= 1_000 && q.t <= t && t <= q.t + q.ms + 1_000)
    if (r && !out.some(o => o.stallAt === at)) out.push({ stallAt: at, harnessRoute: r.route, harnessMs: r.ms })
  }
  return out
}

// ---------------------------------------------------------------------------
// Steady state: BOOT + 15 min to the next boot, at least 2 h.
// ---------------------------------------------------------------------------

function perSample(id, list, check, { limit = null, emptyReason = 'no data in the window' } = {}) {
  let n = 0
  let worst = null
  const failures = []
  let nv = 0
  for (const s of list) {
    const r = check(s)
    if (r == null) { nv++; continue }
    n++
    // A reading that is absent where it must exist is reported as Infinity: it fails, and says so.
    const shown = Number.isFinite(r.value) ? r.value : 'absent'
    if (Number.isFinite(r.value) && (worst == null || r.value > worst)) worst = r.value
    if (!Number.isFinite(r.value) && worst == null) worst = 'absent'
    if (!r.ok) failures.push({ at: new Date(s.t).toISOString(), value: shown })
  }
  if (failures.length) return crit(id, FAILED, { value: worst, limit, at: failures[0].at, reason: `${failures.length} of ${n} sample(s) over the limit`, detail: failures.slice(0, 5) })
  if (!n) return crit(id, NOT_VERIFIABLE, { limit, reason: emptyReason })
  return crit(id, PASSED, { value: worst, limit, reason: nv ? `${n} sample(s) graded, ${nv} without data` : `${n} sample(s)` })
}

/** Grade the steady-state window of one boot (or [fromMs, toMs] when given). */
export function gradeSteady(boot, limits, { samples = [], fromMs = null, toMs: until = null, ownRequests = [] } = {}) {
  const start = Math.max(fromMs ?? -Infinity, (boot.bootAtMs ?? boot.firstT) + limits.startupWindowMin * 60_000)
  const end = Math.min(until ?? Infinity, boot.toMs, samples.reduce((m, s) => Math.max(m, s.t), boot.lastT))
  const inWin = (s) => s.t >= start && s.t <= end
  const health = boot.health.filter(inWin)
  const hb = samples.filter(s => s.kind === 'heartbeats' && s.data && inWin(s))
  const rt = samples.filter(s => s.kind === 'routeTimings' && s.data && inWin(s))
  const hours = end > start ? (end - start) / 3_600_000 : 0
  const out = []
  // With no /health sample in the window there is no reading to lack a
  // field: "(V3 M1 not deployed)" or "(0 loops ran)" would be a false cause
  // (checker 25-09 — every boot tonight carried M1's boot record). The
  // deployment is named only when samples exist and lack the field.
  const noHealth = health.length ? null : 'no /health sample in the steady window'

  // Main-loop p95: per-loop durations observed through loopCount/lastLoopMs.
  {
    const durations = []
    let ran = 0
    for (let i = 1; i < health.length; i++) {
      const a = health[i - 1].data, b = health[i].data
      if (num(a.loopCount) == null || num(b.loopCount) == null) continue
      const d = b.loopCount - a.loopCount
      if (d <= 0) continue
      ran += d
      if (d === 1 && num(b.lastLoopMs) != null && b.lastLoopMs > 0) durations.push(b.lastLoopMs)
    }
    const sorted = durations.sort((x, y) => x - y)
    const p95 = percentileOf(sorted, 0.95)
    if (health.length < 2) out.push(crit('steady.main_loop_p95', NOT_VERIFIABLE, { limit: limits.mainLoopP95MaxSec * 1000, reason: noHealth ?? 'one /health sample in the steady window — two are needed to see a loop end' }))
    else if (sorted.length < 10) out.push(crit('steady.main_loop_p95', NOT_VERIFIABLE, { value: p95, limit: limits.mainLoopP95MaxSec * 1000, reason: `${sorted.length} loop duration(s) observed (${ran} loops ran); at least 10 needed` }))
    else out.push(crit('steady.main_loop_p95', p95 <= limits.mainLoopP95MaxSec * 1000 ? PASSED : FAILED, { value: p95, limit: limits.mainLoopP95MaxSec * 1000, reason: `${sorted.length} of ${ran} loops observed`, detail: { p50: percentileOf(sorted, 0.5), max: sorted[sorted.length - 1] } }))
  }

  const fmFresh = (s) => { const at = toMs(s.data.fm?.at); return at != null && s.t - at <= 5 * 60_000 }
  out.push(perSample('steady.fast_monitor_skip', health, s => (fmFresh(s) && num(s.data.fm.skipShare10m) != null ? { value: Math.round(s.data.fm.skipShare10m * 1000) / 10, ok: s.data.fm.skipShare10m * 100 <= limits.fastMonitorSkipMaxPct } : null), { limit: limits.fastMonitorSkipMaxPct, emptyReason: noHealth ?? 'no fresh fast-monitor pass record' }))
  out.push(perSample('steady.tick_max', health, s => (fmFresh(s) && num(s.data.fm.max10mMs) != null ? { value: s.data.fm.max10mMs, ok: s.data.fm.max10mMs <= limits.tickMaxMs } : null), { limit: limits.tickMaxMs, emptyReason: noHealth ?? 'no fresh fast-monitor pass record' }))

  // The band: never over its 60 s, no skipped band inside the window.
  {
    const c = perSample('steady.band', hb, s => (s.data.band && num(s.data.band.max10mMs) != null ? { value: s.data.band.max10mMs, ok: s.data.band.max10mMs <= limits.bandMaxMs && !s.data.band.overran } : null), { limit: limits.bandMaxMs, emptyReason: 'no band record' })
    const skips = hb.map(s => num(s.data.band?.skippedBands)).filter(v => v != null)
    const grew = skips.length > 1 && skips[skips.length - 1] > skips[0]
    out.push(grew ? { ...c, verdict: FAILED, reason: `${skips[skips.length - 1] - skips[0]} band(s) skipped in the window${c.reason ? `; ${c.reason}` : ''}` } : c)
  }

  out.push(perSample('steady.budget_overruns', health, s => (num(s.data.lat?.overruns10m) != null ? { value: s.data.lat.overruns10m, ok: s.data.lat.overruns10m <= limits.budgetOverrunsMax } : null), { limit: limits.budgetOverrunsMax, emptyReason: noHealth ?? 'no overrun counter on /health (V3 M1 not deployed)' }))

  out.push(perSample('steady.independent_age', hb, s => {
    const ages = s.data.accounts.map(a => (a.ind?.at == null ? Infinity : (s.t - a.ind.at) / 1000))
    if (!ages.length) return null
    const worst = Math.max(...ages)
    return { value: Number.isFinite(worst) ? Math.round(worst) : Infinity, ok: worst <= limits.independentAgeMaxSec }
  }, { limit: limits.independentAgeMaxSec, emptyReason: 'no heartbeats sample' }))

  out.push(perSample('steady.audit_age', hb, s => {
    const ages = s.data.accounts.map(a => { const at = toMs(a.audit?.at); return at == null ? Infinity : (s.t - at) / 1000 })
    if (!ages.length) return null
    const worst = Math.max(...ages)
    return { value: Number.isFinite(worst) ? Math.round(worst) : Infinity, ok: worst <= limits.auditAgeMaxSec }
  }, { limit: limits.auditAgeMaxSec, emptyReason: 'no heartbeats sample' }))

  {
    // p99 against the strict limit through its histogram bound (p99Below):
    // a sample whose bound cannot show p99 < limit is not a pass — the
    // criterion reads Not Verifiable unless another sample failed.
    let p99Open = 0
    const c0 = perSample('steady.lag', health, s => {
      const w = s.data.lat?.lag10m
      if (!w || !w.n) return null
      const p = p99Below(w.p99LeMs, limits.lagP99MaxMs)
      if (w.maxMs < limits.lagMaxMs && p === 'unknown') p99Open++
      return { value: w.maxMs, ok: w.maxMs < limits.lagMaxMs && p !== 'fail' }
    }, { limit: { maxMs: limits.lagMaxMs, p99LtMs: limits.lagP99MaxMs }, emptyReason: noHealth ?? 'no lag tap on /health (V3 M1 not deployed)' })
    const c = c0.verdict === PASSED && p99Open ? { ...c0, verdict: NOT_VERIFIABLE, reason: `${p99Open} sample(s) whose p99 bound reaches ${limits.lagP99MaxMs} ms — the histogram cannot show p99 < ${limits.lagP99MaxMs} ms; ${c0.reason}` } : c0
    const overlap = c.verdict === FAILED ? harnessOverlap(health.map(s => s.data.lat?.lag10m?.worst).filter(w => w && w.ms >= limits.lagMaxMs).map(w => w.at), ownRequests) : []
    out.push(overlap.length ? { ...c, reason: `${c.reason}; ${overlap.length} stall(s) overlapped the harness's own slow request — still Failed: any reader of that route causes the same stall`, detail: { failures: c.detail, harnessOverlap: overlap } } : c)
  }

  // 5xx in the window: the delta of route-timings' per-route counters (same
  // boot — they are in-memory, route-timing.js, and start at zero at BOOT).
  // The baseline is the last route-timings sample of this boot at or before
  // the steady start, when there is one: the harness reads the route every
  // 5 min, so the first in-window sample can come up to 5 min after BOOT +
  // 15 min, and a 5xx in that gap would be counted by neither the startup
  // record (closed at + 15 min) nor this delta (checker 25-09). A baseline
  // taken before the start can count a late startup-window 5xx here as well
  // — shown twice, never hidden.
  {
    const bootFrom = boot.bootAtMs ?? boot.firstT
    const baseline = [...samples].filter(s => s.kind === 'routeTimings' && s.data && s.t >= bootFrom && s.t < start && s.t < boot.toMs).sort((a, b) => a.t - b.t).pop() || null
    const series = baseline ? [baseline, ...rt] : rt
    if (series.length < 2) {
      const why = 'fewer than two /state/route-timings samples of this boot from the steady start (or the last one before it)'
      out.push(crit('steady.critical_5xx', NOT_VERIFIABLE, { limit: limits.critical5xxMax, reason: why }))
      out.push(crit('steady.report_5xx', NOT_VERIFIABLE, { limit: limits.report5xxMax, reason: why }))
    } else {
      const first = new Map(series[0].data.routes.map(r => [r.route, r['5xx']]))
      const delta = {}
      for (const r of series[series.length - 1].data.routes) { const d = r['5xx'] - (first.get(r.route) || 0); if (d > 0) delta[r.route] = d }
      const crits = Object.entries(delta).filter(([r]) => routeClass(r) === 'critical')
      const reps = Object.entries(delta).filter(([r]) => routeClass(r) === 'report')
      const cn = crits.reduce((a, [, n]) => a + n, 0)
      const rn = reps.reduce((a, [, n]) => a + n, 0)
      const from = baseline ? `counted from the route-timings sample at BOOT + ${Math.round((baseline.t - bootFrom) / 1000)} s (the last before the steady start)` : null
      out.push(crit('steady.critical_5xx', cn > limits.critical5xxMax ? FAILED : PASSED, { value: cn, limit: limits.critical5xxMax, detail: Object.fromEntries(crits), reason: from }))
      out.push(crit('steady.report_5xx', limits.report5xxMax == null ? NOT_VERIFIABLE : rn > limits.report5xxMax ? FAILED : PASSED, { value: rn, limit: limits.report5xxMax, detail: Object.fromEntries(reps), reason: [limits.report5xxMax == null ? 'counted and listed; whether any are tolerated is the owner\'s decision (H-P1-2)' : null, from].filter(Boolean).join('; ') || null }))
    }
  }

  const rep = representativeOf(health)
  let criteria = out
  if (hours < limits.steadyMinHours) criteria = criteria.map(c => unrepresentative(c, `the window is ${Math.round(hours * 100) / 100} h, under ${limits.steadyMinHours} h`))
  if (!rep.representative) criteria = criteria.map(c => unrepresentative(c, 'no visible browser tab in the window'))
  return { window: { fromMs: start, toMs: end, hours: Math.round(hours * 100) / 100 }, representative: rep, criteria, verdict: combineVerdicts(criteria.map(c => c.verdict)) }
}

// ---------------------------------------------------------------------------
// The whole run.
// ---------------------------------------------------------------------------

/**
 * Grade every boot in `samples` (compact JSONL records, sorted or not).
 * Limits come from the newest goal-table targets sample (GET /actions/goal-table,
 * or the full /state/goal-table) when there is one
 * (so an owner-patched or confirmed limit flows through), else the proposal;
 * `override` replaces both.
 */
export function gradeRun(samples, { override = null, fromMs = null, toMs: until = null } = {}) {
  const all = [...samples].sort((a, b) => a.t - b.t)
  const gt = [...all].reverse().find(s => (s.kind === 'goalTargets' || s.kind === 'goalTable') && s.data?.targets)
  const fromTargets = p1p4LimitsFromTargets(gt?.data.targets)
  const limits = { ...fromTargets.limits, ...(override || {}) }
  // The harness's own requests include its evidence reads (action_log, the
  // positions list, cockpit journals — 4.4–4.7 s action-log reads on 25-09,
  // inside the startup window), so a stall they overlap is annotated too.
  const own = [
    ...all.filter(s => s.kind !== 'evidence').map(s => ({ t: s.t, route: s.route, cls: s.cls, status: s.status, ms: s.ms ?? null })),
    ...all.filter(s => s.kind === 'evidence' && Array.isArray(s.data?.reads)).flatMap(s => s.data.reads.map(r => ({ t: r.t, route: r.route, cls: r.cls, status: r.status ?? null, ms: r.ms ?? null }))),
  ].sort((a, b) => a.t - b.t)
  const platform = own.filter(r => r.cls === 'platform').map(r => ({ at: new Date(r.t).toISOString(), route: r.route, status: r.status ?? null }))
  const timeouts = own.filter(r => r.cls === 'timeout').map(r => ({ at: new Date(r.t).toISOString(), route: r.route, ms: r.ms }))
  const boots = splitBoots(all).map(b => {
    const mine = all.filter(inBoot(b))
    // The pre-release snapshot belongs to the previous boot's window; recovery needs every sample.
    const evidence = [...all].reverse().find(s => s.kind === 'evidence' && s.data && b.bootAtMs != null && Math.abs(Number(s.data.bootAtMs) - b.bootAtMs) <= 60_000)?.data ?? null
    return {
      bootAt: b.bootAtMs == null ? null : new Date(b.bootAtMs).toISOString(),
      bootId: b.bootId, commit: b.commit, restartObserved: b.restartObserved, reasons: b.reasons,
      startup: gradeStartup(b, limits, { ownRequests: own }),
      recovery: gradeRecovery(b, limits, { samples: all, evidence }),
      steady: gradeSteady(b, limits, { samples: mine, fromMs, toMs: until, ownRequests: own }),
    }
  })
  const verdicts = boots.flatMap(b => [...b.startup.criteria, ...b.recovery.criteria, ...b.steady.criteria].map(c => c.verdict))
  return {
    limits: { source: fromTargets.confirmed && !override ? 'confirmed' : 'proposed', confirmedAt: fromTargets.confirmedAt, values: limits },
    // Only owner-confirmed limits make a grade acceptance (closure:205).
    acceptance: fromTargets.confirmed && !override ? 'limits confirmed by the owner' : 'NOT acceptance — graded against proposed limits the owner has not confirmed (H-P1-1)',
    samples: all.length,
    boots,
    platform: { count: platform.length, events: platform.slice(-50) },
    // The harness's own deadline passed with no answer: not a gateway error
    // and not a pass — a blocked main thread looks exactly like this.
    timeouts: { count: timeouts.length, events: timeouts.slice(-50) },
    summary: {
      [PASSED]: verdicts.filter(v => v === PASSED).length,
      [FAILED]: verdicts.filter(v => v === FAILED).length,
      [NOT_VERIFIABLE]: verdicts.filter(v => v === NOT_VERIFIABLE).length,
    },
  }
}

/** Plain-text rendering: one line per criterion. */
export function formatGrade(g) {
  const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const lines = [`P1/P4 grade — limits ${g.limits.source}${g.limits.confirmedAt ? ` (${g.limits.confirmedAt})` : ''}: ${g.acceptance}`]
  lines.push(`samples ${g.samples}; platform gateway errors ${g.platform.count} (classified apart, not app failures); harness timeouts ${g.timeouts?.count ?? 0} (no answer within the deadline — not a gateway error, not a pass)`)
  for (const b of g.boots) {
    lines.push('', `boot ${b.bootAt ?? '?'} commit ${b.commit ?? '?'}${b.restartObserved ? ` (restart observed: ${b.reasons.join(', ')})` : ' (restart not observed by the harness)'}`)
    for (const [name, part] of [['startup', b.startup], ['recovery', b.recovery], ['steady', b.steady]]) {
      const extra = part.window?.hours != null ? ` ${part.window.hours} h` : ''
      const rep = part.representative
      const tabs = !rep ? '' : !rep.representative ? ' (no visible tab)' : ` (visible tabs: ${rep.pages.join(', ') || '?'}${rep.deskVisible && rep.performanceVisible ? '' : `; ${[rep.deskVisible ? null : 'Desk', rep.performanceVisible ? null : 'Performance'].filter(Boolean).join(' and ')} never visible`})`
      lines.push(`  ${name}${extra}: ${part.verdict}${tabs}`)
      for (const c of part.criteria) lines.push(`    ${c.verdict.padEnd(14)} ${c.id} value ${fmt(c.value)} limit ${fmt(c.limit)}${c.reason ? ` — ${c.reason}` : ''}`)
    }
  }
  lines.push('', `summary: ${g.summary[PASSED]} Passed, ${g.summary[FAILED]} Failed, ${g.summary[NOT_VERIFIABLE]} Not Verifiable`)
  return lines.join('\n')
}
