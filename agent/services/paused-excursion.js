// ---------------------------------------------------------------------------
// agent/services/paused-excursion.js — MAE/MFE for the positions the general
// monitor does not evaluate: PAUSED rows (the momentum book's own positions,
// and any row the owner paused by hand).
//
// Claude · № 13,281 11-Oct (owner "record from now on and fill in the history
// from bars", ordered № 13,277·D·2; claude-builder)
//
// WHY. `mfe_r` / `mae_r` are written by the monitor's evaluatePosition, and
// the monitor skips paused rows (loop.js selectActivePositions). The momentum
// book pauses the monitor on every row it adopts, so a book position kept the
// 0/0 it was born with: on 11-10 SHOP.US read 0/0 while it stood at +7.2R
// with its stop locking +3.4R, and XOM.US's figures froze the day it was
// paused (28-09).
//
// WHAT. Numbers only. Nothing here sends, amends or decides; no stop, exit or
// order reads from this module.
//   1. HISTORY, once per row: the broker's own bars since the row was
//      recorded — 1m bars for the rest of the entry hour, 1h bars after —
//      highs and lows in R. Stamped in `excursion_backfill_json` with what
//      it covered. It runs once; a planned segment the broker answers with
//      no bar leaves the stamp 'partial' and the row retried hourly, up to
//      MAX_BACKFILL_ATTEMPTS answers.
//   2. FROM NOW ON, every monitor pass: the same account-owned, broker-
//      timestamped quote the monitor prices every other row with.
// Both writes only ever WIDEN the record (MAX for MFE, MIN for MAE), and only
// on a row that is still active and still paused.
//
// LIMITS, stated rather than hidden:
//   - Bars are the broker's BID trendbars. A short is closed at the ask, so a
//     short's bar excursion is off by the spread (MFE slightly high, MAE
//     slightly shallow).
//   - A bar counts only if it STARTS at or after the row was recorded, so no
//     pre-entry price can enter. The first partial minute is missed, and a
//     row recorded after its fill (an adopted position) misses that gap.
//   - The 1h window is capped at 3,000 bars (~125 days); an older row is
//     stamped `coverage: 'partial'` from its first bar.
//   - Quotes sampled once a pass miss intrabar extremes — as for every other
//     row the monitor records.
// If the owner UNPAUSES a row, the general monitor carries on from this
// record. Its managed trail is measured from the peak (position-manager.js,
// `managedPeakR = max(stored MFE, r)`), so it then starts from the real peak
// instead of from zero.
// ---------------------------------------------------------------------------

import { heldPositionPrice, heldPositionExitPrice, ownedSymbolTarget, positionRecordedUpperBound, refreshHeldPositionPrices } from './held-prices.js'
import { recordExitExcursion } from './exit-excursion.js'

const MINUTE = 60_000
const HOUR = 3_600_000
/** The batch fetch caps a native period at 3,000 bars (ctrader-ws.js). */
export const MAX_HOUR_BARS = 3000
/** A failed or incomplete history fetch is retried at most this often per row. */
export const BACKFILL_RETRY_MS = HOUR
/** Answers with a planned segment missing, before the partial stamp stands. */
export const MAX_BACKFILL_ATTEMPTS = 3
/** History fetches started per monitor pass; the rest wait for the next. */
export const BACKFILL_PER_PASS = 2

// One history run at a time across loop passes, and when each row last tried.
let backfillInFlight = null
const lastAttemptMs = new Map()

/** 'long' | 'short' | null — an unknown side is not measured, never guessed. */
export function sideOf(pos) {
  const s = String(pos?.side ?? '').trim()
  if (/^(buy|long)$/i.test(s)) return 'long'
  if (/^(sell|short)$/i.test(s)) return 'short'
  return null
}

function geometry(pos) {
  const side = sideOf(pos)
  const entry = Number(pos?.entry_price)
  const risk = Number(pos?.initial_risk)
  if (!side || !(Number.isFinite(entry) && entry > 0) || !(Number.isFinite(risk) && risk > 0)) return null
  return { side, entry, risk }
}

