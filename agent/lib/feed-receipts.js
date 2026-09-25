// ---------------------------------------------------------------------------
// agent/lib/feed-receipts.js — what the agent actually RECEIVED from the
// broker's market feed (8,989-A row 11 second half, V3 WEB-9b / DF-2).
//
// The Data-feed card drew five fixed timeframe chips ('1m 15m 1h 4h 1D') and
// said "their receipt times are not measured", and it called the page's quote
// time a "broker receipt" when it was the agent's clock. Two records fix that:
//
//   1. BAR RECEIPTS, per timeframe. Every LIVE trendbar response (the window
//      ends now — a historical chart window is not a receipt of the current
//      feed) stamps its timeframe with the agent's receipt time, the newest
//      bar's open time, and whether that bar was still forming when it
//      arrived. Kept per SOURCE (the strategy scan, the fast monitor's volume
//      read, the positions' daily bar, …) so a chart request can never pass
//      for the scan's feed. A response with no bars is counted, not stamped:
//      an empty answer is not a received bar.
//
//   2. SPOT STAMPS. A timestamped spot stream (subscribeToSpotTimestamp)
//      carries the broker's own event time; receipt minus that time is the
//      feed latency. The first event per symbol per subscription is the
//      subscription's snapshot — possibly an old market-close quote — so it
//      is counted as a snapshot and kept out of the latency figures. An event
//      more than FEED_LATENCY_RANGE_MS from its receipt (either way) is counted
//      as out of range, not folded into a percentile. The figure INCLUDES any
//      clock offset between the broker and the agent; that is said wherever it
//      is served. Each host keeps its OWN ring of the newest MAX_SPOT_EVENTS
//      events, so a busy host can never push another host's events out; when
//      a host's ring dropped events inside the window, that host is served as
//      `truncated` with the span its figures really cover (`coversMs`), never
//      as the full window.
//
// RULES: in-process and bounded (timeframes, sources per timeframe, hosts and
// each host's spot ring are all capped); recording never throws into the caller and
// never changes a caller's result; nothing here reads or writes the database
// (services/feed-receipts-record.js persists the snapshot).
// ---------------------------------------------------------------------------

/** How far back the served feed-latency window reaches. */
export const FEED_LATENCY_WINDOW_MS = 10 * 60_000
/** A spot whose broker stamp is further than this from its receipt is out of range. */
export const FEED_LATENCY_RANGE_MS = 60_000
/** Spot events kept per broker host (a ring: the oldest is dropped first). */
export const MAX_SPOT_EVENTS = 4000
const MAX_TIMEFRAMES = 32
const MAX_SOURCES = 8
const MAX_HOSTS = 8
// A bar longer than a week (a calendar month) has no fixed duration, so
// "still forming at receipt" cannot be decided from periodMs alone.
const FORMING_MAX_PERIOD_MS = 7 * 86_400_000

const TIMEFRAME_RE = /^\d{1,4}(m|h|d|w|mo)$/
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/
const safeMs = (v) => Number.isSafeInteger(v) && v > 0
const idText = (v) => (v == null || v === '' ? null : String(v).slice(0, 64))

let state = fresh(Date.now())

function fresh(nowMs) {
  // spots: host → { events: [...oldest first], droppedThroughMs } — one ring
  // per host, so the hosts cap (MAX_HOSTS) also caps the rings.
  return { sinceMs: nowMs, timeframes: new Map(), spots: new Map(), lastMeasured: null, changedAtMs: 0 }
}

/** Test seam: forget everything, as a new process would. */
export function _resetFeedReceiptsForTests(nowMs = Date.now()) {
  state = fresh(nowMs)
}

/** Monotone change marker, so a persister can skip unchanged snapshots. */
export function feedReceiptsChangedAtMs() {
  return state.changedAtMs
}

/**
 * Stamp one LIVE trendbar response for one timeframe.
 *
 * @param {{timeframe: string, periodMs?: number, bars: Array<{t:number}>, receivedAtMs?: number,
 *   symbolId?: unknown, accountId?: unknown, host?: string, source?: string}} r
 * @returns {boolean} whether a receipt was stamped
 */
