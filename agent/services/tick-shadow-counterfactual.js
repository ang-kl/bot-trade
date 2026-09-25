// ---------------------------------------------------------------------------
// agent/services/tick-shadow-counterfactual.js — plan P2 (25-09-2026): the
// shadow book's recent trades RE-SCORED with the two live filters the shadow
// does not apply, to answer "can filtering lift both PF and win rate, and
// what does each veto cost?" (owner principle 7) before anything goes live.
//
// REPORT ONLY. Nothing here is read by an entry path; no threshold, cap or
// config is written.
//
// The two filters, copied from what live does:
//   stop floor    — tick_firer.cpp:148-150: refuse when
//                   stopDistance < llround(minStopFraction × entry), both in
//                   wire units, and only when minStopFraction > 0. The
//                   shadow row stores stop_distance and entry in the same
//                   wire units. minStopFraction is read from
//                   agent/config/tick-entry.json (loadTickEntryConfig).
//   counter-trend — the permit feeder withholds the against-trend side:
//                   permittedSides(trendReadingFor(db, symbol))
//                   (tick-permits.js, direction-policy.js). Re-scored on the
//                   reading AS OF entry_ms — the same answer as
//                   trendReadingAt(db, symbol, entry_ms), never a later row —
//                   through asOfTrendReader below. The feeder reads it when it
//                   reserves the permit, not at the fill; entry_ms is within
//                   the permit TTL of that moment.
//
// A row either filter would remove is `removed`; every other row is `kept`,
// so kept + removed = the population, row for row. A row with no regime
// reading (none within maxRegimeAgeMin, the symbol unmapped, or the gate
// off) is KEPT — live grants both sides with no reading — and counted.
//
// NOT RE-SCORED, because the shadow row does not carry what they need: the
// price bound and pending-signal expiry (no signal price or signal time
// stored), and the feeder's per-account refusals (max positions, a position
// already open, lot size and sizing — the shadow row has no account).
//
// Known limits, stated in the reply: the CURRENT config and gate are used,
// not the historical ones; trades are removed one at a time, so freed slots,
// cooldowns and a different next signal are not modelled; regimes are kept
// ~29–30 days (loop.js prune, a date-format mismatch deletes the whole cutoff
// day), so the first day of a 30-day window may read no regime; symbol ids are
// named through the side's FIRST account's map (a shadow row carries no
// account), which is right only while the side's accounts share symbol ids.
//
// BOUNDED (PR #1086 review, blocker 3). The first version re-read the gate
// config and ran one regime query PER ROW and bootstrapped kept and removed
// as well as the population, synchronously on the Node thread: 1.6–1.8 s at
// 9,000 rows a side, 9.6 s at the 50,000-row limit. Now:
//   - the window is at most MAX_COUNTERFACTUAL_DAYS (30): regimes are pruned
//     at about that age, so past it every row read "no regime" and was kept —
//     the kept/removed split stopped being a trend filter;
//   - the gate config is read ONCE, and each symbol's regime rows for
//     [earliest entry − maxRegimeAgeMin, latest entry] are read with ONE
//     query and binary-searched per trade (asOfTrendReader);
//   - only the population is bootstrapped: kept and removed carry PF, win
//     rate and net R (splitStats), which is what the question asks of them;
//   - a truncated read keeps the NEWEST rows (the counterfactual of the most
//     recent trading, not of the oldest slice of the window);
//   - the route's view is memoised for 60 s per database, side and window.
// ---------------------------------------------------------------------------

import { SIDES, sharedShadowTrades, portfolioStats, sideAccounts } from './tick-shadow.js'
import { symbolNameResolver } from './tick-shadow-accounts.js'
import { loadTickEntryConfig } from './tick-permits.js'
import { permittedSides } from './direction-policy.js'
import { loadRegimeGateConfig, DEFAULT_MAX_REGIME_AGE_MIN } from './regime-gate.js'
import { stateEpoch } from '../lib/state-cache.js'

