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
  const upsert = db.prepare(`
    INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz, source, updated_at)
    VALUES (?, ?, ?, ?, 'ctrader', datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      symbol_id = excluded.symbol_id, schedule_json = excluded.schedule_json,
      tz = excluded.tz, source = 'ctrader', updated_at = datetime('now')
  `)

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
        upsert.run(String(name).toUpperCase(), Number(sym.symbolId) || null, JSON.stringify(schedule), tz)
        out.updated++
      }
    } catch (err) {
      out.errors.push(`batch ${i / BATCH}: ${err.message}`)
    }
  }
  return out
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
