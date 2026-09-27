import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { accountAnalytics } from './account-analytics.js'
import { ledgerWindows, classifyOutcome, plannedRr } from './perf-ledger.js'
import { realisedRR, checkTradeConsistency } from './trade-consistency.js'
import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { categorize, MARKETS, closedAtMs, dayAnchorMs, isFxWeekend } from '../shared/formulas.js'
import { emptyPopulation } from '../shared/performance-populations.js'
import { REPORT_SESSIONS, SESSION_SOURCE, SESSION_EXCEPTIONS, SESSION_EXCEPTIONS_APPLIED, SESSION_HOLIDAY_EVIDENCE, sessionIntervals, inIntervals, closureIntervals, subtractIntervals } from '../shared/report-sessions.js'
import { sessionHolidayRows } from './session-holidays.js'
import { cupHandleFunnel } from './cup-handle-funnel.js'
import { calendarDate, calendarDay, calendarLedgerWindows } from '../shared/performance-calendar.js'
import { storageReport } from './storage-report.js'
import { ledgerBalanceEdges } from './balance-edges.js'
import { depositCurrencies } from './deposit-currencies.js'
// The deposit-currency reader lives in deposit-currencies.js (V3 WEB-3m: one
// reader for the pools and the balance columns). Re-exported so existing
// importers of this module keep working.
export { depositCurrencies }

const DAY = 86400_000
const NUMBER = v => v == null || String(v).trim() === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null
function fold(st, row) {
  st.n++
  if (row.pnl != null) {
    st.pricedN++; st.net += row.pnl
    if (row.pnl > 0) { st.wins++; st.gw += row.pnl } else st.gl -= row.pnl
    st.high = st.high == null ? row.pnl : Math.max(st.high, row.pnl)
    st.low = st.low == null ? row.pnl : Math.min(st.low, row.pnl)
  }
  st[row.out]++
  if (row.rr != null) { st.rrSum += row.rr; st.rrN++ }
  if (row.realRr != null) { st.realSum += row.realRr; st.realN++ }
  if (row.mismatch) st.mismatch++
  if (!row.origin) st.unattributedN++
  else if (!CLEAN_BOT_ORIGINS.includes(row.origin)) { st.externalN++; st.externalNet += row.pnl ?? 0 }
}
/** Iterate the complete recorded population. Bounds fail the report explicitly;
 * they never turn an incomplete prefix into a stated performance total. */