export const COUNTERFACTUAL_ROW_LIMIT = 50_000

/** Regimes are pruned at about 30 days: a longer window reads "no regime" past it. */
export const MAX_COUNTERFACTUAL_DAYS = 30

/** How long the route's view is reused before it is recomputed. */
export const COUNTERFACTUAL_MEMO_MS = 60_000

const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const stampMs = (at) => Date.parse(String(at || '').replace(' ', 'T') + (String(at || '').endsWith('Z') ? '' : 'Z'))

/**
 * The trend reading AS OF a moment, for every trade of one window, with the
 * gate config read ONCE and each symbol's regime rows read by ONE query.
 *
 * Row for row the same answer as direction-policy.js trendReadingAt(db,
 * symbol, asOfMs) (the test pins the two against each other): the newest row
 * with computed_at <= the as-of stamp (the same string compare, the highest
 * id on a tie, as latestRegime's index scan), aged against the as-of moment
 * under maxRegimeAgeMin, stale → null, gate off → null. Rows older than
 * [minAsOfMs − maxRegimeAgeMin] are not read: were one of them the newest at
 * or before a trade, it would be stale for that trade, and a newer row in
 * the window always wins.
 *
 * @returns {{reading: (symbol: string, asOfMs: number) => string|null, queries: () => number}}
 */
export function asOfTrendReader(db, { gate = loadRegimeGateConfig(db), minAsOfMs, maxAsOfMs }) {
  let queries = 0
  // PR-Q3: `rowsFor` hands one symbol's loaded rows to a reader that has no
  // database (the replay worker), which answers through trendReadingFromRows
  // — the same function `reading` uses, so the two cannot drift.
  if (!gate?.on) return { reading: () => null, queries: () => queries, rowsFor: () => [], maxRegimeAgeMin: null }
  const bound = Number(gate.maxRegimeAgeMin === undefined ? DEFAULT_MAX_REGIME_AGE_MIN : gate.maxRegimeAgeMin)
  const hi = sqlStamp(Number(maxAsOfMs))
  const lo = bound > 0 && Number.isFinite(Number(minAsOfMs)) ? sqlStamp(Number(minAsOfMs) - bound * 60_000 - 1000) : null
  let stmt = null
  try {
    stmt = db.prepare(`SELECT id, trend_direction, computed_at FROM regimes
                        WHERE symbol = ?${lo ? ' AND computed_at >= ?' : ''} AND computed_at <= ?
                        ORDER BY computed_at, id`)
  } catch { stmt = null }
  const bySymbol = new Map()
  const rowsOf = (symbol) => {
    if (!bySymbol.has(symbol)) {
      let rows = []
      if (stmt) {
        queries++
        try { rows = lo ? stmt.all(symbol, lo, hi) : stmt.all(symbol, hi) } catch { rows = [] }
      }
      bySymbol.set(symbol, rows.map(r => ({ at: String(r.computed_at), dir: r.trend_direction ?? null })))
    }
    return bySymbol.get(symbol)
  }
  const reading = (symbol, asOfMs) => {
    if (!Number.isFinite(Number(asOfMs))) return null
    return trendReadingFromRows(rowsOf(symbol), asOfMs, bound)
  }
  return { reading, queries: () => queries, rowsFor: (symbol) => rowsOf(symbol), maxRegimeAgeMin: bound }
}

/**
 * The reading AS OF a moment over ONE symbol's rows ([{ at, dir }], ordered
 * by computed_at then id, as asOfTrendReader loads them): the newest row whose
 * stamp is <= the as-of stamp, aged under `maxRegimeAgeMin` (not > 0 = no
 * bound), stale → null. Pure — asOfTrendReader's `reading` is this over its
 * query, and the replay worker (PR-Q3) is this over the rows it was handed.
 */
