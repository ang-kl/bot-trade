// ---------------------------------------------------------------------------
// agent/services/loss-postmortem.js — learn from every losing trade.
//
// Owner: "is there a code section to playback after each loss to understand
// what the market is happening?" — there wasn't. This is it.
//
// After a losing trade closes, this sweep fetches the bars around the trade
// (entry → stop → aftermath) and classifies WHAT THE MARKET DID next:
//
//   stop_hunt    — price hit the stop, then came BACK to entry within the
//                  aftermath window. The idea was right, the stop was too
//                  tight (or the entry too early).
//   thesis_wrong — price kept going AGAINST the position ≥1R beyond the stop.
//                  The stop saved money; the idea was wrong.
//   chop         — price did neither: meandered. No edge either way — the
//                  entry filter let noise through.
//   time_cap     — closed by the time cap, not the market.
//   inconclusive — not enough aftermath bars to judge honestly.
//
// The classification walks bars CHRONOLOGICALLY — whichever extreme happens
// first wins, so a crash-then-recover reads thesis_wrong, not stop_hunt.
// Everything is stored (bars included) in trade_postmortems for the Desk's
// Loss-review playback, and aggregated per strategy so a pattern ("FIB losses
// are mostly stop hunts → widen stops") is visible, not vibes.
//
// Pure classification + a small sweep. The sweep is best-effort: a bar-fetch
// hiccup must never stall the loop.
// ---------------------------------------------------------------------------

import { tfMs } from '../lib/timeframes.js'

export const AFTERMATH_BARS = 12   // how many post-exit bars the verdict may use
export const MIN_AFTER_BARS = 5    // fewer than this → wait (or inconclusive)

/**
 * Classify a closed losing trade from its surrounding bars. Pure.
 *
 * @param {{ side:string, entry_price:number, sl_price:number|null,
 *           exit_price:number|null, close_reason:string|null }} trade
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} bars
 *        full window, chronological
 * @param {number} closedAtMs epoch ms of the close
 * @returns {{ classification:string, detail:string }|null} null = wait for more bars
 */
export function classifyLoss(trade, bars, closedAtMs, opts = {}) {
  const aftermathBars = opts.aftermathBars ?? AFTERMATH_BARS
  const minAfterBars = opts.minAfterBars ?? MIN_AFTER_BARS
  const allowPartial = opts.allowPartial ?? false

  if (/time_cap/i.test(trade.close_reason || '')) {
    return { classification: 'time_cap', detail: 'Closed by the time cap, not by the market — the setup never resolved in time.' }
  }

  const entry = Number(trade.entry_price)
  const exit = Number(trade.exit_price)
  const sl = trade.sl_price != null ? Number(trade.sl_price) : null
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
    return { classification: 'inconclusive', detail: 'Missing entry/exit price — cannot reconstruct the trade geometry.' }
  }
  const long = /^(buy|long)$/i.test(String(trade.side || ''))
  const risk = sl != null && Math.abs(entry - sl) > 0 ? Math.abs(entry - sl) : Math.abs(entry - exit)
  if (!(risk > 0)) {
    return { classification: 'inconclusive', detail: 'Zero risk distance — geometry unusable.' }
  }

  const after = (bars || []).filter(b => b.t > closedAtMs).slice(0, aftermathBars)
  if (after.length < minAfterBars && !allowPartial) return null // not enough aftermath yet — try next sweep

  // Adverse continuation level: 1R beyond the stop (or beyond exit when no SL).
  const stopLevel = sl != null ? sl : exit
  const contLevel = long ? stopLevel - risk : stopLevel + risk

  // Walk chronologically — first decisive event wins.
  for (const b of after) {
    const cameBack = long ? b.h >= entry : b.l <= entry
    const kept = long ? b.l <= contLevel : b.h >= contLevel
    if (kept && cameBack) {
      // Same bar did both — judge by which side the bar CLOSED on.
      const closedAdverse = long ? b.c < exit : b.c > exit
      return closedAdverse ? verdictWrong(risk) : verdictHunt(after.indexOf(b) + 1)
    }
    if (kept) return verdictWrong(risk)
    if (cameBack) return verdictHunt(after.indexOf(b) + 1)
  }
  if (after.length < minAfterBars) {
    return { classification: 'inconclusive', detail: `Only ${after.length} aftermath bar(s) available — not enough to judge honestly.` }
  }
  return {
    classification: 'chop',
    detail: `In ${after.length} bars after the stop, price neither returned to entry nor continued 1R beyond the stop — the market was noise here, and the entry filter let it through.`,
  }
}

