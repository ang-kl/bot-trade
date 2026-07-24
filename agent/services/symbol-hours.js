// ---------------------------------------------------------------------------
// agent/services/symbol-hours.js — broker-truth market hours per symbol.
//
// Owner (2026-07-17): with 1,900+ instruments, hardcoded category heuristics
// (sessions.js) can't know every symbol's real schedule and holidays. cTrader
// DOES — each ProtoOASymbol carries a `schedule` (trading intervals) and a
// `scheduleTimeZone`. This service pulls those into the persistent
// `symbol_hours` table on the volume, refreshes them periodically as we
// trade, and answers "is SYMBOL open now?" from broker truth. The sessions.js
// heuristic remains the fallback for symbols not yet cached — so this only
// ever IMPROVES accuracy and never regresses an uncached symbol.
//
// cTrader schedule format: `schedule` is an array of { startSecond, endSecond }
// measured from the START OF THE WEEK (Sunday 00:00) in `scheduleTimeZone`
// (an IANA name). We store the intervals + the tz, and at query time convert
// "now" to seconds-into-week IN THAT TZ (DST-correct via Intl) and test
// membership. A symbol with an empty schedule is treated as always-open
// (some CFDs), matching the broker.
// ---------------------------------------------------------------------------

import { isSymbolMarketOpen } from '../lib/sessions.js'

const WEEK_SECONDS = 7 * 24 * 3600

/**
 * Seconds from the start of the week (Sunday 00:00) for `now` expressed in
 * `timeZone`. DST-correct: uses Intl to read the wall-clock weekday/time in
 * that zone. Pure apart from Intl; pass 'UTC' in tests for determinism.
 */
export function secondsIntoWeek(now, timeZone = 'UTC') {
  let parts
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hour12: false,
    })
    parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  } catch {
    // Unknown tz → fall back to UTC wall clock.
    return ((now.getUTCDay() * 24 + now.getUTCHours()) * 60 + now.getUTCMinutes()) * 60 + now.getUTCSeconds()
  }
  const dayIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday] ?? 0
  let hour = parseInt(parts.hour, 10)
  if (hour === 24) hour = 0 // some environments render midnight as 24
  const min = parseInt(parts.minute, 10)
  const sec = parseInt(parts.second, 10)
  return ((dayIdx * 24 + hour) * 60 + min) * 60 + sec
}

/**
 * Is the symbol open at `sow` (seconds-into-week) given its schedule
 * intervals? Empty/missing schedule → open (broker imposes no window).
 * Handles intervals that wrap past the week boundary (start > end).
 * Pure and fully unit-tested.
 */
export function isOpenBySchedule(schedule, sow) {
  if (!Array.isArray(schedule) || schedule.length === 0) return true
  const s = ((sow % WEEK_SECONDS) + WEEK_SECONDS) % WEEK_SECONDS
  for (const iv of schedule) {
    const a = Number(iv.startSecond ?? iv.start)
    const b = Number(iv.endSecond ?? iv.end)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (a <= b) { if (s >= a && s < b) return true }
    else { if (s >= a || s < b) return true } // wraps Sunday boundary
  }
  return false
}

/** Normalise a ProtoOASymbol schedule to plain {start,end} second pairs. */
function normSchedule(sym) {
  const raw = sym?.schedule || sym?.tradingSchedule || []
  return raw.map(iv => ({
    start: Number(iv.startSecond ?? iv.start),
    end: Number(iv.endSecond ?? iv.end),
  })).filter(iv => Number.isFinite(iv.start) && Number.isFinite(iv.end))
}

/**
 * Refresh the symbol_hours table from the broker for the given symbols
 * (names). Fetches full details in batches, upserts schedule + tz. Best
 * effort: a failed batch is skipped, never thrown. deps.fetch is injectable
 * for tests: (symbolIds) => Promise<{ symbol: [ProtoOASymbol] }>.
 *
 * @returns {{ updated: number, batches: number, errors: string[] }}
 */