export function buildPerformancePopulations(db, { now = Date.now(), maxGroups = 24000, deadlineMs = 12000, timeZone = null } = {}) {
  const started = performance.now(), day0 = timeZone ? calendarDay(now, timeZone) : dayAnchorMs(now), weekend = !timeZone && isFxWeekend(now)
  const sessionFrom = weekend ? day0 - DAY : day0, sessionTo = weekend ? day0 : now
  const ledgerDefs = timeZone ? calendarLedgerWindows(ledgerWindows(now), now, timeZone) : ledgerWindows(now)
  // V3 WEB-6: each exchange's regular cash intervals for THIS window, derived
  // in its own IANA zone (DST applied, lunch breaks excluded, weekends in local
  // time). A close is in a session when its instant falls inside one of them.
  // V3 WEB-6b: broker-listed holidays and early closes cut out of the
  // exchanges whose stocks' calendars list them (session-holidays.js); every
  // other exchange keeps regular hours and says so (`holidays.status`). A
  // failed read applies nothing and says that, never a silent "no holiday".
  let holidayRows = null
  try { holidayRows = sessionHolidayRows(db) } catch { holidayRows = null }
  const sessions = REPORT_SESSIONS.map(s => {
    const regular = sessionIntervals(s, sessionFrom, sessionTo), regularNow = sessionIntervals(s, now, now + 1)
    const evidence = holidayRows?.[s.exchange]
    if (!evidence) {
      const status = holidayRows == null ? 'unavailable' : s.exchange in SESSION_HOLIDAY_EVIDENCE ? 'no_evidence' : 'not_listed'
      return { key: s.key, exchange: s.exchange, tz: s.tz, hours: s.hours, intervals: regular, openNow: inIntervals(now, regularNow),
        holidays: { status } }
    }
    const lo = Math.min(sessionFrom, now) - DAY, hi = Math.max(sessionTo, now + 1) + DAY
    const { closures, unreadable } = closureIntervals(evidence.rows, lo, hi)
    const inWindow = closures.filter(c => c.to > sessionFrom && c.from < sessionTo)
    return { key: s.key, exchange: s.exchange, tz: s.tz, hours: s.hours,
      intervals: subtractIntervals(regular, closures), openNow: inIntervals(now, subtractIntervals(regularNow, closures)),
      holidays: { status: 'applied', identities: evidence.identities, observedAt: evidence.observedAt, unreadable,
        closures: inWindow, closedNow: closures.some(c => now >= c.from && now < c.to) } }
  })
  const defs = [...ledgerDefs.map(w => ({ ...w, ledger: true })),
    { key: '24h', from: now - DAY, to: now }, { key: 'day', from: day0, to: now },
    ...sessions.map(s => ({ key: `session:${s.key}`, from: sessionFrom, to: sessionTo, session: s })),
    { key: 'session:OFF', from: sessionFrom, to: sessionTo, off: true },
    { key: 'session:ALL', from: sessionFrom, to: sessionTo, all: true }]
  const maps = defs.map(() => new Map()), best = new Map(), last = new Map(), daily = new Map()
  const coverage = { closedN: 0, unpricedN: 0, unknownCloseTimeN: 0, futureCloseTimeN: 0, unattributedAccountN: 0 }
  let groups = 0, medianValues = 0
  const rows = db.prepare(`SELECT id,account_id,symbol,side,volume,entry_price,sl_price,tp_price,exit_price,
    net_pnl,closed_at,closed_at_ms,opened_at,close_reason,label_strategy,strategy,realised_rr,pnl_price_mismatch,
    origin,hold_duration_ms,rvol_open,vwap_side_open,obv_open FROM trades WHERE status='closed'`).iterate()
  for (const raw of rows) {
    if (performance.now() - started > deadlineMs) throw new Error('performance_report_deadline')
    const t = closedAtMs(raw), accountId = raw.account_id == null || String(raw.account_id).trim() === '' ? null : String(raw.account_id)
    const pnl = NUMBER(raw.net_pnl)
    coverage.closedN++; if (pnl == null) coverage.unpricedN++; if (accountId == null) coverage.unattributedAccountN++
    if (t == null || t <= 0) { coverage.unknownCloseTimeN++; continue }
    if (t >= now) { coverage.futureCloseTimeN++; continue }
    last.set('all', Math.max(last.get('all') || 0, t))
    if (accountId != null) last.set(accountId, Math.max(last.get(accountId) || 0, t))
    const r = { accountId, t, pnl, sym: String(raw.symbol || '').toUpperCase(), strat: raw.label_strategy || raw.strategy || 'unlabelled',
      market: categorize(raw.symbol), out: classifyOutcome(raw), rr: plannedRr(raw),
      realRr: NUMBER(raw.realised_rr) ?? realisedRR(raw), origin: raw.origin || null,
      mismatch: raw.pnl_price_mismatch != null ? !!Number(raw.pnl_price_mismatch) : (() => { const c = checkTradeConsistency(raw); return c.decidable && !c.ok })() }
    const day = timeZone ? calendarDate(t, timeZone) : new Date(t).toISOString().slice(0, 10), dailyKey = JSON.stringify([accountId, day])
    if (!daily.has(dailyKey)) {
      if (++groups > maxGroups) throw new Error('performance_report_group_bound')
      daily.set(dailyKey, { accountId, day, stats: emptyPopulation() })
    }
    fold(daily.get(dailyKey).stats, r)
    for (let i = 0; i < defs.length; i++) {
      const w = defs[i]
      if (t < w.from || t >= w.to || (w.session && !inIntervals(t, w.session.intervals))
        || (w.off && sessions.some(s => inIntervals(t, s.intervals)))) continue
      const session = w.key.startsWith('session:')
      const key = JSON.stringify(session ? [accountId] : [accountId, r.sym, r.strat])
      let g = maps[i].get(key)
      if (!g) {
        if (++groups > maxGroups) throw new Error('performance_report_group_bound')
        g = { accountId, sym: session ? null : r.sym, strat: session ? null : r.strat, market: session ? null : r.market,
          stats: emptyPopulation(), ...(session ? { values: [] } : {}) }
        maps[i].set(key, g)
      }
      fold(g.stats, r)
      if (session && pnl != null) {
        if (++medianValues > 100000) throw new Error('performance_report_median_bound')
        g.values.push(pnl)
      }
    }
    if (pnl != null && t >= now - 30 * DAY && accountId != null) {
      if (!best.has(accountId)) best.set(accountId, { win: [], lag: [] })
      const openedAt = closedAtMs({ closed_at: raw.opened_at })
      const trade = { ...r, id: raw.id, side: raw.side, lots: raw.volume, openedAt,
        durMin: raw.hold_duration_ms != null ? Math.round(raw.hold_duration_ms / 60000) : openedAt == null ? null : Math.round((t - openedAt) / 60000),
        rvO: raw.rvol_open, vwO: raw.vwap_side_open, obv: raw.obv_open,
        tpHit: r.out === 'tp', slHit: r.out === 'sl', part: r.out === 'part' }
      for (const [key, sign] of [['win', -1], ['lag', 1]]) {
        const list = best.get(accountId)[key]; list.push(trade); list.sort((a, b) => sign * (a.pnl - b.pnl) || b.t - a.t || b.id - a.id); list.length = Math.min(6, list.length)
      }
    }
  }
  const windows = defs.map((w, i) => ({ ...w, groups: [...maps[i].values()].map(g => {
    if (g.values) {
      g.values.sort((a, b) => a - b); const n = g.values.length, mid = n >> 1
      g.stats.median = n ? (n % 2 ? g.values[mid] : (g.values[mid - 1] + g.values[mid]) / 2) : null
      delete g.values
    }
    return g
  }) }))
  // The unit of each account's recorded money, read ONCE: the pools
  // (reportCurrencyStats) and the carry below both key on this same map.
  const currencyByAccount = depositCurrencies(db)
  // V3 WEB-3: carry in / carry out are the broker balances OBSERVED at each
  // ledger window's edges (account_history), per registered account, counted
  // only in the account's recorded deposit currency (V3 WEB-3m). A failed read
  // leaves every carry explicitly unavailable; the populations still stand.
  let balanceEdges
  try { balanceEdges = ledgerBalanceEdges(db, ledgerDefs, { currencyByAccount }) }
  catch { balanceEdges = { status: 'unavailable', reason: 'balance_history_read_failed' } }
  return { schemaVersion: 1, status: 'complete', generatedAt: new Date(now).toISOString(), asOfMs: now, timeZone,
    balanceEdges,
    population: 'all_recorded_closes', currency: null, moneyPolicy: 'recorded_units_within_one_stamped_account_only',
    // Readers may pool accounts only within one of these (reportCurrencyStats,
    // and the carry through reportLedger), never across two.
    currencyByAccount, currencyPolicy: 'pool_within_one_recorded_deposit_currency_never_across',
    markets: MARKETS, coverage, windows, daily: [...daily.values()], bestByAccount: Object.fromEntries(best),
    lastCloseByAccount: Object.fromEntries([...last].map(([a, t]) => [a, new Date(t).toISOString()])),
    openByAccount: db.prepare('SELECT account_id,count(*) AS n FROM monitored_positions WHERE status=\'active\' GROUP BY account_id').all(),
    sessionWindow: { from: sessionFrom, to: sessionTo, weekend, source: SESSION_SOURCE,
      exceptions: sessions.some(s => s.holidays.status === 'applied') ? SESSION_EXCEPTIONS_APPLIED : SESSION_EXCEPTIONS } }
}

