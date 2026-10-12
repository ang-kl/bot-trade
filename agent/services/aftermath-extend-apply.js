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

/**
 * Claude · № 13,571 12-Oct (W5; claude-builder). One fetch asks for at most
 * this many bar slots of clock time after the row's last stored bar, and for
 * `slots + 5` bars. The broker returns the `count` bars ending at the
 * window's end, so a count above the slots can never be cut short at the
 * front: every bar the broker has in the window comes back, and the bars
 * appended are contiguous with what the row holds. 395 + 5 keeps each
 * request at the broker's 400.
 */
export const WINDOW_SLOTS = 395
/**
 * Windows one row may step through in one call when they come back empty
 * (a market closure, not missing data). 12 × 395 one-minute slots is about
 * 79 hours: a weekend on a one-minute chart.
 */
export const MAX_WINDOWS = 12

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
  from = null,
  windowSlots = WINDOW_SLOTS,
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
  //
  // Claude · № 13,571 12-Oct (W5; claude-builder): and a cursor. A call that
  // stops on its row or error budget says where (`resumeFrom`), and a call
  // given `from` starts there, so rows that fail every pass at the front of
  // the list cannot hold back the rows behind them.
  const rows = db.prepare(`
    SELECT pm.id AS pmId, pm.trade_id AS tradeId, pm.symbol, pm.timeframe, pm.bars_json,
           t.closed_at
      FROM trade_postmortems pm
      JOIN trades t ON t.id = pm.trade_id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL
     ORDER BY t.closed_at DESC, pm.id DESC
  `).all()
  const cursor = parseCursor(from)

  const out = { examined: 0, updated: 0, barsAdded: 0, alreadyFull: 0, historyStillForming: 0, noNewerBarsYet: 0, noBars: 0, errors: 0, remaining: 0, fetches: 0, resumeFrom: null }
  const upd = db.prepare('UPDATE trade_postmortems SET bars_json = ? WHERE id = ?')

  for (const r of rows) {
    const ms = tfMs(r.timeframe) || 3_600_000
    const closedMs = sqliteMs(r.closed_at)
    if (cursor && Number.isFinite(closedMs) && (closedMs > cursor.closedMs || (closedMs === cursor.closedMs && r.pmId > cursor.pmId))) continue
    out.examined++
    if (!Number.isFinite(closedMs)) { out.noBars++; continue }

    let bars
    try { bars = JSON.parse(r.bars_json || 'null') } catch { bars = null }
    if (!Array.isArray(bars) || bars.length === 0) { out.noBars++; continue }

    const target = targetAfterBars(ms)
    const afterBars = bars.reduce((n, b) => n + (Array.isArray(b) && Number(b[0]) > closedMs ? 1 : 0), 0)
    if (afterBars >= target) { out.alreadyFull++; continue }
    if (now < closedMs + (target + 2) * ms) { out.historyStillForming++; continue }

    if (out.updated >= maxRows || out.errors >= maxErrors) {
      if (!out.resumeFrom) out.resumeFrom = `${closedMs}:${r.pmId}`
      out.remaining++
      continue
    }

    // Claude · № 13,571 12-Oct (W5; claude-builder). The window was fixed in
    // clock time at close + (target + 2) bars. Markets close — weekends,
    // nights, stock sessions — so that window held fewer bars than the
    // target, and once a pass had taken them every later pass found nothing
    // new and counted an error: measured 12-10, batch 2 of W5 updated 0 rows
    // and stopped on 25 errors. The window now starts at the row's own last
    // bar and steps forward through closures until the row holds the capture
    // convention (target + 2 bars after the close) or the present is reached.
    const want = target + 2
    const needed = want - afterBars
    const have = new Set(bars.map(b => Number(b?.[0])))
    let start = bars.reduce((m, b) => Math.max(m, Number(b?.[0]) || 0), 0)
    const add = []
    let failed = false
    let reachedNow = false
    for (let w = 0; w < MAX_WINDOWS && add.length < needed; w++) {
      const endMs = Math.min(now, start + windowSlots * ms)
      if (endMs <= start) { reachedNow = true; break }
      const count = Math.ceil((endMs - start) / ms) + 5
      let fresh = []
      try {
        out.fetches++
        fresh = await fetchBars(r.symbol, r.timeframe, count, endMs) || []
      } catch { failed = true; break }
      finally { if (throttleMs > 0) await sleep(throttleMs) }
      const got = fresh
        .filter(b => b && Number.isFinite(b.t) && b.t > start && b.t <= endMs && !have.has(b.t))
        .sort((x, y) => x.t - y.t)
      for (const b of got) { have.add(b.t); add.push([b.t, b.o, b.h, b.l, b.c, b.v ?? null]) }
      if (endMs >= now) { reachedNow = true; break }
      // The next window starts at the last bar that came back, not at this
      // window's end: the request spans a few slots more than `count`, so a
      // broker that kept the earliest bars of a full window would otherwise
      // leave a hole. No bar after `start` means the market was closed for
      // the whole window, whichever bars the broker kept.
      start = got.length ? got[got.length - 1].t : endMs
    }
    if (failed) { out.errors++; continue }
    if (!add.length) {
      // The broker has no bar after the row's last one up to now: the history
      // is not there yet (a recent close over a closure), not an error. The
      // row stays a candidate for a later call.
      if (reachedNow) out.noNewerBarsYet++
      else out.errors++ // MAX_WINDOWS empty windows short of the present: beyond retention or a dead name
      continue
    }
    add.length = Math.min(add.length, needed)

    const merged = [...bars, ...add].sort((a, b) => a[0] - b[0])
    upd.run(JSON.stringify(merged), r.pmId)
    out.updated++
    out.barsAdded += add.length
  }
  out.examinedTotal = rows.length
  return out
}

/** `"<closedMs>:<postmortemId>"` → the row a call resumes from, or null. */
export function parseCursor(from) {
  if (from == null || from === '') return null
  const m = /^(\d{1,15}):(\d{1,12})$/.exec(String(from))
  return m ? { closedMs: Number(m[1]), pmId: Number(m[2]) } : null
}
