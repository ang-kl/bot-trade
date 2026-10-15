// ─────────────────────────────────────────────────────────────────────────────
// Aftermath extension — the APPLY half. The preview (aftermath-extend.js)
// counted; this fetches and writes. Owner approved 25-08-2026 ("go for
// both"), after seeing the dry-run counts (897 extendable of 996), with the
// recommended 7-day wall-clock cap on slow timeframes: 96 bars of 8h chart is
// 32 days of candles for a replay whose slowest rule caps at 120 MINUTES —
// weeks of fetching for no additional verdict.
//
// What this must never do: touch anything except bars_json and its
// verification stamp (bars_verified_at, № 15,001). The classification,
// r_multiple, lesson — all of it was judged under the 12-bar verdict window
// and stays as judged (see REPLAY_AFTERMATH_BARS's comment). A row's top-up
// appends CLOSED aftermath bars, re-reads the newest stored one, dedupes on
// timestamp, keeps chronological order, and stops at the row's own target.
//
// Batched and resumable BY CONSTRUCTION: the candidate predicate is "short of
// target with history fully traded", so a re-run after any interruption picks
// up exactly the rows still short — nothing tracks progress, the data is the
// progress.
// ─────────────────────────────────────────────────────────────────────────────

import { tfMs, barCloseMs } from '../lib/timeframes.js'
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
/**
 * Codex P1 on #1331 (owner: "Add a per-call fetch budget"). Window fetches
 * one call may make before it stops and returns `resumeFrom`. A row beyond
 * the broker's retention comes back empty window after window (up to
 * MAX_WINDOWS), so the error budget alone allowed 25 × 12 = 300 requests in
 * one call: the shape that outlived Railway's edge timeout on 25-08. A row
 * already started may finish its windows, so a call makes at most
 * FETCH_BUDGET + MAX_WINDOWS − 1 fetches.
 */
export const FETCH_BUDGET = 100

/** Wall-clock ceiling for slow timeframes (owner-approved variant). */
export const SLOW_TF_CAP_MS = 7 * 24 * 3_600_000
const SLOW_TF_MS = 4 * 3_600_000 // 4h and above count as slow

/** Bars of aftermath a row of this bar-size should end up holding. */
export function targetAfterBars(barMs) {
  if (!(barMs >= SLOW_TF_MS)) return REPLAY_AFTERMATH_BARS
  return Math.min(REPLAY_AFTERMATH_BARS, Math.max(1, Math.floor(SLOW_TF_CAP_MS / barMs)))
}