/** R at one price, or null when the row cannot be measured in R. */
export function rAtPrice(pos, price) {
  const g = geometry(pos)
  const p = Number(price)
  if (!g || price == null || !(Number.isFinite(p) && p > 0)) return null
  return ((p - g.entry) * (g.side === 'long' ? 1 : -1)) / g.risk
}

/**
 * Excursion over bars that START at or after `fromMs`. Pure.
 * @returns {{mfeR:number, maeR:number, bars:number, invalidBars:number,
 *            firstBarMs:number, lastBarMs:number}|null} null = nothing usable
 */
export function excursionFromBars(pos, bars, fromMs) {
  const g = geometry(pos)
  if (!g || !Number.isFinite(fromMs)) return null
  let mfeR = 0, maeR = 0, used = 0, invalidBars = 0, firstBarMs = null, lastBarMs = null
  for (const b of bars || []) {
    const t = Number(b?.t)
    if (!Number.isFinite(t) || t < fromMs) continue
    const h = Number(b?.h), l = Number(b?.l)
    if (!(Number.isFinite(h) && Number.isFinite(l) && l > 0 && h >= l)) { invalidBars++; continue }
    const fav = g.side === 'long' ? (h - g.entry) / g.risk : (g.entry - l) / g.risk
    const adv = g.side === 'long' ? (l - g.entry) / g.risk : (g.entry - h) / g.risk
    mfeR = Math.max(mfeR, fav)
    maeR = Math.min(maeR, adv)
    used++
    if (firstBarMs == null || t < firstBarMs) firstBarMs = t
    if (lastBarMs == null || t > lastBarMs) lastBarMs = t
  }
  if (used === 0) return null
  return { mfeR, maeR, bars: used, invalidBars, firstBarMs, lastBarMs }
}

/**
 * Which bars cover [entryMs, nowMs]: 1m bars up to the first whole hour after
 * the entry, 1h bars from that hour on. Pure.
 */
export function backfillPlan(entryMs, nowMs) {
  if (!Number.isFinite(entryMs) || !Number.isFinite(nowMs) || entryMs >= nowMs) return null
  const firstFullHour = Math.ceil(entryMs / HOUR) * HOUR
  const minuteEnd = Math.min(firstFullHour, nowMs)
  const minutes = minuteEnd > entryMs
    ? { endMs: minuteEnd, count: Math.min(61, Math.ceil((minuteEnd - entryMs) / MINUTE) + 1), fromMs: entryMs, beforeMs: firstFullHour }
    : null
  const hoursWanted = nowMs > firstFullHour ? Math.ceil((nowMs - firstFullHour) / HOUR) + 1 : 0
  const hours = hoursWanted > 0
    ? { endMs: 0, count: Math.min(MAX_HOUR_BARS, hoursWanted), fromMs: firstFullHour, capped: hoursWanted > MAX_HOUR_BARS }
    : null
  return { entryMs, firstFullHour, minutes, hours }
}

/** No stamp yet, or a partial one still allowed another attempt. */
export function backfillDue(pos) {
  const raw = pos?.excursion_backfill_json
  if (raw == null) return true
  try { return JSON.parse(raw)?.final === false } catch { return false }
}

/** Paused rows still open — the rows the monitor's own pass skips. */
export function pausedRows(db) {
  return db.prepare(
    `SELECT * FROM monitored_positions WHERE status = 'active' AND COALESCE(paused, 0) = 1`
  ).all()
}

function widenStmt(db) {
  return db.prepare(`UPDATE monitored_positions
    SET mfe_r = MAX(COALESCE(mfe_r, 0), ?), mae_r = MIN(COALESCE(mae_r, 0), ?)
    WHERE id = ? AND status = 'active' AND COALESCE(paused, 0) = 1`)
}