export function noteBarReceipt({ timeframe, periodMs = null, bars, receivedAtMs = Date.now(), symbolId = null, accountId = null, host = null, source = null } = {}) {
  try {
    if (typeof timeframe !== 'string' || !TIMEFRAME_RE.test(timeframe)) return false
    if (!safeMs(receivedAtMs) || !Array.isArray(bars)) return false
    const src = typeof source === 'string' && SOURCE_RE.test(source) ? source : 'other'
    let row = state.timeframes.get(timeframe)
    if (!row) {
      if (state.timeframes.size >= MAX_TIMEFRAMES) return false
      row = {
        timeframe,
        periodMs: Number.isSafeInteger(periodMs) && periodMs > 0 ? periodMs : null,
        bySource: new Map(),
        receipts: 0,
        emptyResponses: 0,
        lastEmptyAtMs: null,
      }
      state.timeframes.set(timeframe, row)
    }
    let newest = null
    for (const b of bars) if (b && safeMs(b.t) && (newest == null || b.t > newest)) newest = b.t
    if (newest == null) {
      row.emptyResponses++
      row.lastEmptyAtMs = receivedAtMs
      state.changedAtMs = Math.max(state.changedAtMs + 1, receivedAtMs)
      return false
    }
    if (!row.bySource.has(src) && row.bySource.size >= MAX_SOURCES) return false
    const pm = row.periodMs
    row.bySource.set(src, {
      source: src,
      receivedAtMs,
      newestBarOpenMs: newest,
      newestBarForming: pm != null && pm <= FORMING_MAX_PERIOD_MS ? newest + pm > receivedAtMs : null,
      bars: bars.length,
      symbolId: idText(symbolId),
      accountId: idText(accountId),
      host: idText(host),
      fromPreviousProcess: false,
    })
    row.receipts++
    state.changedAtMs = Math.max(state.changedAtMs + 1, receivedAtMs)
    return true
  } catch {
    return false
  }
}

/**
 * One spot event from a timestamped stream.
 *
 * @param {{brokerAtMs: unknown, receivedAtMs?: number, host?: string, accountId?: unknown,
 *   symbolId?: unknown, snapshot?: boolean}} e
 *   `snapshot`: the first event for this symbol on this subscription.
 * @returns {'measured'|'snapshot'|'unstamped'|'out_of_range'|null}
 */
export function noteSpotStamp({ brokerAtMs, receivedAtMs = Date.now(), host = null, accountId = null, symbolId = null, snapshot = false } = {}) {
  try {
    if (!safeMs(receivedAtMs)) return null
    const h = idText(host) ?? 'unknown host'
    let ring = state.spots.get(h)
    if (!ring) {
      if (state.spots.size >= MAX_HOSTS) return null
      ring = { events: [], droppedThroughMs: 0 }
      state.spots.set(h, ring)
    }
    let kind
    let latencyMs = null
    if (snapshot) kind = 'snapshot'
    else if (!safeMs(brokerAtMs)) kind = 'unstamped'
    else {
      latencyMs = receivedAtMs - brokerAtMs
      kind = Math.abs(latencyMs) > FEED_LATENCY_RANGE_MS ? 'out_of_range' : 'measured'
      if (kind !== 'measured') latencyMs = null
    }
    ring.events.push({ atMs: receivedAtMs, kind, latencyMs, host: h, accountId: idText(accountId), symbolId: idText(symbolId) })
    // Drop this host's oldest, remembering how far the dropping reached, so a
    // window the ring no longer covers is served as truncated.
    while (ring.events.length > MAX_SPOT_EVENTS) {
      const gone = ring.events.shift()
      if (gone.atMs > ring.droppedThroughMs) ring.droppedThroughMs = gone.atMs
    }
    state.changedAtMs = Math.max(state.changedAtMs + 1, receivedAtMs)
    return kind
  } catch {
    return null
  }
}

/** Nearest-rank percentile of an ascending array — every value one that was measured. */
function nearestRank(sortedAsc, p) {
  if (!sortedAsc.length) return null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]
}

/**
 * Per-host figures over [fromMs, nowMs]. A host whose ring dropped an event
 * at or after `fromMs` is `truncated`: its figures cover only
 * `nowMs - oldestAtMs`, served as `coversMs`, not the whole window.
 */
