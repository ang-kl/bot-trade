// ---------------------------------------------------------------------------
// agent/lib/bar-path-counters.js — S-3 Phase 0: MEASURE the bar path before
// anything is built on it (owner-approved plan 26-09-2026, §6 "measure
// first"; OD-28: a bar store only past p95 token wait > 5 s, or > 5 % scan
// deadline hits).
//
// In-memory, process-wide, and read-only to everything but the recorders: a
// counter that could refuse a fetch would be a gate, and this is not one.
// Every recorder is wrapped so instrumentation can never break the request it
// observes (the same contract as ctrader-session.js noteTokenWait).
//
// WHAT IS COUNTED, and where each number comes from:
//   tokenWait  — every historical request's wait on the shared token bucket,
//                from noteTokenWait (ctrader-session.js), BOTH request paths,
//                by purpose ('strategy_scan', 'regime', …; 'other' unnamed).
//   scanPasses — every completed runFibScan pass, and how many hit the scan
//                deadline (loop.js).
//   fetches    — every scan/regime trendbar fetch: bars asked, bars the
//                broker returned, by purpose; `shallowRefetches` counts cache
//                entries refetched because a shallower caller had written
//                them (the regime read's 30–80 bars under the scan's key).
//   starved    — per strategy × timeframe: a scan evaluation that handed the
//                strategy fewer closed bars than its own minBars.
//   history    — per symbol × timeframe: the deepest history the broker has
//                returned when asked for more than it holds (BTCUSD 1mo: 190).
//                Read by armed-cell-reachability to mark impossible cells.
//                "Fewer bars than asked" is NOT this: the request is bounded
//                by a time window (ctrader-ws.js trendbarWindowStartMs), so a
//                symbol that closes at weekends returns fewer bars than asked
//                with years of history behind it (EURUSD 1h: ~328 of 451).
//                THE WINDOW ITSELF IS PADDED: wsGetTrendbarsBatch asks for
//                WINDOW_PAD_BARS (5) periods more than fetchCount
//                (ctrader-ws.js planWindowStartMs), so a plain COUNT-limited
//                answer for a 24/7 symbol — the broker simply has no more
//                bars past its most recent `fetchCount` — starts its first
//                bar ~5 periods after the window's left edge even though
//                nothing closed it early. Measured 26-09-2026: BTCUSD 1w
//                asked 451, got 450, first bar 2018-02-04, window opened
//                2017-12-30 — a 36-day gap that is exactly ~5 weekly
//                periods, not history running out (2018-02-04..2026-09-13 is
//                precisely 450 weekly bars; the true history-limited case,
//                BTCUSD 1mo, gaps by decades: asked 451, got 190, first bar
//                2010-06-30). Only an answer whose FIRST bar starts well
//                inside the window — past HISTORY_EDGE_MS and two periods
//                after its left edge, THEN past the window's own pad — is
//                the broker running out of history. The rest is counted as
//                `windowLimited`.
//
// "Not measured" is a first-class answer: `barPathView` returns
// `state: 'not_measured'` for any block with no sample, never a zero that
// reads as "no wait" (CLAUDE.md failure mode #3).
// ---------------------------------------------------------------------------

const SAMPLE_CAP = 512          // ring buffer for the p95 — bounded memory
const HISTORY_CAP = 2000        // symbol × timeframe entries kept
const STARVED_CAP = 500
const DAY_MS = 86_400_000
/** Longer than any market closure (a weekend plus a holiday is <= 4 days). */
export const HISTORY_EDGE_MS = 7 * DAY_MS

/**
 * How many extra periods wsGetTrendbarsBatch pads its request window by,
 * beyond `fetchCount` (ctrader-ws.js planWindowStartMs uses this SAME
 * constant, imported from here, so the two cannot drift apart). A
 * count-limited answer — the broker has no bars past what it just returned,
 * nothing closed early — therefore starts its first bar up to this many
 * periods after the window's left edge on its own, before history is
 * considered. isHistoryLimited's margin must clear this pad or every
 * ordinary count-limited answer on a long-enough period (weekly, monthly)
 * reads as the broker's whole history (measured 26-09-2026: BTCUSD 1w,
 * asked 451 got 450, falsely marked history-limited by a 36-day gap that
 * was 5 padded weeks, not the broker running out of bars).
 */
export const WINDOW_PAD_BARS = 5

