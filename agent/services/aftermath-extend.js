// ─────────────────────────────────────────────────────────────────────────────
// Aftermath extension — preview (and, when the owner says so, apply).
//
// The exit-counterfactual replays STORED bars (trade_postmortems.bars_json).
// Rows captured under the old 12-bar replay window truncate before the slower
// rules resolve, so the counterfactual could not compare them (measured
// 25-08-2026: 210-245 of 251 replays truncated per rule; only 2 of 8 rules
// reached the 30-trade floor). Extending the window for FUTURE captures is
// loss-postmortem.js's REPLAY_AFTERMATH_BARS; this module is about the rows
// that already exist: which of them COULD be topped up from broker history,
// at what cost, without touching a single one until the owner approves.
//
// The preview is a pure read. It fetches nothing from the broker and writes
// nothing — it answers, from the stored rows alone: how many rows are short
// of the new window, how many of those have complete history to fetch (the
// market has already traded past close + 96 bars), and how many broker candle
// fetches an apply would cost. Owner, 25-08-2026: "go, dry-run only".
// ─────────────────────────────────────────────────────────────────────────────

import { tfMs } from '../lib/timeframes.js'
import { AFTERMATH_BARS, REPLAY_AFTERMATH_BARS, sqliteMs } from './loss-postmortem.js'

/**
 * Survey every stored postmortem against the new replay window. Pure read.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{now?: number}} [opts]
 * @returns {{
 *   replayBars: number, classifyBars: number, totalPostmortems: number,
 *   extendable: number, alreadyFull: number, historyStillForming: number,
 *   noBars: number, badRow: number, brokerFetchesNeeded: number,
 *   byTimeframe: Record<string, number>,
 *   sample: Array<{tradeId: number, symbol: string, timeframe: string, afterBars: number}>
 * }}
 */
export function previewAftermathExtension(db, { now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT pm.trade_id AS tradeId, pm.symbol, pm.timeframe, pm.bars_json,
           t.closed_at
      FROM trade_postmortems pm
      JOIN trades t ON t.id = pm.trade_id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL
  `).all()

  const out = {
    replayBars: REPLAY_AFTERMATH_BARS,
    classifyBars: AFTERMATH_BARS,
    totalPostmortems: rows.length,
    extendable: 0,
    alreadyFull: 0,
    historyStillForming: 0,
    noBars: 0,
    badRow: 0,
    brokerFetchesNeeded: 0,
    byTimeframe: {},
    sample: [],
  }

  for (const r of rows) {
    const ms = tfMs(r.timeframe) || 3_600_000
    const closedMs = sqliteMs(r.closed_at)
    if (!Number.isFinite(closedMs)) { out.badRow++; continue }

    let bars
    try { bars = JSON.parse(r.bars_json || 'null') } catch { bars = null }
    if (!Array.isArray(bars) || bars.length === 0) { out.noBars++; continue }

    // Bars are [[t,o,h,l,c,v], ...]; count the ones after the close.
    const afterBars = bars.reduce((n, b) => n + (Array.isArray(b) && Number(b[0]) > closedMs ? 1 : 0), 0)
    if (afterBars >= REPLAY_AFTERMATH_BARS) { out.alreadyFull++; continue }

    // Only rows whose full 96-bar aftermath has already TRADED can be topped
    // up now; a fresh close's history is still forming and an early fetch
    // would bake in a short window a second time.
    if (now < closedMs + (REPLAY_AFTERMATH_BARS + 2) * ms) { out.historyStillForming++; continue }

    out.extendable++
    out.brokerFetchesNeeded++ // one candle fetch per row on apply
    const tf = r.timeframe || '?'
    out.byTimeframe[tf] = (out.byTimeframe[tf] || 0) + 1
    if (out.sample.length < 10) {
      out.sample.push({ tradeId: r.tradeId, symbol: r.symbol, timeframe: tf, afterBars })
    }
  }
  return out
}