function latencyByHost(fromMs, nowMs) {
  const by = new Map()
  for (const [host, ring] of state.spots) {
    const truncated = ring.droppedThroughMs >= fromMs
    for (const e of ring.events) {
      if (e.atMs < fromMs || e.atMs > nowMs) continue
      let b = by.get(host)
      if (!b) { b = { host, lat: [], snapshots: 0, unstamped: 0, outOfRange: 0, accounts: new Set(), symbols: new Set(), newestAtMs: 0, oldestAtMs: 0, truncated }; by.set(host, b) }
      noteInto(b, e)
    }
  }
  return [...by.values()].sort((a, b) => a.host.localeCompare(b.host)).map(b => hostFigures(b, nowMs))
}

function noteInto(b, e) {
  if (e.kind === 'measured') b.lat.push(e.latencyMs)
  else if (e.kind === 'snapshot') b.snapshots++
  else if (e.kind === 'unstamped') b.unstamped++
  else if (e.kind === 'out_of_range') b.outOfRange++
  if (e.accountId) b.accounts.add(e.accountId)
  if (e.symbolId) b.symbols.add(e.symbolId)
  if (e.atMs > b.newestAtMs) b.newestAtMs = e.atMs
  if (!b.oldestAtMs || e.atMs < b.oldestAtMs) b.oldestAtMs = e.atMs
}

function hostFigures(b, nowMs) {
  const lat = b.lat.sort((x, y) => x - y)
  return {
    host: b.host,
    events: lat.length,
    p50Ms: nearestRank(lat, 50),
    p90Ms: nearestRank(lat, 90),
    maxMs: lat.length ? lat[lat.length - 1] : null,
    minMs: lat.length ? lat[0] : null,
    snapshotsSkipped: b.snapshots,
    unstamped: b.unstamped,
    outOfRange: b.outOfRange,
    accounts: [...b.accounts].sort(),
    symbols: b.symbols.size,
    newestAtMs: b.newestAtMs || null,
    oldestAtMs: b.oldestAtMs || null,
    truncated: b.truncated,
    // The span these figures really cover: the whole window, or — when the
    // ring dropped events inside it — back to the oldest event it kept.
    coversMs: b.truncated ? Math.max(0, nowMs - b.oldestAtMs) : FEED_LATENCY_WINDOW_MS,
  }
}

function timeframeRow(row, nowMs) {
  const sources = [...row.bySource.values()]
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
    .map(s => ({ ...s, ageMs: Math.max(0, nowMs - s.receivedAtMs) }))
  const latest = sources[0] ?? null
  return {
    timeframe: row.timeframe,
    periodMs: row.periodMs,
    lastReceivedAtMs: latest?.receivedAtMs ?? null,
    ageMs: latest ? latest.ageMs : null,
    source: latest?.source ?? null,
    newestBarOpenMs: latest?.newestBarOpenMs ?? null,
    newestBarForming: latest ? latest.newestBarForming : null,
    bars: latest?.bars ?? null,
    accountId: latest?.accountId ?? null,
    host: latest?.host ?? null,
    sources,
    receipts: row.receipts,
    emptyResponses: row.emptyResponses,
    lastEmptyAtMs: row.lastEmptyAtMs,
    fromPreviousProcess: latest ? latest.fromPreviousProcess === true : false,
  }
}

/**
 * Everything recorded, as served on GET /state/data-feed.
 * @param {number} [nowMs]
 */
export function feedReceiptsSnapshot(nowMs = Date.now()) {
  const byHost = latencyByHost(nowMs - FEED_LATENCY_WINDOW_MS, nowMs)
  if (byHost.some(h => h.events > 0)) {
    state.lastMeasured = { atMs: Math.max(...byHost.map(h => h.newestAtMs || 0)), windowMs: FEED_LATENCY_WINDOW_MS, byHost: byHost.filter(h => h.events > 0) }
  }
  const timeframes = [...state.timeframes.values()]
    .map(r => timeframeRow(r, nowMs))
    .sort((a, b) => (a.periodMs ?? Infinity) - (b.periodMs ?? Infinity) || a.timeframe.localeCompare(b.timeframe))
  return {
    bars: {
      sinceMs: state.sinceMs,
      timeframes,
      meaning: 'when the agent last received bars of each timeframe from the broker (agent clock), per source; live windows only',
    },
    feedLatency: {
      status: byHost.some(h => h.events > 0) ? 'measured' : 'not_measured_recently',
      windowMs: FEED_LATENCY_WINDOW_MS,
      rangeMs: FEED_LATENCY_RANGE_MS,
      maxEventsPerHost: MAX_SPOT_EVENTS,
      truncated: byHost.some(h => h.truncated),
      sinceMs: state.sinceMs,
      byHost,
      lastMeasured: state.lastMeasured,
      source: 'timestamped spot stream (GET /actions/stream-prices)',
      meaning: 'broker spot timestamp to agent receipt; includes any clock offset between the broker and the agent; the first event per symbol per subscription is its snapshot and is not counted',
    },
  }
}