export function trendReadingFromRows(rows, asOfMs, maxRegimeAgeMin) {
  const asOf = Number(asOfMs)
  if (!Number.isFinite(asOf) || !Array.isArray(rows)) return null
  const key = sqlStamp(asOf)
  let a = 0, b = rows.length   // the first index whose stamp is > key
  while (a < b) { const m = (a + b) >> 1; if (rows[m].at <= key) a = m + 1; else b = m }
  if (a === 0) return null
  const row = rows[a - 1]
  const bound = Number(maxRegimeAgeMin)
  if (!(bound > 0)) return row.dir
  const t = stampMs(row.at)
  if (!Number.isFinite(t)) return null
  return (asOf - t) / 60_000 > bound ? null : row.dir
}

/**
 * Kept and removed need PF and win rate only (the question is "does the
 * filter lift both?"), not the bootstrap: the same counting as tick-shadow.js
 * portfolioStats for these fields (the test pins them equal), without its
 * three resampling passes.
 */
export function splitStats(rows) {
  let grossWin = 0, grossLoss = 0, net = 0, wins = 0, losses = 0, n = 0, lost = 0
  for (const t of rows) {
    if ((t.reason || 'unknown') === 'lost_restart') { lost++; continue }
    const r = Number(t.net_r ?? t.netR)
    if (!Number.isFinite(r)) continue
    n++; net += r
    if (r > 0) { grossWin += r; wins++ } else { grossLoss += -r; if (r < 0) losses++ }
  }
  return {
    trades: n, wins, losses, winPct: n ? +(100 * wins / n).toFixed(1) : null,
    netR: +net.toFixed(4), avgR: n ? +(net / n).toFixed(4) : null,
    grossWinR: +grossWin.toFixed(4), grossLossR: +grossLoss.toFixed(4),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null,
    lost,
  }
}

/** The firer's floor, in wire units: llround(frac × entry), 0 when frac is not > 0. */
export function stopFloorWire(minStopFraction, entryWire) {
  const f = Number(minStopFraction)
  return f > 0 ? Math.round(f * Number(entryWire)) : 0
}

/**
 * One side's counterfactual over the last `days`.
 */