/**
 * Whether one short answer is the broker's WHOLE history rather than the
 * request window: its first bar starts more than max(HISTORY_EDGE_MS, two
 * periods), PLUS the window's own WINDOW_PAD_BARS pad, after the window's
 * left edge. Missing inputs -> false: an answer that cannot be placed in its
 * window is never marked as history (it would be a guess presented as a
 * measurement).
 */
export function isHistoryLimited({ firstBarT, fromTs, periodMs = 0 } = {}) {
  const f = Number(firstBarT), w = Number(fromTs)
  if (firstBarT == null || fromTs == null || !Number.isFinite(f) || !Number.isFinite(w) || f <= 0 || w <= 0) return false
  const p = Number(periodMs) || 0
  const margin = Math.max(HISTORY_EDGE_MS, 2 * p) + WINDOW_PAD_BARS * p
  return f - w > margin
}

let state = fresh()

function fresh() {
  return {
    since: Date.now(),
    tokenWait: { count: 0, waited: 0, totalMs: 0, maxMs: 0, samples: [], next: 0, byPurpose: {} },
    scanPasses: { count: 0, deadlineHits: 0, lastAtMs: null, lastDeadlineAtMs: null },
    fetches: { byPurpose: {}, shallowRefetches: 0, windowLimited: 0 },
    starved: new Map(),   // `${strategy}|${tf}` -> { strategy, timeframe, count, lastHave, need, lastAtMs }
    history: new Map(),   // `${symbol}|${tf}`   -> { symbol, timeframe, asked, got, atMs }
  }
}

const safe = (fn) => { try { fn() } catch { /* instrumentation is not a gate */ } }

/** One historical request's wait on the token bucket (ms), from noteTokenWait. */
export function recordTokenWait(ms, purpose = 'other') {
  safe(() => {
    const w = Math.max(0, Number(ms) || 0)
    const t = state.tokenWait
    t.count++
    if (w > 0) t.waited++
    t.totalMs += w
    if (w > t.maxMs) t.maxMs = w
    if (t.samples.length < SAMPLE_CAP) t.samples.push(w)
    else { t.samples[t.next] = w; t.next = (t.next + 1) % SAMPLE_CAP }
    const p = String(purpose || 'other')
    const b = (t.byPurpose[p] ||= { count: 0, totalMs: 0, maxMs: 0 })
    b.count++; b.totalMs += w; if (w > b.maxMs) b.maxMs = w
  })
}

/** One completed scan pass (runFibScan), and whether it hit its deadline. */
export function recordScanPass({ deadlineHit = false, atMs = Date.now() } = {}) {
  safe(() => {
    const s = state.scanPasses
    s.count++
    s.lastAtMs = atMs
    if (deadlineHit) { s.deadlineHits++; s.lastDeadlineAtMs = atMs }
  })
}

/**
 * One trendbar fetch for one symbol × timeframe. `asked` is the count
 * requested, `got` the bars returned, `firstBarT` the open time of the first
 * bar returned, `fromTs` the request window's left edge, `periodMs` the
 * timeframe's length. A short answer is recorded as the symbol's history only
 * when isHistoryLimited says the broker ran out of bars before the window
 * did; otherwise it is `windowLimited` (weekends, closures, a capped base
 * fetch) and says nothing about what the broker holds.
 */
export function recordBarFetch({ purpose = 'other', symbol = null, timeframe = null, asked = 0, got = 0, firstBarT = null, fromTs = null, periodMs = 0, shallowRefetch = false, atMs = Date.now() } = {}) {
  safe(() => {
    const p = String(purpose || 'other')
    const b = (state.fetches.byPurpose[p] ||= { requests: 0, barsAsked: 0, barsReturned: 0, short: 0, historyLimited: 0 })
    b.requests++
    b.barsAsked += Number(asked) || 0
    b.barsReturned += Number(got) || 0
    if (shallowRefetch) state.fetches.shallowRefetches++
    const short = Number(asked) > 0 && Number(got) < Number(asked)
    if (short) b.short++
    if (symbol == null || timeframe == null || !(Number(asked) > 0)) return
    const key = `${String(symbol).toUpperCase()}|${timeframe}`
    if (short && isHistoryLimited({ firstBarT, fromTs, periodMs })) {
      b.historyLimited++
      if (!state.history.has(key) && state.history.size >= HISTORY_CAP) return
      state.history.set(key, {
        symbol: String(symbol).toUpperCase(), timeframe, asked: Number(asked), got: Number(got),
        firstBarAt: new Date(Number(firstBarT)).toISOString(), windowFrom: new Date(Number(fromTs)).toISOString(), atMs,
      })
      return
    }
    if (short) state.fetches.windowLimited++
    // Any answer that is not history-limited — full, or short only because
    // of the window — supersedes an earlier history row (history grew, or
    // the earlier answer was a broker hiccup): never keep a stale "impossible".
    state.history.delete(key)
  })
}

