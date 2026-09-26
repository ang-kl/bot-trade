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
//
// "Not measured" is a first-class answer: `barPathView` returns
// `state: 'not_measured'` for any block with no sample, never a zero that
// reads as "no wait" (CLAUDE.md failure mode #3).
// ---------------------------------------------------------------------------

const SAMPLE_CAP = 512          // ring buffer for the p95 — bounded memory
const HISTORY_CAP = 2000        // symbol × timeframe entries kept
const STARVED_CAP = 500

let state = fresh()

function fresh() {
  return {
    since: Date.now(),
    tokenWait: { count: 0, waited: 0, totalMs: 0, maxMs: 0, samples: [], next: 0, byPurpose: {} },
    scanPasses: { count: 0, deadlineHits: 0, lastAtMs: null, lastDeadlineAtMs: null },
    fetches: { byPurpose: {}, shallowRefetches: 0 },
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
 * requested, `got` the bars returned. When the broker returns fewer than
 * asked, its history for that symbol × timeframe is `got` deep — recorded.
 */
export function recordBarFetch({ purpose = 'other', symbol = null, timeframe = null, asked = 0, got = 0, shallowRefetch = false, atMs = Date.now() } = {}) {
  safe(() => {
    const p = String(purpose || 'other')
    const b = (state.fetches.byPurpose[p] ||= { requests: 0, barsAsked: 0, barsReturned: 0, short: 0 })
    b.requests++
    b.barsAsked += Number(asked) || 0
    b.barsReturned += Number(got) || 0
    if (shallowRefetch) state.fetches.shallowRefetches++
    if (symbol != null && timeframe != null && Number(asked) > 0 && Number(got) < Number(asked)) {
      b.short++
      const key = `${String(symbol).toUpperCase()}|${timeframe}`
      if (!state.history.has(key) && state.history.size >= HISTORY_CAP) return
      state.history.set(key, { symbol: String(symbol).toUpperCase(), timeframe, asked: Number(asked), got: Number(got), atMs })
    } else if (symbol != null && timeframe != null && Number(asked) > 0) {
      // A full answer supersedes an earlier short one (history grew, or the
      // short answer was a broker hiccup) — never keep a stale "impossible".
      state.history.delete(`${String(symbol).toUpperCase()}|${timeframe}`)
    }
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

/** The broker's observed history depth per symbol × timeframe, where it fell short of a request. */
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
      : { state: 'measured', byPurpose: state.fetches.byPurpose, shallowRefetches: state.fetches.shallowRefetches },
    starved: state.starved.size === 0
      ? { state: s.count === 0 ? 'not_measured' : 'none', rows: [] }
      : { state: 'measured', rows: [...state.starved.values()].sort((a, b) => b.count - a.count) },
    shortHistory: state.history.size === 0
      ? { state: fetchPurposes.length === 0 ? 'not_measured' : 'none', rows: [] }
      : { state: 'measured', rows: shortHistory() },
  }
}

/** Test seam: the counters are process-wide. */
export function _resetBarPathCountersForTests() { state = fresh() }
