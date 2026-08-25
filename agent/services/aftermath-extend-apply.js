// ─────────────────────────────────────────────────────────────────────────────
// Aftermath extension — the APPLY half. The preview (aftermath-extend.js)
// counted; this fetches and writes. Owner approved 25-08-2026 ("go for
// both"), after seeing the dry-run counts (897 extendable of 996), with the
// recommended 7-day wall-clock cap on slow timeframes: 96 bars of 8h chart is
// 32 days of candles for a replay whose slowest rule caps at 120 MINUTES —
// weeks of fetching for no additional verdict.
//
// What this must never do: touch anything except bars_json. The
// classification, r_multiple, lesson — all of it was judged under the 12-bar
// verdict window and stays as judged (see REPLAY_AFTERMATH_BARS's comment).
// A row's top-up appends aftermath bars, dedupes on timestamp, keeps
// chronological order, and stops at the row's own target.
//
// Batched and resumable BY CONSTRUCTION: the candidate predicate is "short of
// target with history fully traded", so a re-run after any interruption picks
// up exactly the rows still short — nothing tracks progress, the data is the
// progress.
// ─────────────────────────────────────────────────────────────────────────────

import { tfMs } from '../lib/timeframes.js'
import { REPLAY_AFTERMATH_BARS, sqliteMs } from './loss-postmortem.js'

/** Wall-clock ceiling for slow timeframes (owner-approved variant). */
export const SLOW_TF_CAP_MS = 7 * 24 * 3_600_000
const SLOW_TF_MS = 4 * 3_600_000 // 4h and above count as slow

/** Bars of aftermath a row of this bar-size should end up holding. */
export function targetAfterBars(barMs) {
  if (!(barMs >= SLOW_TF_MS)) return REPLAY_AFTERMATH_BARS
  return Math.min(REPLAY_AFTERMATH_BARS, Math.max(1, Math.floor(SLOW_TF_CAP_MS / barMs)))
}

/**
 * Top up stored replay windows from broker history. Writes bars_json ONLY.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {(symbol:string, timeframe:string, count:number, endTimeMs:number) => Promise<Array<{t:number,o:number,h:number,l:number,c:number,v?:number}>>} fetchBars
 * @param {{now?: number, maxRows?: number, throttleMs?: number, sleep?: (ms:number)=>Promise<void>}} [opts]
 */
export async function applyAftermathExtension(db, fetchBars, {
  now = Date.now(),
  maxRows = 100,
  maxErrors = 25,
  throttleMs = 150,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  // NEWEST FIRST, and an error budget — both learned from the first live
  // sweep (25-08-2026). Oldest-first put the permanently-unfetchable rows
  // (candles beyond broker retention, dead symbol names) at the FRONT of
  // every call: each pass re-attempted the same ~300 doomed fetches before
  // reaching a viable row, until the whole request outlived Railway's edge
  // timeout and returned nothing at all. Newest-first does the viable work
  // immediately, and maxErrors stops a call from burning its wall-clock on
  // rows that will fail again next pass too — they stay discoverable by the
  // same predicate, they just cannot crowd out progress.
  const rows = db.prepare(`
    SELECT pm.id AS pmId, pm.trade_id AS tradeId, pm.symbol, pm.timeframe, pm.bars_json,
           t.closed_at
      FROM trade_postmortems pm
      JOIN trades t ON t.id = pm.trade_id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL
     ORDER BY t.closed_at DESC
  `).all()

  const out = { examined: rows.length, updated: 0, barsAdded: 0, alreadyFull: 0, historyStillForming: 0, noBars: 0, errors: 0, remaining: 0 }
  const upd = db.prepare('UPDATE trade_postmortems SET bars_json = ? WHERE id = ?')

  for (const r of rows) {
    const ms = tfMs(r.timeframe) || 3_600_000
    const closedMs = sqliteMs(r.closed_at)
    if (!Number.isFinite(closedMs)) { out.noBars++; continue }

    let bars
    try { bars = JSON.parse(r.bars_json || 'null') } catch { bars = null }
    if (!Array.isArray(bars) || bars.length === 0) { out.noBars++; continue }

    const target = targetAfterBars(ms)
    const afterBars = bars.reduce((n, b) => n + (Array.isArray(b) && Number(b[0]) > closedMs ? 1 : 0), 0)
    if (afterBars >= target) { out.alreadyFull++; continue }
    if (now < closedMs + (target + 2) * ms) { out.historyStillForming++; continue }

    if (out.updated >= maxRows || out.errors >= maxErrors) { out.remaining++; continue }

    const endMs = closedMs + (target + 2) * ms
    const lastT = bars.reduce((m, b) => Math.max(m, Number(b?.[0]) || 0), 0)
    const count = Math.min(400, Math.max(5, Math.ceil((endMs - lastT) / ms) + 5))
    let fresh = []
    try {
      fresh = await fetchBars(r.symbol, r.timeframe, count, endMs) || []
    } catch { out.errors++; continue }
    finally { if (throttleMs > 0) await sleep(throttleMs) }

    const have = new Set(bars.map(b => Number(b?.[0])))
    const add = fresh
      .filter(b => b && Number.isFinite(b.t) && b.t > lastT && b.t <= endMs && !have.has(b.t))
      .map(b => [b.t, b.o, b.h, b.l, b.c, b.v ?? null])
    if (!add.length) { out.errors++; continue } // fetched nothing usable — leave the row for a re-run

    const merged = [...bars, ...add].sort((a, b) => a[0] - b[0])
    upd.run(JSON.stringify(merged), r.pmId)
    out.updated++
    out.barsAdded += add.length
  }
  return out
}