function verdictHunt(nBars) {
  return {
    classification: 'stop_hunt',
    detail: `Price swept the stop, then came back to the entry within ${nBars} bar(s). The direction was right — the stop was too tight or the entry too early.`,
  }
}
function verdictWrong(risk) {
  return {
    classification: 'thesis_wrong',
    detail: `Price continued ≥1R (${risk.toFixed(5)}) beyond the stop. The stop did its job — the idea was wrong, not the exit.`,
  }
}

/** Parse "YYYY-MM-DD HH:MM:SS" (sqlite, UTC) or ISO into epoch ms. */
export function sqliteMs(s) {
  if (!s) return NaN
  return Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z')
}

/**
 * Sweep: classify recent closed LOSING trades that have no postmortem yet.
 * Fetches bars via the injected fetcher (testable), stores the verdict +
 * replay bars. Limits work per cycle so the loop never stalls on this.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {(symbol:string, timeframe:string, count:number) => Promise<Array>} fetchBars
 * @returns {{ examined:number, classified:number, waiting:number }}
 */
export async function runLossPostmortems(db, fetchBars, { maxPerCycle = 3, now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.exit_price, t.sl_price,
           t.net_pnl, t.close_reason, t.opened_at, t.closed_at,
           COALESCE(t.label_strategy, t.strategy) AS strategy,
           t.label_timeframe AS timeframe
    FROM trades t
    LEFT JOIN trade_postmortems pm ON pm.trade_id = t.id
    WHERE t.status = 'closed' AND t.net_pnl < 0 AND pm.id IS NULL
      AND t.closed_at >= datetime('now', '-7 days')
    ORDER BY t.closed_at DESC
    LIMIT ?
  `).all(maxPerCycle)

  let classified = 0, waiting = 0
  for (const t of rows) {
    const closedMs = sqliteMs(t.closed_at)
    if (!Number.isFinite(closedMs)) continue
    const tf = t.timeframe || '1h'
    const ms = tfMs(tf) || 3_600_000
    const openedMs = sqliteMs(t.opened_at)
    // Window: from a bit before entry to now, capped at 400 bars.
    const count = Math.min(400, Math.max(60, Math.ceil((now - (openedMs || closedMs)) / ms) + AFTERMATH_BARS + 10))
    let bars = []
    try {
      bars = await fetchBars(t.symbol, tf, count) || []
    } catch { /* fetch hiccup — leave for next sweep */ continue }

    // A stale loss (>24h) is classified with whatever aftermath exists rather
    // than retrying forever; a fresh one waits for enough bars.
    const stale = now - closedMs > 24 * 3_600_000
    const verdict = classifyLoss(t, bars, closedMs, { allowPartial: stale })
    if (verdict === null) { waiting++; continue }

    const rMult = t.sl_price != null && Math.abs(t.entry_price - t.sl_price) > 0 && t.exit_price != null
      ? -(Math.abs(t.entry_price - t.exit_price) / Math.abs(t.entry_price - t.sl_price))
      : null
    // Replay window: 20 bars before entry → aftermath end (compact for the UI).
    const fromMs = (openedMs || closedMs) - 20 * ms
    const toMs = closedMs + (AFTERMATH_BARS + 2) * ms
    const replay = bars.filter(b => b.t >= fromMs && b.t <= toMs)
    db.prepare(`
      INSERT INTO trade_postmortems
        (trade_id, symbol, strategy, timeframe, side, entry_price, exit_price, sl_price,
         net_pnl, r_multiple, classification, detail, bars_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      t.id, t.symbol, t.strategy || null, tf, t.side, t.entry_price, t.exit_price, t.sl_price,
      t.net_pnl, rMult, verdict.classification, verdict.detail,
      JSON.stringify(replay.map(b => [b.t, b.o, b.h, b.l, b.c, b.v ?? null])),
    )
    classified++
  }
  return { examined: rows.length, classified, waiting }
}

/** Per-strategy aggregation of loss classes — the "learning" readout. */
export function postmortemStats(db, windowDays = 30) {
  return db.prepare(`
    SELECT COALESCE(strategy, 'unlabelled') AS strategy, classification, COUNT(*) AS n
    FROM trade_postmortems
    WHERE created_at >= datetime('now', ?)
    GROUP BY COALESCE(strategy, 'unlabelled'), classification
    ORDER BY strategy, n DESC
  `).all(`-${windowDays} days`)
}