export async function refreshSymbolHours(db, creds, deps = {}) {
  const getState = deps.getState ?? (await import('../db.js')).getState
  const out = { updated: 0, batches: 0, errors: [] }

  let map = {}
  try { map = JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { map = {} }
  const entries = Object.entries(map) // [SYMBOL, symbolId]
  if (entries.length === 0) return { ...out, errors: ['no symbol map'] }

  const fetch = deps.fetch ?? (async (ids) => {
    const { wsGetSymbolById } = await import('../lib/ctrader-ws.js')
    return wsGetSymbolById(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, ids)
  })

  const idToName = new Map(entries.map(([name, id]) => [String(id), name]))
  // Swap rates ride the same ProtoOASymbol fetch (carry-cost awareness):
  // swapLong/swapShort are the broker's nightly swap in points per lot,
  // swapRollover3Days the triple-swap weekday. NULL when the broker omits
  // them — never defaulted to 0 (0 means "genuinely swap-free").
  const upsert = db.prepare(`
    INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz, swap_long, swap_short, swap_rollover_3days, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ctrader', datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      symbol_id = excluded.symbol_id, schedule_json = excluded.schedule_json,
      tz = excluded.tz, swap_long = excluded.swap_long, swap_short = excluded.swap_short,
      swap_rollover_3days = excluded.swap_rollover_3days,
      source = 'ctrader', updated_at = datetime('now')
  `)
  const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

  const BATCH = Number(deps.batchSize) || 50
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH)
    out.batches++
    try {
      const res = await fetch(chunk.map(([, id]) => Number(id)))
      for (const sym of res?.symbol || []) {
        const name = idToName.get(String(sym.symbolId)) || sym.symbolName
        if (!name) continue
        const schedule = normSchedule(sym)
        const tz = sym.scheduleTimeZone || 'UTC'
        upsert.run(
          String(name).toUpperCase(), Number(sym.symbolId) || null, JSON.stringify(schedule), tz,
          numOrNull(sym.swapLong), numOrNull(sym.swapShort), numOrNull(sym.swapRollover3Days)
        )
        out.updated++
      }
    } catch (err) {
      out.errors.push(`batch ${i / BATCH}: ${err.message}`)
    }
  }
  return out
}

/**
 * Broker swap rates for SYMBOL from the symbol_hours cache (carry-cost
 * awareness). Returns { swapLong, swapShort, rollover3Days, updatedAt } or
 * null when the symbol was never refreshed / carries no swap data —
 * callers must treat null as "unknown", never as zero.
 */
export function getSwapInfo(db, symbol) {
  let row = null
  try {
    row = db.prepare(
      `SELECT swap_long, swap_short, swap_rollover_3days, updated_at FROM symbol_hours WHERE symbol = ?`
    ).get(String(symbol || '').toUpperCase())
  } catch { row = null }
  if (!row || (row.swap_long == null && row.swap_short == null)) return null
  return {
    swapLong: row.swap_long, swapShort: row.swap_short,
    rollover3Days: row.swap_rollover_3days, updatedAt: row.updated_at,
  }
}

/**
 * Is SYMBOL open now? Broker-truth from the table when cached; otherwise the
 * sessions.js heuristic. Returns { open, reason, source }.
 */
export function isSymbolOpenCached(db, symbol, now = new Date()) {
  const s = String(symbol || '').toUpperCase()
  let row = null
  try { row = db.prepare(`SELECT schedule_json, tz FROM symbol_hours WHERE symbol = ?`).get(s) } catch { row = null }
  if (!row || !row.schedule_json) {
    return { ...isSymbolMarketOpen(symbol, now), source: 'heuristic' }
  }
  let schedule = []
  try { schedule = JSON.parse(row.schedule_json) } catch { schedule = [] }
  const sow = secondsIntoWeek(now, row.tz || 'UTC')
  const open = isOpenBySchedule(schedule, sow)
  return open
    ? { open: true, source: 'broker' }
    : { open: false, reason: `${symbol}: closed per broker trading schedule (${row.tz || 'UTC'})`, source: 'broker' }
}