export function shadowCounterfactual(db, { side, profilePrefix = null, days = 30, now = Date.now(), minStopFraction = loadTickEntryConfig().minStopFraction, limit = COUNTERFACTUAL_ROW_LIMIT, gate = loadRegimeGateConfig(db) } = {}) {
  const span = Math.min(MAX_COUNTERFACTUAL_DAYS, Math.max(0, Number(days) || 0))
  const sinceMs = now - span * 86_400_000
  const rows = sharedShadowTrades(db, { side, profilePrefix, sinceMs, limit, newest: true })
  const nameOf = symbolNameResolver(db, sideAccounts(db, side)[0])
  let minEntry = Infinity, maxEntry = -Infinity
  for (const t of rows) { const e = t.entry_ms == null ? NaN : Number(t.entry_ms); if (Number.isFinite(e)) { if (e < minEntry) minEntry = e; if (e > maxEntry) maxEntry = e } }
  const trend = asOfTrendReader(db, { gate, minAsOfMs: minEntry, maxAsOfMs: Number.isFinite(maxEntry) ? maxEntry : now })
  const kept = [], removed = []
  const removedBy = { stopFloor: 0, counterTrend: 0, both: 0 }
  let noRegimeReading = 0, stopUnjudgeable = 0
  const unmapped = new Set()
  for (const t of rows) {
    const sd = Number(t.stop_distance), entry = Number(t.entry)
    let stopRemoved = false
    if (t.stop_distance == null || t.entry == null || !Number.isFinite(sd) || !Number.isFinite(entry) || !(entry > 0)) stopUnjudgeable++
    else stopRemoved = sd < stopFloorWire(minStopFraction, entry)
    let trendRemoved = false
    const rawName = nameOf(t.symbol_id)
    const name = rawName ? rawName.toUpperCase() : null
    if (!name) { unmapped.add(t.symbol_id); noRegimeReading++ } else {
      const reading = trend.reading(name, Number(t.entry_ms))
      if (reading == null) noRegimeReading++
      else trendRemoved = !permittedSides(reading).includes(String(t.trade_side || '').toUpperCase())
    }
    if (stopRemoved && trendRemoved) removedBy.both++
    else if (stopRemoved) removedBy.stopFloor++
    else if (trendRemoved) removedBy.counterTrend++
    ;(stopRemoved || trendRemoved ? removed : kept).push(t)
  }
  const { bootIds: _b, ...population } = portfolioStats(rows)
  const keptSt = splitStats(kept), removedSt = splitStats(removed)
  return {
    side, profile: profilePrefix, days: span, since: new Date(sinceMs).toISOString(),
    rows: rows.length, truncated: rows.length >= limit, limit, truncation: 'the newest rows are kept',
    regimeQueries: trend.queries(),
    population, kept: keptSt, removed: removedSt,
    sumsToPopulation: keptSt.trades + removedSt.trades === population.trades && kept.length + removed.length === rows.length,
    removedBy, noRegimeReading, stopUnjudgeable, unmappedSymbols: [...unmapped].filter(x => x != null).sort((a, b) => a - b),
    minStopFraction, regimeGate: { on: gate.on, maxRegimeAgeMin: gate.maxRegimeAgeMin },
    notRescored: ['price_bound (signal price not stored)', 'pending_expiry (signal time not stored)', 'max_positions', 'position_open', 'lot_size', 'sizing (the shadow row has no account)'],
    note: 'Report only. Current minStopFraction and regime gate, not the historical ones. Removed trades are taken out one at a time — freed slots, cooldowns and different next signals are not modelled, so this is the removed trades\' PF and win rate, not the portfolio that would have resulted. Only the population carries the bootstrap lower bounds; kept and removed carry PF, win rate and net R. The regime reading is as of entry_ms (the feeder reads it at the permit, within the permit TTL). The window is at most 30 days: regimes are kept ~29–30 days, so the first day of a 30-day window may read none; such trades are kept, as live grants both sides. Symbol ids are named through the side\'s first account\'s map.',
  }
}

const memo = new WeakMap()

/**
 * GET /state/tick-shadow-counterfactual: every side, or one. The gate config
 * is read once for every side. Without an explicit `now` (the route) the view
 * is memoised for COUNTERFACTUAL_MEMO_MS per database, side and window, and
 * says so (`memoised`, `computedAt`).
 */
export function shadowCounterfactualView(db, { side = null, days = 30, now = null } = {}) {
  const span = Math.min(MAX_COUNTERFACTUAL_DAYS, Math.max(1, Number(days) || 30))
  const live = now == null
  const at = live ? Date.now() : Number(now)
  const key = `${side ?? '*'}|${span}`
  if (live && db && typeof db === 'object') {
    const hit = memo.get(db)?.get(key)
    // A write on /actions/* (e.g. the regime-gate toggle) bumps stateEpoch():
    // a view computed before it is wrong, not just old (lib/state-cache.js).
    if (hit && hit.epoch === stateEpoch() && at - hit.computedMs < COUNTERFACTUAL_MEMO_MS) return { ...hit.view, memoised: true }
  }
  const gate = loadRegimeGateConfig(db)
  const sides = side ? [side] : SIDES
  const view = {
    at: new Date(at).toISOString(), computedAt: new Date(at).toISOString(), days: span, memoised: false,
    sides: sides.map(s => shadowCounterfactual(db, { side: s, days: span, now: at, gate })),
  }
  if (live && db && typeof db === 'object') {
    if (!memo.has(db)) memo.set(db, new Map())
    memo.get(db).set(key, { computedMs: at, epoch: stateEpoch(), view })
  }
  return view
}