/** The broker's bars for one owned target. Injectable for tests. */
export async function fetchOwnedBars(target, period, count, endMs) {
  const { wsGetTrendbarsBatch } = await import('../lib/ctrader-ws.js')
  const c = target.creds
  const byTf = await wsGetTrendbarsBatch(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId,
    target.symbolId, [period], count, 20_000, endMs || 0)
  return Array.isArray(byTf?.[period]) ? byTf[period] : []
}

/**
 * Fill one row's history from bars and stamp it. Returns what happened; never
 * throws for a broker failure (the row simply retries after BACKFILL_RETRY_MS).
 */
export async function backfillRow(db, pos, { fetchBars = fetchOwnedBars, now = Date.now } = {}) {
  const at = now()
  const entryMs = positionRecordedUpperBound(pos)
  const plan = backfillPlan(entryMs, at)
  if (!geometry(pos)) return { id: pos.id, status: 'not_measurable' }
  if (!plan) return { id: pos.id, status: 'no_window' }
  const target = ownedSymbolTarget(db, pos, at)
  if (!target) return { id: pos.id, status: 'no_owned_symbol' }
  let minuteBars = [], hourBars = []
  try {
    if (plan.minutes) minuteBars = (await fetchBars(target, '1m', plan.minutes.count, plan.minutes.endMs))
      .filter(b => Number(b?.t) < plan.minutes.beforeMs)
    if (plan.hours) hourBars = await fetchBars(target, '1h', plan.hours.count, plan.hours.endMs)
  } catch (err) {
    return { id: pos.id, status: 'fetch_failed', error: String(err?.message || err) }
  }
  const fromMinutes = plan.minutes ? excursionFromBars(pos, minuteBars, plan.minutes.fromMs) : null
  const fromHours = plan.hours ? excursionFromBars(pos, hourBars, plan.hours.fromMs) : null
  // A planned segment the broker answered with no usable bar may hold the
  // extreme (Codex P2 on #1321): it is named, the stamp says 'partial', and
  // the row stays due until the segment answers or MAX_BACKFILL_ATTEMPTS is
  // spent (a market shut for the rest of the entry hour never will).
  const missing = [plan.minutes && !fromMinutes ? '1m' : null, plan.hours && !fromHours ? '1h' : null].filter(Boolean)
  const previous = pos.excursion_backfill_json ?? null
  let prior = null
  try { prior = previous == null ? null : JSON.parse(previous) } catch { prior = null }
  const attempts = (Number.isSafeInteger(prior?.attempts) ? prior.attempts : 0) + 1
  const firsts = [fromMinutes?.firstBarMs, fromHours?.firstBarMs].filter(Number.isFinite)
  const mfeR = Math.max(fromMinutes?.mfeR ?? 0, fromHours?.mfeR ?? 0)
  const maeR = Math.min(fromMinutes?.maeR ?? 0, fromHours?.maeR ?? 0)
  const record = {
    at: new Date(at).toISOString(),
    source: 'broker_bid_bars',
    from: new Date(entryMs).toISOString(),
    firstBar: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
    minuteBars: fromMinutes?.bars ?? 0,
    hourBars: fromHours?.bars ?? 0,
    invalidBars: (fromMinutes?.invalidBars ?? 0) + (fromHours?.invalidBars ?? 0),
    missing,
    coverage: plan.hours?.capped || missing.length > 0 ? 'partial' : 'full',
    attempts,
    final: missing.length === 0 || attempts >= MAX_BACKFILL_ATTEMPTS,
    mfeR, maeR,
  }
  // Compare-and-set on the stamp this pass read: a concurrent writer, an
  // unpause or a close in between leaves the row untouched.
  const res = db.prepare(`UPDATE monitored_positions
    SET mfe_r = MAX(COALESCE(mfe_r, 0), ?), mae_r = MIN(COALESCE(mae_r, 0), ?), excursion_backfill_json = ?
    WHERE id = ? AND status = 'active' AND COALESCE(paused, 0) = 1 AND excursion_backfill_json IS ?`)
    .run(mfeR, maeR, JSON.stringify(record), pos.id, previous)
  if (res.changes !== 1) return { id: pos.id, status: 'row_changed', record }
  return { id: pos.id, status: record.final && missing.length === 0 ? 'filled' : (record.final ? 'partial_final' : 'partial_retry'), record }
}