const WEEK_SECONDS_TOTAL = 7 * 24 * 3600

/**
 * Open/closed + WHEN the market next opens (for the UI's closed-symbol
 * marker). next_open_at is derived from the broker schedule: the nearest
 * upcoming interval start in seconds-into-week, projected onto real time.
 * Heuristic-only symbols (not yet refreshed) report next_open_at: null —
 * we don't fake a timestamp we don't have.
 */
/**
 * When does the symbol's CURRENT session end, and how long is the closure
 * that follows? Powers the weekend-bank sweep: closure_sec ≥ ~12h means a
 * weekend/holiday gap, not the ordinary overnight break. Heuristic-only
 * symbols return nulls — we never act on a schedule we don't have.
 */
export function nextCloseInfo(db, symbol, now = new Date()) {
  const s = String(symbol || '').toUpperCase()
  let row = null
  try { row = db.prepare(`SELECT schedule_json, tz FROM symbol_hours WHERE symbol = ?`).get(s) } catch { row = null }
  if (!row || !row.schedule_json) return { open: null, closes_in_sec: null, closure_sec: null, source: 'heuristic' }
  let schedule = []
  try { schedule = JSON.parse(row.schedule_json) } catch { schedule = [] }
  const norm = schedule
    .map(iv => ({ a: Number(iv.startSecond ?? iv.start), b: Number(iv.endSecond ?? iv.end) }))
    .filter(iv => Number.isFinite(iv.a) && Number.isFinite(iv.b))
  if (norm.length === 0) return { open: true, closes_in_sec: null, closure_sec: null, source: 'broker' } // 24/7 CFD
  const W = WEEK_SECONDS_TOTAL
  const sow = secondsIntoWeek(now, row.tz || 'UTC')
  let end = null
  for (const { a, b } of norm) {
    if (a <= b ? (sow >= a && sow < b) : (sow >= a || sow < b)) { end = b; break }
  }
  if (end == null) return { open: false, closes_in_sec: null, closure_sec: null, source: 'broker' }
  const closesIn = ((end - sow) % W + W) % W
  // Gap until the next interval START at/after this end; contiguous
  // intervals give closure 0 (the market doesn't actually close).
  let gap = null
  for (const { a } of norm) {
    const d = ((a - end) % W + W) % W
    if (gap == null || d < gap) gap = d
  }
  return { open: true, closes_in_sec: closesIn, closure_sec: gap, source: 'broker' }
}

export function nextOpenInfo(db, symbol, now = new Date()) {
  const base = isSymbolOpenCached(db, symbol, now)
  if (base.open || base.source !== 'broker') {
    return { open: base.open, next_open_at: null, source: base.source }
  }
  const s = String(symbol || '').toUpperCase()
  let row = null
  try { row = db.prepare(`SELECT schedule_json, tz FROM symbol_hours WHERE symbol = ?`).get(s) } catch { row = null }
  let schedule = []
  try { schedule = JSON.parse(row?.schedule_json || '[]') } catch { schedule = [] }
  const sow = secondsIntoWeek(now, row?.tz || 'UTC')
  let best = null
  for (const iv of schedule) {
    const a = Number(iv.startSecond ?? iv.start)
    if (!Number.isFinite(a)) continue
    const delta = ((a - sow) % WEEK_SECONDS_TOTAL + WEEK_SECONDS_TOTAL) % WEEK_SECONDS_TOTAL
    if (delta > 0 && (best == null || delta < best)) best = delta
  }
  return {
    open: false,
    next_open_at: best != null ? new Date(now.getTime() + best * 1000).toISOString() : null,
    source: 'broker',
  }
}