// A report that could not be produced is UNAVAILABLE, never empty (owner
// principle 6). Every rejection from isolatedReport carries this type so a
// route can answer an explicit 503 with the reason and a retry hint, and can
// still tell a report failure apart from its own post-processing bug (a 500).
// The message is kept byte-for-byte: heartbeats and logs record err.message.
const RETRY_AFTER_SEC = {
  performance_report_worker_capacity: 5,
  watchdog_report_worker_capacity: 5,
  order_lifecycle_worker_capacity: 5,
  ledger_reconciliation_worker_capacity: 5,
  performance_report_worker_exit: 15,
  performance_report_deadline: 30,
}
// V3 M2b (M2 check nit 2): a report that exceeded one of its FIXED bounds —
// performance_report_group_bound / _median_bound / _response_bound,
// order_lifecycle_response_bound, report_session_window_bound — exceeds it
// again on every retry: the recorded data only grows. It is unavailable, but
// never offered as retryable: no retry hint, retryable false.
const FIXED_BOUND = /_bound$/
// V3 M2b (M2 check nit 1): the driver's own words for a failure with no
// named code ("no such column: x", "unable to open database file", a worker
// out-of-memory). Before M2 these routes answered 500 {error: err.message};
// M2 kept only the generic reason, so a builder bug that fails every time
// read as a temporary outage forever. Bounded; carried as `detail`.
const DETAIL_MAX_CHARS = 300
export class ReportUnavailableError extends Error {
  constructor(cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(message, { cause })
    this.name = 'ReportUnavailableError'
    // Named failure codes pass through; a raw driver message (a SQLite error,
    // a worker crash) is reported as one generic code, not echoed as a reason.
    this.reason = /^[a-z][a-z0-9_]{2,63}$/.test(message) ? message : 'performance_report_worker_error'
    this.retryable = !FIXED_BOUND.test(this.reason)
    this.retryAfterSec = this.retryable ? (RETRY_AFTER_SEC[this.reason] ?? 30) : null
    this.detail = this.reason === 'performance_report_worker_error' ? message.slice(0, DETAIL_MAX_CHARS) : null
  }
}
export const isReportUnavailable = error => error instanceof ReportUnavailableError
const unavailable = error => { throw isReportUnavailable(error) ? error : new ReportUnavailableError(error) }