/**
 * One monitor pass over the paused rows: record the live quote's R, and start
 * (not await) the history fill for rows that have none. The history runs
 * detached so a slow broker never holds the loop; `backfill` is returned so a
 * caller (a test) can await it.
 */
export async function recordPausedExcursions(db, {
  rows = null,
  refreshPrices = refreshHeldPositionPrices,
  priceOf = heldPositionPrice,
  // Claude · 13-Oct (Codex round 1 on #1356, "Fix in this PR"; round 2,
  // "Separate columns"; claude-builder): the exit side (bid for a long, ask
  // for a short) is recorded in mfe_exit_r/mae_exit_r beside mfe_r/mae_r,
  // which stay on the mid like the two monitors'.
  exitPriceOf = heldPositionExitPrice,
  fetchBars = fetchOwnedBars,
  now = Date.now,
  perPass = BACKFILL_PER_PASS,
  log = () => {},
} = {}) {
  const list = rows ?? pausedRows(db)
  const out = { rows: list.length, live: 0, backfillStarted: 0, backfill: null }
  if (list.length === 0) return out

  // 1. History — once per row, a bounded number per pass, never two runs at once.
  if (!backfillInFlight) {
    const at = now()
    const due = list.filter(p => backfillDue(p)
      && !(at - (lastAttemptMs.get(p.id) ?? -Infinity) < BACKFILL_RETRY_MS)).slice(0, Math.max(0, perPass))
    if (due.length > 0) {
      for (const p of due) lastAttemptMs.set(p.id, at)
      out.backfillStarted = due.length
      backfillInFlight = (async () => {
        const results = []
        for (const p of due) {
          try {
            const r = await backfillRow(db, p, { fetchBars, now })
            results.push(r)
            if (r.status === 'filled') log(`MAE/MFE history for ${p.symbol} [row${p.id}] from ${r.record.minuteBars}×1m + ${r.record.hourBars}×1h bars: MFE ${r.record.mfeR.toFixed(2)}R, MAE ${r.record.maeR.toFixed(2)}R`)
            else if (r.status !== 'row_changed') log(`MAE/MFE history for ${p.symbol} [row${p.id}] ${r.record ? `partial (no bars for ${r.record.missing.join(', ')}; attempt ${r.record.attempts}${r.record.final ? ', final' : ''})` : `not filled: ${r.status}`}${r.error ? ` (${r.error})` : ''}`)
          } catch (err) {
            results.push({ id: p.id, status: 'error', error: String(err?.message || err) })
          }
        }
        return results
      })().finally(() => { backfillInFlight = null })
      out.backfill = backfillInFlight
    }
  }

  // 2. From now on — the monitor's own quote rule, widened in place.
  let receipts = new Map()
  try { receipts = await refreshPrices(db, list, { now }) } catch (err) { log(`Paused-row quotes failed (non-fatal): ${err.message}`) }
  const widen = widenStmt(db)
  for (const p of list) {
    recordExitExcursion(db, p, exitPriceOf(p, receipts, { now }), { now: now() })
    const r = rAtPrice(p, priceOf(p, receipts, { now }))
    if (r == null || !Number.isFinite(r)) continue
    if (widen.run(Math.max(0, r), Math.min(0, r), p.id).changes === 1) out.live++
  }
  return out
}

/** Test seam: forget the per-row retry clock and any in-flight run. */
export function resetPausedExcursionState() {
  backfillInFlight = null
  lastAttemptMs.clear()
}
