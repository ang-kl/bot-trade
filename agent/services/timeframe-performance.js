// ---------------------------------------------------------------------------
// agent/services/timeframe-performance.js — per-timeframe trade outcomes
// over rolling windows, for the Tune → Pipeline table.
//
// One row per timeframe (the armed autotrade list first, then any other
// timeframe that closed trades inside the widest window), one cell per
// window. A cell's outcome is decided by net PnL of trades CLOSED inside
// that window: win (>0) / loss (<0) / flat (=0 with trades) / no_trade.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const WINDOWS = [
  { key: '2h', mod: '-2 hours' },
  { key: '4h', mod: '-4 hours' },
  { key: '1d', mod: '-1 day' },
  { key: '5d', mod: '-5 days' },
  { key: '1w', mod: '-7 days' },
]

export function timeframePerformance(db) {
  let armed = ['4h', '1d']
  try {
    const parsed = JSON.parse(getState(db, 'autotrade_timeframes') || 'null')
    if (Array.isArray(parsed) && parsed.length > 0) armed = parsed
  } catch { /* keep default */ }

  // closed_at is written both as "YYYY-MM-DD HH:MM:SS" (SQL datetime('now'))
  // and as ISO-with-T in older rows — datetime() normalises either form so
  // the window comparison is format-proof.
  const stmt = db.prepare(
    `SELECT COALESCE(label_timeframe, '?') AS tf,
            COUNT(*) AS trades,
            SUM(CASE WHEN COALESCE(net_pnl, 0) > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN COALESCE(net_pnl, 0) < 0 THEN 1 ELSE 0 END) AS losses,
            ROUND(SUM(COALESCE(net_pnl, 0)), 2) AS pnl
     FROM trades
     WHERE status = 'closed' AND datetime(closed_at) >= datetime('now', ?)
     GROUP BY tf`
  )

  const byWindow = {}
  for (const w of WINDOWS) {
    let rows = []
    try { rows = stmt.all(w.mod) } catch { /* fresh DB, no trades table yet */ }
    byWindow[w.key] = new Map(rows.map(r => [r.tf, r]))
  }

  // Timeframes with recent trades that are no longer on the armed list still
  // get a row — history should not vanish when a chip is removed.
  const seen = new Set()
  for (const m of Object.values(byWindow)) for (const tf of m.keys()) seen.add(tf)
  const extras = [...seen].filter(tf => !armed.includes(tf))

  const rows = [
    ...armed.map(tf => ({ tf, isArmed: true })),
    ...extras.map(tf => ({ tf, isArmed: false })),
  ].map(({ tf, isArmed }) => {
    const cells = {}
    for (const w of WINDOWS) {
      const r = byWindow[w.key].get(tf)
      if (!r || !r.trades) {
        cells[w.key] = { outcome: 'no_trade', trades: 0, wins: 0, losses: 0, pnl: 0 }
      } else {
        cells[w.key] = {
          outcome: r.pnl > 0 ? 'win' : r.pnl < 0 ? 'loss' : 'flat',
          trades: r.trades,
          wins: r.wins,
          losses: r.losses,
          pnl: r.pnl,
        }
      }
    }
    return { timeframe: tf, armed: isArmed, cells }
  })

  return { windows: WINDOWS.map(w => w.key), rows }
}