const flights = new WeakMap()
const watchdogFlights = new WeakMap()
const lifecycleFlights = new WeakMap()
const reconciliationFlights = new WeakMap()
// kind → its own bounded pool. The watchdog is polled independently and must
// not compete with slow dashboard reports. Each reserved slot is held until
// the worker exits. The storage walk has its own single walk per database
// (readStorageReport below), never one of the shared slots.
const RESERVED_POOLS = {
  'node-watchdog': { pool: watchdogFlights, capacity: 1, error: 'watchdog_report_worker_capacity' },
  // V3 L1: the order-lifecycle flags. Their own reserved pool so the two
  // dashboard slots cannot starve them (nor they them); identical requests —
  // the 10-minute snapshot and the Reasons page's ?account=all — share one
  // job. Two slots, not one: a slot is held until its worker EXITS, which can
  // trail its answer, so with one slot a per-account read right after the
  // all-accounts read was refused with a capacity 503 (measured in the full
  // parallel gate). A third concurrent distinct read is still an explicit 503.
  'order-lifecycle': { pool: lifecycleFlights, capacity: 2, error: 'order_lifecycle_worker_capacity' },
  // V3 B2: the ledger-versus-broker reconciliation. Its own slot, so an owner
  // reading it cannot take a dashboard's; identical requests share one job.
  'ledger-reconciliation': { pool: reconciliationFlights, capacity: 1, error: 'ledger_reconciliation_worker_capacity' },
}
const SHARED_POOL = { pool: flights, capacity: 2, error: 'performance_report_worker_capacity' }
// Production profiling measured the legacy prices/decision scans at up to
// ~47s/~24s. Isolation protects the event loop; these two preserve their
// exact historical output instead of converting a slow-but-valid report
// into a 15s error while follow-up query optimisation is measured.
const REPORT_DEADLINE_MS = { 'latest-prices': 60000, 'decision-audit': 60000, 'decisions-daily': 30000 }
const DEFAULT_REPORT_DEADLINE_MS = 15000
// GET /state/storage (V3 M2b, M2 check nit 9) — see readStorageReport.
// answerMs: the answer deadline, inside the route's 60 s bound; hardMs: a
// walk still running is asked to stop (before its next statement, keeping
// what it measured); cooldownMs: a measurement younger than
// this is served instead of walking again; stopWaitMs: how long a stop waits
// for the worker to exit; busyTimeoutMs: the walk's SQLite busy wait, the
// same 1 s every report worker uses.
const STORAGE_TIMING = { answerMs: 50_000, hardMs: 180_000, cooldownMs: 300_000, stopWaitMs: 30_000, busyTimeoutMs: 1000 }
let timingOverride = null
const reportDeadlineMs = kind => timingOverride?.deadlineMs?.[kind] ?? REPORT_DEADLINE_MS[kind] ?? DEFAULT_REPORT_DEADLINE_MS
const storageTiming = () => ({ ...STORAGE_TIMING, ...timingOverride?.storage })
/**
 * TESTS ONLY (V3 M2b, M2 check nit 4): shorten report deadlines and the
 * storage walk's timing so a real worker timeout can be exercised end to end
 * through a route, instead of only by constructing the error object.
 * `{ deadlineMs: { 'decisions-daily': 200 }, storage: { answerMs: 300 } }`.
 * Returns the function that restores the previous timing.
 */
export function overrideReportTimingForTest(overrides) {
  const previous = timingOverride
  timingOverride = overrides
  return () => { timingOverride = previous }
}
/** Disk-backed reads stay off the protection event loop: at most two report
 * workers and one reserved watchdog worker per database (plus the reserved
 * order-lifecycle pool and the single storage walk), bounded until exit.
 * Every failure rejects as ReportUnavailableError. */
