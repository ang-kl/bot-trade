// ---------------------------------------------------------------------------
// agent/lib/volume-structure.js — session volume structure: VPOC, LVN, and
// the bullish/bearish/ranging classification that comes from where a session
// OPENS relative to the previous session's value area.
//
// Why this exists separately from indicators.js's volumeProfile(). That
// function answers "where did volume trade over this slice of bars". These
// functions answer the questions a volume-profile trader actually asks:
//
//   · Where is the VPOC, and is it MOVING? A drifting point of control is the
//     one signal here that reads as repositioning rather than a static level.
//   · Where are the LOW volume nodes — the prices the market rejected, which
//     price tends to travel through quickly rather than linger in.
//   · Did today open above, below, or inside yesterday's value area? That is
//     the whole market-structure call, and it is a property of the SESSION
//     BOUNDARY, which volumeProfile() knows nothing about.
//
// SESSION BOUNDARY. The FX day, anchored at 17:00 New York — the same anchor
// risk.js uses for the daily loss cap (fxDayOpenMs), so "today" means one
// thing across this codebase. It is DST-aware because that function is.
//
// WHAT THIS FILE DOES NOT DO. It takes no trade decisions. Every function
// here is a pure read over bars; agent/services/va-breakout.js is where the
// entry rules live. Keeping them apart is what lets the structure be tested
// against fixtures without a strategy's gates in the way.
// ---------------------------------------------------------------------------

import { volumeProfile } from './indicators.js'

// The FX-day open (17:00 New York), DST-aware. Twin of risk.js's
// fxDayOpenMs — duplicated here, byte-for-byte in behaviour, because lib/
// must not import services/ (risk.js transitively imports the strategy
// registry, which imports vp-value.js, which imports THIS file — a cycle
// that deadlocks the registry's top-level await). The test asserts the two
// implementations agree, so a drift fails loudly rather than silently.
//
// PERFORMANCE (2026-07-28). This was the single hottest JS frame in a
// production CPU profile of the scan phase — 630ms of self time in one cycle,
// six times the next frame — because sessionSlices calls it ONCE PER BAR and
// each call built a fresh Intl.DateTimeFormat. Constructing one of those is
// among the most expensive things in the runtime (it resolves an ICU locale
// and time zone); doing it tens of thousands of times per scan is the whole
// cost. The formatter is stateless for formatToParts, so it is built once.
const NY_HMS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

// Second layer: the ANSWER is constant across a whole FX day, and bars in a
// scan cluster into a handful of days. Cache on the UTC hour — safe because
// both boundaries that can change the answer (17:00 New York, and the DST
// shift at 02:00 local) fall on exact UTC hour boundaries, so every instant
// within one UTC hour shares one FX-day open. Bounded so a long backtest
// cannot grow it without limit.
const dayOpenCache = new Map()
const DAY_OPEN_CACHE_MAX = 512

export function fxDayOpenMs(nowMs = Date.now()) {
  const hourKey = Math.floor(nowMs / 3_600_000)
  const hit = dayOpenCache.get(hourKey)
  if (hit !== undefined) return hit
  const parts = NY_HMS.formatToParts(new Date(nowMs))
  const get = (t) => Number(parts.find(p => p.type === t)?.value)
  const min = (get('hour') % 24) * 60 + get('minute')
  const anchorMin = 17 * 60
  const sinceMin = min >= anchorMin ? min - anchorMin : min + 24 * 60 - anchorMin
  const open = nowMs - sinceMin * 60_000 - get('second') * 1000 - (nowMs % 1000)
  if (dayOpenCache.size >= DAY_OPEN_CACHE_MAX) dayOpenCache.clear()
  dayOpenCache.set(hourKey, open)
  return open
}

/** Test seam — the cache must not carry answers between cases. */
export function _clearDayOpenCache() { dayOpenCache.clear() }

// A bucket counts as a low-volume node when it holds no more than this
// fraction of the POC bucket's volume. 0.3 is the conventional "thin" line —
// low enough that a genuinely traded price never qualifies, high enough that
// a real gap in participation does.
export const LVN_MAX_POC_FRACTION = 0.3

