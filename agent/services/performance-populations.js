import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { accountAnalytics } from './account-analytics.js'
import { ledgerWindows, classifyOutcome, plannedRr } from './perf-ledger.js'
import { realisedRR, checkTradeConsistency } from './trade-consistency.js'
import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { categorize, MARKETS, closedAtMs, dayAnchorMs, isFxWeekend } from '../shared/formulas.js'
import { emptyPopulation, REPORT_SESSIONS } from '../shared/performance-populations.js'
import { cupHandleFunnel } from './cup-handle-funnel.js'

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
export function buildPerformancePopulations(db, { now = Date.now(), maxGroups = 24000, deadlineMs = 12000 } = {}) {
  const started = performance.now(), day0 = dayAnchorMs(now), weekend = isFxWeekend(now)
  const sessionFrom = weekend ? day0 - DAY : day0, sessionTo = weekend ? day0 : now
  const defs = [...ledgerWindows(now).map(w => ({ ...w, ledger: true })),
    { key: '24h', from: now - DAY, to: now }, { key: 'day', from: day0, to: now },
    ...REPORT_SESSIONS.map(s => ({ key: `session:${s.key}`, from: sessionFrom, to: sessionTo, session: s })),
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
    const minute = Math.floor(t / 60000) % 1440
    const day = new Date(t).toISOString().slice(0, 10), dailyKey = JSON.stringify([accountId, day])
    if (!daily.has(dailyKey)) {
      if (++groups > maxGroups) throw new Error('performance_report_group_bound')
      daily.set(dailyKey, { accountId, day, stats: emptyPopulation() })
    }
    fold(daily.get(dailyKey).stats, r)
    for (let i = 0; i < defs.length; i++) {
      const w = defs[i]
      if (t < w.from || t >= w.to || (w.session && !(minute >= w.session.fromMin && minute < w.session.toMin))
        || (w.off && REPORT_SESSIONS.some(s => minute >= s.fromMin && minute < s.toMin))) continue
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
  return { schemaVersion: 1, status: 'complete', generatedAt: new Date(now).toISOString(), asOfMs: now,
    population: 'all_recorded_closes', currency: null, moneyPolicy: 'recorded_units_within_one_stamped_account_only',
    markets: MARKETS, coverage, windows, daily: [...daily.values()], bestByAccount: Object.fromEntries(best),
    lastCloseByAccount: Object.fromEntries([...last].map(([a, t]) => [a, new Date(t).toISOString()])),
    openByAccount: db.prepare('SELECT account_id,count(*) AS n FROM monitored_positions WHERE status=\'active\' GROUP BY account_id').all(),
    sessionWindow: { from: sessionFrom, to: sessionTo, weekend, source: 'fixed_UTC_reporting_buckets_not_market_status' } }
}

const flights = new WeakMap()
/** Disk-backed reports run in one read-only worker per database, off the
 * protection event loop, within a deadline and bounded response. */
function isolatedReport(db, kind, options = {}) {
  const run = () => buildReport(db, kind, options)
  if (db.memory || db.name === ':memory:') return Promise.resolve(run())
  if (!flights.has(db)) flights.set(db, new Map())
  const active = flights.get(db), key = JSON.stringify([kind, options])
  if (active.has(key)) return active.get(key)
  if (active.size >= 2) return Promise.reject(new Error('performance_report_worker_capacity'))
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
    const timer = setTimeout(() => finish(new Error('performance_report_deadline')), 15000)
    worker.once('message', msg => finish(msg.ok ? null : new Error(msg.error), msg.report))
    worker.once('error', error => finish(error))
    worker.once('exit', () => {
      // A timed-out native SQLite call may not terminate immediately. Keep its
      // capacity slot until the worker actually exits, preventing retry storms
      // from starting unbounded workers against the protection database.
      active.delete(key)
      if (!settled) finish(new Error('performance_report_worker_exit'))
    })
  })
  active.set(key, job)
  return job
}
export function readPerformancePopulations(db) { return isolatedReport(db, 'populations') }
export function readPerformanceAnalytics(db, options) { return isolatedReport(db, 'analytics', options) }
export function readCupHandleFunnel(db, options) { return isolatedReport(db, 'cup-funnel', options) }
function buildReport(db, kind, options) {
  if (kind === 'cup-funnel') return cupHandleFunnel(db, options)
  if (kind === 'analytics') return accountAnalytics(db, { ...options, unstamped: 'exclude', reporting: true })
  return buildPerformancePopulations(db)
}
if (!isMainThread && workerData?.path) {
  let db
  try {
    db = new Database(workerData.path, { readonly: true, fileMustExist: true, timeout: 1000 })
    const report = db.transaction(() => buildReport(db, workerData.kind, workerData.options))()
    if (Buffer.byteLength(JSON.stringify(report)) > 8 * 1024 * 1024) throw new Error('performance_report_response_bound')
    parentPort.postMessage({ ok: true, report })
  } catch (e) { parentPort.postMessage({ ok: false, error: e.message }) }
  finally { db?.close() }
}