function isolatedReport(db, kind, options = {}) {
  const run = () => buildReport(db, kind, options)
  if (db.memory || db.name === ':memory:') return run().catch(unavailable)
  const { pool, capacity, error: capacityError } = RESERVED_POOLS[kind] || SHARED_POOL
  if (!pool.has(db)) pool.set(db, new Map())
  const active = pool.get(db), key = JSON.stringify([kind, options])
  if (active.has(key)) return active.get(key)
  if (active.size >= capacity) return Promise.reject(new ReportUnavailableError(new Error(capacityError)))
  const job = new Promise((resolve, reject) => {
    let worker
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { path: db.name, kind, options }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    } catch (error) {
      queueMicrotask(() => active.delete(key))
      reject(error)
      return
    }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); void worker.terminate()
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('performance_report_deadline')), reportDeadlineMs(kind))
    worker.once('message', msg => finish(msg.ok ? null : new Error(msg.error), msg.report))
    worker.once('error', error => finish(error))
    worker.once('exit', () => {
      // A timed-out native SQLite call may not terminate immediately. Keep its
      // capacity slot until the worker actually exits, preventing retry storms
      // from starting unbounded workers against the protection database.
      active.delete(key)
      if (!settled) finish(new Error('performance_report_worker_exit'))
    })
  }).catch(unavailable)
  active.set(key, job)
  return job
}
export function readPerformancePopulations(db, options) { return isolatedReport(db, 'populations', options) }
export function readPerformanceAnalytics(db, options) { return isolatedReport(db, 'analytics', options) }
export function readCupHandleFunnel(db, options) { return isolatedReport(db, 'cup-funnel', options) }
export function readDecisionsDaily(db, options) { return isolatedReport(db, 'decisions-daily', options) }
export function readLatestPrices(db) { return isolatedReport(db, 'latest-prices') }
export function readStageMatrixStats(db) { return isolatedReport(db, 'stage-matrix-stats') }
export function readDecisionAudit(db, options) { return isolatedReport(db, 'decision-audit', options) }
export function readNodeWatchdogContract(db, options) { return isolatedReport(db, 'node-watchdog', options) }
/** V3 C4 (WP-C PR-C1): GET /state/blocker-report, off the protection event
 * loop — up to 90 days of three logs plus the tick arm. Pass no `now`: the
 * in-flight dedupe keys on the options, and a millisecond clock would give
 * every dashboard request its own worker slot. */