/** A strategy handed fewer closed bars than its own minBars on one evaluation. */
export function recordStarved({ strategy, timeframe, have, need, atMs = Date.now() } = {}) {
  safe(() => {
    const key = `${strategy}|${timeframe}`
    if (!state.starved.has(key) && state.starved.size >= STARVED_CAP) return
    const e = state.starved.get(key) || { strategy, timeframe, count: 0, lastHave: null, need: null, lastAtMs: null }
    e.count++; e.lastHave = Number(have) || 0; e.need = Number(need) || 0; e.lastAtMs = atMs
    state.starved.set(key, e)
  })
}

/** The broker's observed history depth per symbol × timeframe, where its history — not the request window — ended first. */
export function shortHistory() {
  return [...state.history.values()]
}

const p95 = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}

/**
 * The Phase 0 block for GET /state/data-feed. Each part is `not_measured`
 * until it has a sample. `thresholds` are OD-28's store triggers, stated so
 * the reader compares against the rule rather than a remembered number.
 */
export function barPathView(nowMs = Date.now()) {
  const t = state.tokenWait
  const s = state.scanPasses
  const fetchPurposes = Object.keys(state.fetches.byPurpose)
  return {
    since: new Date(state.since).toISOString(),
    asOfMs: nowMs,
    note: 'process-wide since this agent started; a restart resets it. Phase 0 of the bar path (S-3): measured before any bar store is built.',
    thresholds: { tokenWaitP95Ms: 5000, deadlineHitShare: 0.05, source: 'OD-28: build the store only past p95 token wait > 5 s, or > 5 % scan deadline hits' },
    tokenWait: t.count === 0
      ? { state: 'not_measured', note: 'no historical request has been made since start' }
      : {
        state: 'measured', requests: t.count, waitedRequests: t.waited,
        meanMs: Math.round(t.totalMs / t.count), p95Ms: p95(t.samples), maxMs: t.maxMs,
        sampleSize: t.samples.length, byPurpose: t.byPurpose,
      },
    deadline: s.count === 0
      ? { state: 'not_measured', note: 'no scan pass has completed since start' }
      : {
        state: 'measured', scanPasses: s.count, deadlineHits: s.deadlineHits,
        share: Math.round((s.deadlineHits / s.count) * 10_000) / 10_000,
        lastPassAt: s.lastAtMs ? new Date(s.lastAtMs).toISOString() : null,
        lastDeadlineAt: s.lastDeadlineAtMs ? new Date(s.lastDeadlineAtMs).toISOString() : null,
      },
    fetches: fetchPurposes.length === 0
      ? { state: 'not_measured', note: 'no trendbar fetch has been made since start' }
      : {
        state: 'measured', byPurpose: state.fetches.byPurpose, shallowRefetches: state.fetches.shallowRefetches,
        windowLimited: state.fetches.windowLimited,
        note: '`short` = answers with fewer bars than asked; `historyLimited` = the subset where the broker ran out of history (listed under shortHistory); `windowLimited` = short only because the request\'s time window spans weekends or closures — the symbol\'s history is deeper.',
      },
    starved: state.starved.size === 0
      ? { state: s.count === 0 ? 'not_measured' : 'none', rows: [] }
      : { state: 'measured', rows: [...state.starved.values()].sort((a, b) => b.count - a.count) },
    shortHistory: state.history.size === 0
      ? { state: fetchPurposes.length === 0 ? 'not_measured' : 'none', rows: [] }
      : { state: 'measured', rows: shortHistory(), note: 'the first bar returned starts well after the request window opened: the broker holds no earlier bars on this symbol × timeframe' },
  }
}

/** Test seam: the counters are process-wide. */
export function _resetBarPathCountersForTests() { state = fresh() }