// A VPOC that moves less than this fraction of the value-area height between
// sessions is noise, not repositioning.
export const VPOC_DRIFT_MIN_FRACTION = 0.1

/**
 * Split bars into FX-day sessions, oldest first. Each entry is
 * { openMs, bars } and every bar belongs to exactly one session.
 *
 * Bars must be ascending by `t`. A session with no bars simply does not
 * appear — weekends and holidays produce gaps, not empty sessions, and a
 * caller asking for "the previous session" wants the previous session that
 * TRADED, not the previous calendar slot.
 */
export function sessionSlices(bars) {
  if (!Array.isArray(bars) || !bars.length) return []
  const out = []
  let current = null
  for (const b of bars) {
    const openMs = fxDayOpenMs(b.t)
    if (!current || current.openMs !== openMs) {
      current = { openMs, bars: [] }
      out.push(current)
    }
    current.bars.push(b)
  }
  return out
}

/**
 * VPOC / VAH / VAL for one set of bars, plus the profile rows the LVN search
 * needs. Returns null when the profile is degenerate (no volume, or a flat
 * series with no price span) rather than a shape with null prices in it —
 * callers should not have to check three fields to learn one fact.
 */
export function sessionProfile(bars, { buckets = 24 } = {}) {
  if (!Array.isArray(bars) || !bars.length) return null
  const vp = volumeProfile(bars, { type: 'composite', buckets })
  if (vp.pocPrice == null || vp.vahPrice == null || vp.valPrice == null) return null
  if (!(vp.vahPrice > vp.valPrice)) return null // single-bucket / flat profile
  return {
    vpoc: vp.pocPrice,
    vah: vp.vahPrice,
    val: vp.valPrice,
    height: vp.vahPrice - vp.valPrice,
    rows: vp.rows,
  }
}

/**
 * Low-volume nodes: contiguous runs of thin buckets, returned as price BANDS
 * rather than single prices.
 *
 * Bands, not points, because that is what an LVN is — a stretch of prices
 * nobody wanted. Reporting the midpoint of a five-bucket void as "the LVN"
 * would throw away its width, and the width is what tells you how far price
 * is likely to travel once it enters.
 *
 * The POC bucket itself can never qualify (it is the denominator), and a run
 * touching the very edge of the profile is dropped: the outermost bucket is
 * thin on every profile simply because the range ends there, and calling that
 * an LVN would put a "rejection zone" at the extreme of every session.
 *
 * @returns {{lo:number, hi:number, mid:number, volume:number, pctOfPoc:number}[]}
 *          ordered low price to high.
 */
export function lowVolumeNodes(profile, { maxPocFraction = LVN_MAX_POC_FRACTION } = {}) {
  const rows = profile?.rows
  if (!Array.isArray(rows) || rows.length < 3) return []
  const pocVolume = Math.max(...rows.map(r => r.volume))
  if (!(pocVolume > 0)) return []
  const threshold = pocVolume * maxPocFraction

  const bands = []
  let run = null
  rows.forEach((r, i) => {
    if (r.volume <= threshold) {
      if (!run) run = { fromIdx: i, toIdx: i, volume: 0 }
      run.toIdx = i
      run.volume += r.volume
    } else if (run) {
      bands.push(run)
      run = null
    }
  })
  if (run) bands.push(run)

  const step = rows.length > 1 ? rows[1].price - rows[0].price : 0
  return bands
    // Edge-touching runs are an artefact of where the profile stops, not a
    // void the market created.
    .filter(b => b.fromIdx > 0 && b.toIdx < rows.length - 1)
    .map(b => {
      const lo = rows[b.fromIdx].price - step / 2
      const hi = rows[b.toIdx].price + step / 2
      return {
        lo,
        hi,
        mid: (lo + hi) / 2,
        volume: b.volume,
        pctOfPoc: pocVolume > 0 ? (b.volume / pocVolume) * 100 : 0,
      }
    })
}

/**
 * Is a price inside a low-volume node?
 */