export function readBlockerReport(db, options) { return isolatedReport(db, 'blocker-report', options) }
export function readAccountEngineering(db) { return isolatedReport(db, 'account-engineering') }
export function readPostmortemReport(db, options) { return isolatedReport(db, 'postmortems', options) }
// ---------------------------------------------------------------------------
// GET /state/storage and POST /actions/storage-purge (V3 M2b, M2 check nit 9).
//
// The walk (dbstat over every page, COUNT(*) per table) runs on a read-only
// worker, never on the event loop that runs protection. It measured 20.99 s
// at 08:39Z on 25-09 and then grew past its 60 s bound, so the route answered
// 503 every time and discarded the walk it had paid for — and the next
// request started another full walk against the protection database's disk.
// Now:
//   - the worker reports what it has measured as it goes (storageReport's
//     progress snapshots);
//   - at the answer deadline (inside the 60 s bound) the caller gets that
//     snapshot: status 'partial', partialReason 'answer_deadline', the tables
//     not yet walked named in `unmeasured` with null values. A measured
//     number or null — never an estimate;
//   - the walk is NOT killed at the answer deadline. It runs on, bounded by
//     hardMs, and its result is kept;
//   - a measurement younger than cooldownMs is served, labelled
//     served.source 'cache' with its age, instead of walking again;
//   - one walk per database at a time, held until its worker exits.
// Every answer carries `served`: where it came from, when, and whether a
// walk is still running.
// ---------------------------------------------------------------------------
const storageWalks = new WeakMap() // db → { flight, last, lastFailure }
const storageState = db => {
  let state = storageWalks.get(db)
  if (!state) storageWalks.set(db, state = { flight: null, last: null, lastFailure: null })
  return state
}
function servedStorage(report, { source, walkRunning, partialReason = null, state = null }) {
  const now = Date.now(), measuredAtMs = Date.parse(report?.at)
  const served = { source, answeredAt: new Date(now).toISOString(),
    ageMs: Number.isFinite(measuredAtMs) ? Math.max(0, now - measuredAtMs) : null, walkRunning }
  if (source === 'cache' && state?.lastFailure) served.lastWalkFailed = { ...state.lastFailure }
  return partialReason ? { ...report, status: 'partial', partialReason, served } : { ...report, served }
}
function joinStorageWalk(state, flight) {
  if (!flight.answered) return flight.answer
  // Past the answer deadline with the walk still running: what it has
  // measured by now, not the snapshot the first caller got.
  if (flight.progress) return Promise.resolve(servedStorage(flight.progress, { source: 'walk', walkRunning: true, partialReason: 'answer_deadline' }))
  if (state.last) return Promise.resolve(servedStorage(state.last.report, { source: 'cache', walkRunning: true, state }))
  return Promise.reject(new ReportUnavailableError(new Error('performance_report_deadline')))
}
function startStorageWalk(db, state) {
  const timing = storageTiming()
  // The walk is stopped cooperatively — a shared flag it reads before every
  // statement — never with Worker.terminate(): terminating inside a
  // better-sqlite3 call that then throws aborts the whole process
  // (storage-report.js, shouldStop).
  const stopFlag = new Int32Array(new SharedArrayBuffer(4))
  let worker
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { path: db.name, kind: 'storage', options: {}, busyTimeoutMs: timing.busyTimeoutMs, stopFlag }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
  } catch (error) {
    return Promise.reject(new ReportUnavailableError(error))
  }
  const flight = { startedAtMs: Date.now(), progress: null, answered: false, stopReason: null }
  flight.requestStop = reason => { flight.stopReason ??= reason; Atomics.store(stopFlag, 0, 1) }
  let resolveAnswer, rejectAnswer, markExited
  flight.answer = new Promise((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject })
  flight.exited = new Promise(resolve => { markExited = resolve })
  state.flight = flight
  let finished = false
  const answer = fn => { if (flight.answered) return; flight.answered = true; clearTimeout(answerTimer); fn() }
  // A failed walk never replaces the last measurement; that measurement is
  // served (labelled with the failure) when there is one.
  const failWalk = error => {
    state.lastFailure = { reason: error.reason, ...(error.detail ? { detail: error.detail } : {}), atMs: Date.now() }
    answer(() => state.last
      ? resolveAnswer(servedStorage(state.last.report, { source: 'cache', walkRunning: false, state }))
      : rejectAnswer(error))
  }
  const answerTimer = setTimeout(() => answer(() => {
    if (flight.progress) resolveAnswer(servedStorage(flight.progress, { source: 'walk', walkRunning: true, partialReason: 'answer_deadline' }))
    else if (state.last) resolveAnswer(servedStorage(state.last.report, { source: 'cache', walkRunning: true, state }))
    else rejectAnswer(new ReportUnavailableError(new Error('performance_report_deadline')))
  }), timing.answerMs)
  const hardTimer = setTimeout(() => flight.requestStop('hard_bound'), timing.hardMs)
  worker.on('message', msg => {
    if (msg?.progress) { flight.progress = msg.progress; return }
    if (finished) return
    finished = true
    if (msg?.ok) {
      // A walk that stopped on request says why it is partial.
      const report = flight.stopReason && msg.report?.status === 'partial' ? { ...msg.report, partialReason: flight.stopReason } : msg.report
      state.last = { report, atMs: Date.now() }; state.lastFailure = null
      answer(() => resolveAnswer(servedStorage(report, { source: 'walk', walkRunning: false })))
    } else failWalk(new ReportUnavailableError(new Error(msg?.error)))
  })
  worker.once('error', error => { if (!finished) { finished = true; failWalk(new ReportUnavailableError(error)) } })
  worker.once('exit', () => {
    clearTimeout(answerTimer); clearTimeout(hardTimer)
    if (!finished) {
      finished = true
      // Gone without a final word (a crash, the heap limit): what it had
      // reported measuring is kept as a partial measurement, named so.
      if (flight.progress) {
        const partial = { ...flight.progress, status: 'partial', partialReason: 'worker_exit' }
        state.last = { report: partial, atMs: Date.now() }
        answer(() => resolveAnswer(servedStorage(partial, { source: 'walk', walkRunning: false })))
      } else failWalk(new ReportUnavailableError(new Error('performance_report_worker_exit')))
    }
    if (state.flight === flight) state.flight = null
    markExited()
  })
  return flight.answer
}
/**
 * Stop the running storage walk of `db`, if any — it stops before its next
 * statement and keeps what it measured — and wait (bounded by stopWaitMs)
 * for its worker to exit. POST /actions/storage-purge calls this before its
 * WAL checkpoint and compact, so no walk holds a read snapshot across them.
 * @returns {Promise<boolean>} true when no walk is running any more
 */
