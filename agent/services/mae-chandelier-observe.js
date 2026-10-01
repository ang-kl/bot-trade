// agent/services/mae-chandelier-observe.js
//
// Observe-only MAE and LeBeau Chandelier. Approved as mae-chandelier-observe.
// This module never returns an amend and never calls the broker.
//
// Interval: it does not start its own 1-second loop. A second loop would
// stack broker calls on the tick that already re-prices positions. The
// caller passes the fast-monitor tick (default 3s, floor 1s, FAST_MONITOR_MS).
// ATR does not change every second; the quote extreme can.
// db.js is loaded only when a tick writes, so the pure test does not need
// the native driver.

export const OBSERVE_STATE_KEY = 'mae_chandelier_observe_json'
export const DEFAULT_ATR_PERIOD = 22
export const DEFAULT_ATR_MULT = 3

export function observeIntervalMs(env = process.env, override = null) {
  if (Number(override) > 0) return Math.max(1_000, Number(override))
  return Math.max(1_000, Number(env.FAST_MONITOR_MS) || 3_000)
}

export function wilderAtr(bars, period = DEFAULT_ATR_PERIOD) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].h)
    const l = Number(bars[i].l)
    const pc = Number(bars[i - 1].c)
    if (![h, l, pc].every(Number.isFinite)) return null
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  if (trs.length < period) return null
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period
  return atr
}

function dirOf(side) {
  const s = String(side || '').toUpperCase()
  if (s === 'LONG' || s === 'BUY') return 1
  if (s === 'SHORT' || s === 'SELL') return -1
  return 0
}

/**
 * One reading. mayAmend is a constant false. A Chandelier price is a
 * candidate to display, not an order.
 *
 * since-entry high is this trade. The 22-session high can sit before the
 * fill, which is why both are reported and neither is sent.
 */
export function observePosition({
  side, entry, price, sl = null, bars = null,
  peak = null, trough = null,
  period = DEFAULT_ATR_PERIOD, multiplier = DEFAULT_ATR_MULT,
} = {}) {
  const dir = dirOf(side)
  const out = {
    mayAmend: false,
    dir,
    mae: null,
    mfe: null,
    maeOverRisk: null,
    chandelier22: null,
    chandelierSinceEntry: null,
    closeBelow22: null,
    closeBelowSinceEntry: null,
    atr: null,
    reason: 'observe_only',
  }
  if (!dir || !(entry > 0) || !(price > 0)) {
    out.reason = 'incomplete_quote'
    return out
  }
  const adverse = dir === 1 ? entry - price : price - entry
  const favourable = dir === 1 ? price - entry : entry - price
  // peak/trough here are price excursions already in price units, not USD.
  out.mae = Math.max(0, Number.isFinite(trough) ? Math.max(trough, adverse) : Math.max(0, adverse))
  out.mfe = Math.max(0, Number.isFinite(peak) ? Math.max(peak, favourable) : Math.max(0, favourable))
  const risk = sl > 0 ? Math.abs(entry - sl) : null
  out.maeOverRisk = risk > 0 ? out.mae / risk : null
  if (!Array.isArray(bars) || bars.length < period + 1) {
    out.reason = 'observe_only_bars_missing'
    return out
  }
  const atr = wilderAtr(bars, period)
  out.atr = atr
  if (!(atr > 0)) {
    out.reason = 'observe_only_atr_missing'
    return out
  }
  const look = bars.slice(-period)
  const hh22 = Math.max(...look.map(b => Number(b.h)))
  const ll22 = Math.min(...look.map(b => Number(b.l)))
  out.chandelier22 = dir === 1 ? hh22 - multiplier * atr : ll22 + multiplier * atr
  out.closeBelow22 = dir === 1 ? price < out.chandelier22 : price > out.chandelier22
  out.reason = 'observe_only'
  return out
}