/**
 * Top up stored replay windows from broker history. Writes bars_json and
 * bars_verified_at ONLY.
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
  maxFetches = FETCH_BUDGET,
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
  // Codex P1 on #1331 (owner: "Fix: sort by parsed time"): ordered by the
  // PARSED close time, the clock the cursor compares. The raw text sorts
  // '2026-09-01T09:00Z' after '2026-09-01 12:00:00' (T > space), so a cursor
  // taken inside the ISO-format rows of a day would skip that day's
  // space-format rows. Production stored one format on 12-10 (1,733 of 1,733
  // closed trades), so this guards the order rather than repairs it.
  const rows = db.prepare(`
    SELECT pm.id AS pmId, pm.trade_id AS tradeId, pm.symbol, pm.timeframe, pm.bars_json,
           pm.created_at, pm.bars_verified_at,
           t.closed_at
      FROM trade_postmortems pm
      JOIN trades t ON t.id = pm.trade_id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL
  `).all()
    .map(r => ({ ...r, closedMs: sqliteMs(r.closed_at) }))
    .sort((a, b) => (Number.isFinite(b.closedMs) ? b.closedMs : -Infinity) - (Number.isFinite(a.closedMs) ? a.closedMs : -Infinity) || b.pmId - a.pmId)
  const cursor = parseCursor(from)

  const out = { examined: 0, updated: 0, barsAdded: 0, barsReplaced: 0, barsDropped: 0, verified: 0, unavailable: 0, rowsWorked: 0, alreadyFull: 0, historyStillForming: 0, noNewerBarsYet: 0, noBars: 0, errors: 0, remaining: 0, fetches: 0, resumeFrom: null }
  // Claude · № 15,001 15-Oct (owner: "#35 forming bar — repair on next run" after № 14,989; claude-builder). bars_json and its verification stamp are the only columns written.
  const updBars = db.prepare('UPDATE trade_postmortems SET bars_json = ? WHERE id = ?')
  const updBoth = db.prepare('UPDATE trade_postmortems SET bars_json = ?, bars_verified_at = ? WHERE id = ?')
  const stamp = db.prepare('UPDATE trade_postmortems SET bars_verified_at = ? WHERE id = ?')
  const verifiedAt = new Date(now).toISOString()

  for (const r of rows) {
    const ms = tfMs(r.timeframe) || 3_600_000
    const closedMs = r.closedMs
    if (cursor && Number.isFinite(closedMs) && (closedMs > cursor.closedMs || (closedMs === cursor.closedMs && r.pmId > cursor.pmId))) continue
    out.examined++
    if (!Number.isFinite(closedMs)) { out.noBars++; continue }

    let bars
    try { bars = JSON.parse(r.bars_json || 'null') } catch { bars = null }
    if (!Array.isArray(bars) || bars.length === 0) { out.noBars++; continue }

    // Claude · № 15,001 15-Oct (owner: "#35 forming bar — repair on next run" after № 14,989; claude-builder). A bar's `t` is its OPEN (ctrader-ws.js: utcTimestampInMinutes)
    // and the broker's reply includes the bar still forming (fib-strategy.js
    // S-3). This writer kept it whenever a window reached the present, and
    // never re-read it: `start` was the newest stored t and the filter was
    // strictly after it, so the partial high/low/close/volume froze for every
    // reader. Three rules now:
    //  · a bar is CLOSED when its open plus one bar-length has passed; only
    //    closed bars are stored, and one still forming now is dropped from
    //    the row (the rule applied to what earlier passes stored);
    //  · the first window starts AT the newest stored bar, so its fresh copy
    //    replaces the stored one (fresh wins; a closed bar re-read is the
    //    same bar or the broker's correction);
    //  · the capture-time bar — the stored bar whose span held the row's
    //    created_at — is re-read once more, while the row is unverified.
    // The one-shot: bars_verified_at. A full row is re-read ONCE (the owner's
    // "repair on the next run"), then skipped as before, so the repair cannot
    // re-fire on every call and eat the fetch budget.
    // № 15,036 15-Oct (Codex round 2 on #1379, owner: "Fix both in round 3"; claude-builder): a fetched bar closes per barCloseMs (a synthesised aggregate
    // with its LAST constituent); a stored bar, which carries no tLast,
    // at t + ms.
    // № 15,05x 16-Oct (Codex round 3 on #1379, owner: "Round 4: fix all three"; claude-builder): a stored
    // array closes per barCloseMs too (calendar months); a stored aggregate
    // carries no tLast, so one spanning a closure is caught by its fresh
    // copy below (`dropT`), not here.
    const closedBar = (b) => Array.isArray(b) && Number.isFinite(Number(b[0])) && barCloseMs(b, ms) <= now
    const closedFresh = (b) => Number.isFinite(b?.t) && barCloseMs(b, ms) <= now
    const forming = bars.filter(b => !closedBar(b))
    if (forming.length) {
      bars = bars.filter(b => !forming.includes(b))
      out.barsDropped += forming.length
      // No fetch needed for a drop: written now, whatever the gates below say.
      updBars.run(JSON.stringify(bars), r.pmId)
      if (!bars.length) { out.noBars++; continue }
    }

    const target = targetAfterBars(ms)
    const afterBars = bars.reduce((n, b) => n + (Array.isArray(b) && Number(b[0]) > closedMs ? 1 : 0), 0)
    const needsVerify = !r.bars_verified_at
    const full = afterBars >= target
    if (full && !needsVerify) { out.alreadyFull++; continue }
    if (!full && now < closedMs + (target + 2) * ms) { out.historyStillForming++; continue }

    // № 15,001 Codex P2 on #1379 (owner: "Fix both"): a row that only
    // verified (stamped, nothing written) consumes the row budget like an
    // updated one, so `batch: 1` is one row's broker calls, not the fetch
    // budget's worth.
    if (out.rowsWorked >= maxRows || out.errors >= maxErrors || out.fetches >= maxFetches) {
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
    const needed = Math.max(0, want - afterBars)
    const have = new Map(bars.map(b => [Number(b?.[0]), b]))
    const tN = bars.reduce((m, b) => Math.max(m, Number(b?.[0]) || 0), 0)
    const createdMs = sqliteMs(r.created_at)
    const tC = needsVerify && Number.isFinite(createdMs)
      ? (bars.map(b => Number(b?.[0])).find(t => t <= createdMs && createdMs < t + ms) ?? null) : null
    const from = tC != null ? Math.min(tC, tN) : tN
    let start = from
    let first = true
    const add = [], repl = []
    let failed = false
    let reachedNow = false
    let sawNewest = false // the newest stored bar came back: the re-read happened
    let passedNewest = false // a window reached the newest stored bar's time
    // № 15,05x 16-Oct (Codex round 3 P1 on #1379, owner: "Round 4"): a STORED bar whose fresh copy is
    // still forming (a legacy aggregate whose last constituent has not closed:
    // the stored array has no tLast, so only the re-fetch can tell) is dropped
    // from the row and the row is not stamped — it reads short and is read
    // again once the bar has closed.
    const stored = new Set(bars.map(b => Number(b?.[0])))
    const dropT = new Set()
    // № 15,036 15-Oct (Codex round 2 on #1379, owner: "Fix both in round 3"; claude-builder): a verifying row keeps stepping windows until the newest stored
    // bar is reached (a 1m row captured on Friday and verified on Monday
    // needs several), bounded by MAX_WINDOWS; it is "unavailable" only once
    // a window has passed that bar without returning it.
    for (let w = 0; w < MAX_WINDOWS && (first || add.length < needed || (needsVerify && !sawNewest && !passedNewest)); w++) {
      const endMs = Math.min(now, start + windowSlots * ms)
      if (endMs <= start) { reachedNow = true; break }
      const count = Math.ceil((endMs - start) / ms) + 5
      let fresh = []
      try {
        out.fetches++
        fresh = await fetchBars(r.symbol, r.timeframe, count, endMs) || []
      } catch { failed = true; break }
      finally { if (throttleMs > 0) await sleep(throttleMs) }
      // The first window is inclusive of its start (the bar re-read); later
      // windows are strictly after the last bar that came back, as before.
      const inWindow = fresh.filter(b => b && Number.isFinite(b.t) && (first ? b.t >= start : b.t > start) && b.t <= endMs)
      for (const b of inWindow) if (stored.has(b.t) && !closedFresh(b)) dropT.add(b.t)
      const got = inWindow.filter(closedFresh).sort((x, y) => x.t - y.t)
      for (const b of got) {
        const bar = [b.t, b.o, b.h, b.l, b.c, b.v ?? null]
        if (b.t === tN) sawNewest = true
        // № 15,05x 16-Oct (Codex round 3 P1 on #1379, owner: "Round 4"): a stored bar reached in ANY
        // window is replaced by its fresh copy — the newest bar of a 1m row
        // captured on Friday and extended on Monday sits several windows
        // past the capture-time bar, and was marked seen without being replaced.
        if (have.has(b.t)) repl.push(bar)
        else { have.set(b.t, bar); add.push(bar) }
      }
      first = false
      if (endMs >= tN) passedNewest = true
      if (endMs >= now) { reachedNow = true; break }
      // The next window starts at the last bar that came back, not at this
      // window's end: the request spans a few slots more than `count`, so a
      // broker that kept the earliest bars of a full window would otherwise
      // leave a hole. No bar after `start` means the market was closed for
      // the whole window, whichever bars the broker kept.
      start = got.length ? got[got.length - 1].t : endMs
    }
    if (failed) { out.errors++; continue }
    if (!add.length && needed > 0) {
      // The broker has no bar after the row's last one up to now: the history
      // is not there yet (a recent close over a closure), not an error. The
      // row stays a candidate for a later call.
      if (reachedNow) out.noNewerBarsYet++
      else { out.errors++; continue } // MAX_WINDOWS empty windows short of the present: beyond retention or a dead name
    }
    add.length = Math.min(add.length, needed)

    // Merge: a re-read bar replaces the stored one only when it differs;
    // appends follow; the stamp records that the row was read against the
    // clock rule, whether or not anything changed.
    const sameBar = (a, b) => a && b && [0, 1, 2, 3, 4, 5].every(i => (a[i] ?? null) === (b[i] ?? null))
    const byT = new Map(bars.map(b => [Number(b[0]), b]))
    let changed = false
    for (const b of repl) { if (!sameBar(byT.get(b[0]), b)) { byT.set(b[0], b); changed = true; out.barsReplaced++ } }
    for (const b of add) { byT.set(b[0], b); changed = true }
    for (const t of dropT) { if (byT.delete(t)) { changed = true; out.barsDropped++ } }
    // № 15,001 Codex P1 on #1379 (owner: "Fix both"): the stamp says the
    // newest stored bar was re-read. A row beyond the broker's retention
    // answers with nothing — `needed` 0, nothing replaced — and must not be
    // stamped as verified: it records `unavailable:<time>` instead, one
    // fetch and then skipped like a verified row, but the value says the
    // broker had nothing, never that the bars were checked.
    // A row that just dropped a forming stored bar is neither verified nor
    // unavailable: its newest bar is not closed yet.
    const stampValue = dropT.size ? null : sawNewest ? verifiedAt : (needsVerify && needed === 0 && !add.length && passedNewest ? `unavailable:${verifiedAt}` : null)
    if (changed) {
      const merged = [...byT.values()].sort((a, b) => a[0] - b[0])
      if (stampValue === verifiedAt) updBoth.run(JSON.stringify(merged), verifiedAt, r.pmId)
      else updBars.run(JSON.stringify(merged), r.pmId)
      out.updated++
      out.barsAdded += add.length
      out.rowsWorked++
    } else if (needsVerify && stampValue) {
      stamp.run(stampValue, r.pmId)
      out.rowsWorked++
    }
    if (needsVerify && stampValue === verifiedAt) out.verified++
    else if (needsVerify && stampValue) out.unavailable++
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