export function stopStorageWalk(db) {
  const flight = storageWalks.get(db)?.flight
  if (!flight) return Promise.resolve(true)
  flight.requestStop('stopped')
  let timer
  return Promise.race([flight.exited.then(() => true), new Promise(resolve => { timer = setTimeout(resolve, storageTiming().stopWaitMs, false) })])
    .finally(() => clearTimeout(timer))
}
/**
 * GET /state/storage: the storage report, answered inside its deadline — a
 * complete walk, the partial walk so far, or the last measurement served
 * from cache, each labelled (see the section comment above). Rejects as
 * ReportUnavailableError only when there is nothing measured to answer with.
 * `fresh`: never the cooldown cache, and never a walk that started before
 * this call — a running one is stopped and a new one started (the purge's
 * before/after measurements).
 */
export function readStorageReport(db, { fresh = false } = {}) {
  if (db.memory || db.name === ':memory:') {
    return Promise.resolve().then(() => servedStorage(storageReport(db), { source: 'walk', walkRunning: false })).catch(unavailable)
  }
  const state = storageState(db)
  if (!fresh && state.last && Date.now() - state.last.atMs < storageTiming().cooldownMs) {
    return Promise.resolve(servedStorage(state.last.report, { source: 'cache', walkRunning: !!state.flight, state }))
  }
  if (!state.flight) return startStorageWalk(db, state)
  if (!fresh) return joinStorageWalk(state, state.flight)
  const stale = state.flight
  return stopStorageWalk(db).then(() => {
    if (state.flight === stale) throw new ReportUnavailableError(new Error('storage_report_worker_capacity'))
    // A walk another caller started after this call is as fresh as ours.
    return state.flight ? joinStorageWalk(state, state.flight) : startStorageWalk(db, state)
  })
}
/** GET /state/order-lifecycle and the order_lifecycle controller (V3 L1). */
export function readOrderLifecycle(db, options) { return isolatedReport(db, 'order-lifecycle', options) }
/** GET /state/ledger-reconciliation (V3 B2): per account, native currency, off the event loop. */
export function readLedgerReconciliation(db, options) { return isolatedReport(db, 'ledger-reconciliation', options) }
/** GET /state/calendar-coverage (V3 K1): every demanded calendar is read, so
 * off the event loop. No `now` from the route: the in-flight dedupe keys on
 * the options. */