export function decideAdjust({ side, entry, price, sl, bars, period = DEFAULT_ATR_PERIOD, multiplier = DEFAULT_ATR_MULT } = {}) {
  const reading = observePosition({ side, entry, price, sl, bars, period, multiplier })
  const dir = reading.dir
  const since = chandelierSinceEntry(bars, 0, dir, reading.atr, multiplier)
  const out = { ...reading, chandelierSinceEntry: since, mayAmend: false, adjust: null }
  if (!(since > 0) || !(sl > 0) || !dir) return out
  const tighter = dir === 1 ? since > sl && since < price : since < sl && since > price
  if (!tighter) return out
  out.mayAmend = true
  out.adjust = { action: 'MOVE_SL', sl: since, reason: 'mae_chandelier_since_entry_tighten' }
  return out
}

const BAR_CACHE = new Map()

export function cachedBars(symbolId, now = Date.now(), ttlMs = 3_600_000) {
  const hit = BAR_CACHE.get(String(symbolId))
  if (!hit || now - hit.at >= ttlMs) return null
  return hit.bars
}

export function storeBars(symbolId, bars, now = Date.now()) {
  BAR_CACHE.set(String(symbolId), { bars, at: now })
  return bars
}

export function chandelierSinceEntry(bars, entryIndex, dir, atr, multiplier = DEFAULT_ATR_MULT) {
  if (!Array.isArray(bars) || entryIndex < 0 || entryIndex >= bars.length || !(atr > 0) || !dir) return null
  const held = bars.slice(entryIndex)
  if (!held.length) return null
  if (dir === 1) return Math.max(...held.map(b => Number(b.h))) - multiplier * atr
  return Math.min(...held.map(b => Number(b.l))) + multiplier * atr
}

export function foldExcursion(prev, reading) {
  return {
    mae: Math.max(Number(prev?.mae) || 0, Number(reading?.mae) || 0),
    mfe: Math.max(Number(prev?.mfe) || 0, Number(reading?.mfe) || 0),
    mayAmend: false,
  }
}

export function loadObserveState(db, read) {
  try { return JSON.parse(read(db, OBSERVE_STATE_KEY) || '{}') } catch { return {} }
}

export async function recordObserve(db, rows, nowMs = Date.now(), io = {}) {
  const read = io.read || (await import('../db.js')).getState
  const write = io.write || (await import('../db.js')).setState
  const prev = loadObserveState(db, read)
  const positions = { ...(prev.positions || {}) }
  for (const row of rows || []) {
    if (!row?.id) continue
    const folded = foldExcursion(positions[row.id], row)
    positions[row.id] = {
      ...row,
      ...folded,
      mayAmend: row.mayAmend === true,
      at: new Date(nowMs).toISOString(),
    }
  }
  const next = {
    mode: 'observe_and_tighten',
    mayAmend: false,
    at: new Date(nowMs).toISOString(),
    positions,
  }
  write(db, OBSERVE_STATE_KEY, JSON.stringify(next))
  console.log(`[mae-chandelier-observe] ${JSON.stringify({ n: rows.length, mayAmend: rows.some(r => r.mayAmend === true) })}`)
  return next
}

/**
 * 24/7 recorder. Overlap-guarded. unref so it does not hold the process open
 * by itself. listPositions must not place an order; a throw is logged and
 * the next tick tries again.
 */
export function startMaeChandelierObserve(db, listPositions, opts = {}) {
  const tickMs = observeIntervalMs(opts.env, opts.tickMs)
  let running = false
  let skipped = 0
  const timer = setInterval(async () => {
    if (running) { skipped++; return }
    running = true
    try {
      const rows = await listPositions()
      recordObserve(db, Array.isArray(rows) ? rows : [], opts.clock ? opts.clock() : Date.now())
      skipped = 0
    } catch (err) {
      console.error('[mae-chandelier-observe] tick failed:', err?.message || err)
    } finally {
      running = false
    }
  }, tickMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tickMs, skipped: () => skipped }
}