/** The part of the snapshot worth keeping across a restart. */
export function feedReceiptsForStore(nowMs = Date.now()) {
  const snap = feedReceiptsSnapshot(nowMs)
  return {
    v: 1,
    at: nowMs,
    sinceMs: snap.bars.sinceMs,
    timeframes: snap.bars.timeframes.map(r => ({
      timeframe: r.timeframe,
      periodMs: r.periodMs,
      sources: r.sources.map(s => ({
        source: s.source, receivedAtMs: s.receivedAtMs, newestBarOpenMs: s.newestBarOpenMs, newestBarForming: s.newestBarForming,
        bars: s.bars, symbolId: s.symbolId, accountId: s.accountId, host: s.host,
      })),
    })),
    lastMeasured: snap.feedLatency.lastMeasured,
  }
}

/**
 * Seed the in-process record from a stored snapshot (boot). A stored source
 * never replaces a newer one this process already received; every seeded row
 * is marked `fromPreviousProcess` until this process receives that timeframe.
 * @returns {number} timeframes seeded
 */
export function hydrateFeedReceipts(stored) {
  try {
    if (!stored || stored.v !== 1 || !Array.isArray(stored.timeframes)) return 0
    let n = 0
    for (const t of stored.timeframes.slice(0, MAX_TIMEFRAMES)) {
      if (!t || typeof t.timeframe !== 'string' || !TIMEFRAME_RE.test(t.timeframe) || !Array.isArray(t.sources)) continue
      let row = state.timeframes.get(t.timeframe)
      if (!row) {
        if (state.timeframes.size >= MAX_TIMEFRAMES) break
        row = { timeframe: t.timeframe, periodMs: Number.isSafeInteger(t.periodMs) && t.periodMs > 0 ? t.periodMs : null, bySource: new Map(), receipts: 0, emptyResponses: 0, lastEmptyAtMs: null }
        state.timeframes.set(t.timeframe, row)
      }
      let seeded = false
      for (const s of t.sources.slice(0, MAX_SOURCES)) {
        if (!s || typeof s.source !== 'string' || !SOURCE_RE.test(s.source) || !safeMs(s.receivedAtMs) || !safeMs(s.newestBarOpenMs)) continue
        const have = row.bySource.get(s.source)
        if (have && have.receivedAtMs >= s.receivedAtMs) continue
        if (!have && row.bySource.size >= MAX_SOURCES) continue
        row.bySource.set(s.source, {
          source: s.source,
          receivedAtMs: s.receivedAtMs,
          newestBarOpenMs: s.newestBarOpenMs,
          newestBarForming: typeof s.newestBarForming === 'boolean' ? s.newestBarForming : null,
          bars: Number.isSafeInteger(s.bars) && s.bars >= 0 ? s.bars : null,
          symbolId: idText(s.symbolId),
          accountId: idText(s.accountId),
          host: idText(s.host),
          fromPreviousProcess: true,
        })
        seeded = true
      }
      if (seeded) n++
    }
    const lm = stored.lastMeasured
    if (!state.lastMeasured && lm && safeMs(lm.atMs) && Array.isArray(lm.byHost)) {
      state.lastMeasured = { atMs: lm.atMs, windowMs: Number(lm.windowMs) || FEED_LATENCY_WINDOW_MS, byHost: lm.byHost.slice(0, MAX_HOSTS), fromPreviousProcess: true }
    }
    return n
  } catch {
    return 0
  }
}