export function readCalendarCoverage(db, options) { return isolatedReport(db, 'calendar-coverage', options) }
export function buildDecisionsDaily(db, { days = 90, accountId = null, timeZone = null } = {}) {
  const safeDays = Math.min(365, Math.max(1, Number(days) || 90))
  const clauses = ["created_at >= datetime('now', ?)"]
  const params = [`-${safeDays} days`]
  if (accountId != null && accountId !== 'all') { clauses.push(timeZone ? 'account_id = ?' : '(account_id = ? OR account_id IS NULL)'); params.push(String(accountId)) }
  const rows = db.prepare(
    `SELECT ${timeZone ? "strftime('%Y-%m-%dT%H:%M:00Z', created_at)" : 'substr(created_at, 1, 10)'} AS day,
            SUM(approved = 1) AS approved,
            SUM(CASE WHEN approved = 1 THEN 0 ELSE COALESCE(repeat_count, 1) END) AS vetoed,
            SUM(approved != 1 OR approved IS NULL) AS vetoed_distinct
       FROM risk_events
      WHERE ${clauses.join(' AND ')}
      GROUP BY day ORDER BY day`
  ).all(...params)
  if (!timeZone) return rows
  const byDay = new Map()
  for (const r of rows) {
    if (!Number.isFinite(Date.parse(r.day))) continue
    const day = calendarDate(Date.parse(r.day), timeZone)
    if (!byDay.has(day)) byDay.set(day, { day, approved: 0, vetoed: 0, vetoed_distinct: 0 })
    const b = byDay.get(day)
    for (const k of ['approved', 'vetoed', 'vetoed_distinct']) b[k] += r[k] || 0
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}
export function buildLatestPrices(db) {
  const rows = db.prepare(`
    SELECT symbol, price, bias, confidence, scanned_at
    FROM scans
    WHERE id IN (SELECT MAX(id) FROM scans WHERE price IS NOT NULL GROUP BY symbol)
    ORDER BY symbol
  `).all()
  const prices = {}
  for (const r of rows) prices[r.symbol] = { price: r.price, bias: r.bias, confidence: r.confidence, at: r.scanned_at }
  return prices
}
async function buildReport(db, kind, options, hooks = {}) {
  if (kind === 'postmortems') {
    const { postmortemReport } = await import('./postmortem-report.js')
    return db.transaction(() => postmortemReport(db, options))()
  }
  if (kind === 'account-engineering') {
    const { engineeringView } = await import('./account-engineering.js')
    // The account panel aggregates retained decisions. Keep the coherent
    // read-only snapshot off management, using the existing report bounds.
    return db.transaction(() => engineeringView(db))()
  }
  if (kind === 'node-watchdog') {
    const { nodeWatchdogContract } = await import('./watchdog-contract.js')
    // All account/work/calendar reads describe one database snapshot. The
    // builder retains its original receipt times; completion is not freshness.
    return db.transaction(() => nodeWatchdogContract(db, options))()
  }
  if (kind === 'blocker-report') {
    const { blockerReport, tickEntryEvaluation } = await import('./blocker-report.js')
    // One snapshot for the population and the tick evaluation beside it.
    return db.transaction(() => ({ ...blockerReport(db, options), tick: tickEntryEvaluation(db, options) }))()
  }
  // The storage walk reports what it has measured as it goes (hooks.onProgress
  // posts it to the main thread), so its reader can answer a truthful partial.
  if (kind === 'storage') return storageReport(db, { onProgress: hooks.onProgress ?? null, shouldStop: hooks.shouldStop })
  if (kind === 'order-lifecycle') {
    const { buildOrderLifecycle, RESPONSE_MAX_BYTES } = await import('./order-lifecycle.js')
    // One consistent snapshot across every rule's read, as node-watchdog does.
    const report = db.transaction(() => buildOrderLifecycle(db, options))()
    // The main thread structured-clones and serialises this: bounded here,
    // before postMessage, far below the generic 8 MB bound.
    if (Buffer.byteLength(JSON.stringify(report)) > RESPONSE_MAX_BYTES) throw new Error('order_lifecycle_response_bound')
    return report
  }
  if (kind === 'ledger-reconciliation') {
    const { buildLedgerReconciliation } = await import('./ledger-reconciliation.js')
    // One snapshot across trades, receipts and verdicts.
    return db.transaction(() => buildLedgerReconciliation(db, options))()
  }
  if (kind === 'calendar-coverage') {
    const { buildCalendarCoverage } = await import('./calendar-coverage.js')
    // One snapshot across the demand, the export and every calendar read.
    return db.transaction(() => buildCalendarCoverage(db, options))()
  }
  if (kind === 'cup-funnel') return cupHandleFunnel(db, options)
  if (kind === 'analytics') return accountAnalytics(db, { ...options, unstamped: 'exclude', reporting: true })
  if (kind === 'decisions-daily') return buildDecisionsDaily(db, options)
  if (kind === 'latest-prices') return buildLatestPrices(db)
  if (kind === 'stage-matrix-stats') {
    // Keep the common funnel/population worker lightweight. Loading the stage
    // registry only for this report also avoids widening unrelated worker
    // module graphs during the full parallel test gate.
    const [{ stageMatrixStats }, { getState }] = await Promise.all([import('./stage-matrix.js'), import('../db.js')])
    return stageMatrixStats(db, getState)
  }
  if (kind === 'decision-audit') {
    const { auditDecisions } = await import('./decision-audit.js')
    return auditDecisions(db, {
      accountId: options?.accountId ?? null,
      marketOpen: options?.marketOpen !== false,
      now: Number.isFinite(Number(options?.nowMs)) ? new Date(Number(options.nowMs)) : new Date(),
    })
  }
  return buildPerformancePopulations(db, options)
}
if (!isMainThread && workerData?.path) {
  let db
  try {
    db = new Database(workerData.path, { readonly: true, fileMustExist: true, timeout: workerData.busyTimeoutMs ?? 1000 })
    // Keep this module synchronous on import. Specialized reports load their
    // larger registries lazily inside the worker; the promise is resolved here
    // without turning every importer into an async ESM module.
    const stopFlag = workerData.stopFlag
    const hooks = workerData.kind === 'storage'
      ? { onProgress: progress => parentPort.postMessage({ progress }), shouldStop: () => !!stopFlag && Atomics.load(stopFlag, 0) === 1 }
      : {}
    Promise.resolve(buildReport(db, workerData.kind, workerData.options, hooks))
      .then(report => {
        if (Buffer.byteLength(JSON.stringify(report)) > 8 * 1024 * 1024) throw new Error('performance_report_response_bound')
        parentPort.postMessage({ ok: true, report })
      })
      .catch(e => parentPort.postMessage({ ok: false, error: e.message }))
      .finally(() => db?.close())
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message })
    db?.close()
  }
}