export function inLowVolumeNode(price, nodes) {
  return (nodes || []).some(n => price >= n.lo && price <= n.hi)
}

/**
 * Which way the VPOC has been travelling across consecutive sessions.
 *
 * `profiles` is oldest-first. Direction is decided by the NET move from the
 * first to the last VPOC, measured against the average value-area height so
 * the threshold means the same thing on EURUSD and on gold. A drift under
 * VPOC_DRIFT_MIN_FRACTION of that height is reported as 'flat' — the market
 * finding the same fair value two days running is information, and rounding
 * it into a direction would destroy it.
 *
 * @returns {{direction:'up'|'down'|'flat', drift:number, driftFraction:number,
 *            sessions:number, monotonic:boolean}|null}
 */
export function vpocMigration(profiles, { minFraction = VPOC_DRIFT_MIN_FRACTION } = {}) {
  const list = (profiles || []).filter(Boolean)
  if (list.length < 2) return null
  const first = list[0].vpoc
  const last = list[list.length - 1].vpoc
  const drift = last - first
  const avgHeight = list.reduce((s, p) => s + (p.height || 0), 0) / list.length
  if (!(avgHeight > 0)) return null
  const driftFraction = drift / avgHeight

  let direction = 'flat'
  if (driftFraction >= minFraction) direction = 'up'
  else if (driftFraction <= -minFraction) direction = 'down'

  // Monotonic migration — every session's VPOC further along than the last —
  // is a stronger claim than the same net move arrived at by zig-zag.
  let monotonic = direction !== 'flat'
  for (let i = 1; i < list.length && monotonic; i++) {
    const step = list[i].vpoc - list[i - 1].vpoc
    if (direction === 'up' ? step < 0 : step > 0) monotonic = false
  }

  return { direction, drift, driftFraction, sessions: list.length, monotonic }
}

/**
 * The market-structure call, from where THIS session opened relative to the
 * PREVIOUS session's value area:
 *
 *   above prev VAH  → 'bullish'  (VAH is now expected support)
 *   below prev VAL  → 'bearish'  (VAL is now expected resistance)
 *   inside          → 'ranging'  (indecision; the breakout setup lives here)
 *
 * `reference` is the level that becomes support/resistance under that
 * reading, and null when ranging — where there is no single level yet, and
 * saying otherwise would invent one.
 */
export function marketStructure(openPrice, prevProfile) {
  if (!Number.isFinite(openPrice) || !prevProfile) return null
  if (openPrice > prevProfile.vah) {
    return { structure: 'bullish', reference: prevProfile.vah, role: 'support' }
  }
  if (openPrice < prevProfile.val) {
    return { structure: 'bearish', reference: prevProfile.val, role: 'resistance' }
  }
  return { structure: 'ranging', reference: null, role: null }
}

/**
 * Everything above, assembled for one bar series: the previous session's
 * profile, this session's so far, the structure call, the LVNs of the
 * previous session, and the VPOC migration across the sessions supplied.
 *
 * Returns null when there is no COMPLETE previous session to measure against
 * — the whole method is relative to yesterday, and half of yesterday is not
 * a value area.
 */
export function volumeStructure(bars, { buckets = 24, migrationSessions = 3 } = {}) {
  const sessions = sessionSlices(bars)
  if (sessions.length < 2) return null

  const currentSession = sessions[sessions.length - 1]
  const prevSession = sessions[sessions.length - 2]
  const prev = sessionProfile(prevSession.bars, { buckets })
  if (!prev) return null

  const current = sessionProfile(currentSession.bars, { buckets })
  const openPrice = currentSession.bars[0].o
  const structure = marketStructure(openPrice, prev)

  const recent = sessions
    .slice(Math.max(0, sessions.length - 1 - migrationSessions), sessions.length - 1)
    .map(s => sessionProfile(s.bars, { buckets }))
    .filter(Boolean)

  return {
    prev,
    current,
    openPrice,
    openMs: currentSession.openMs,
    sessionBars: currentSession.bars.length,
    ...structure,
    lvns: lowVolumeNodes(prev),
    migration: vpocMigration(recent),
  }
}
