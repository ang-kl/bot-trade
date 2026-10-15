// agent/services/tick-activity.js — tick-rate per symbol per minute, read off
// the guardian's spot stream. STEP 1 of the activity screener: measurement
// only, no scan change.
//
// Claude · № 15,036 15-Oct (owner, after № 15,032: "scan for trending volume
// symbols and seek opportunity to trade them, rather than sequence scanning";
// approved "go" after № 15,036; claude-builder).
//
// cTrader's "volume" for a trendbar is TICK volume (the Open API docs said
// "cents"; Spotware support: ticks). The guardian already receives every tick
// for the enabled watchlist on a push-based spot stream (services/guardian.js),
// so tick count per minute IS the broker's volume for that minute, with no
// historical request spent (those are capped at 5/s per connection and the
// scan already uses them). Step 1 records it and publishes a ranked readout;
// step 2 (a later PR, after 24 h of production figures) turns the measured
// distribution into a scan-priority trigger. Thresholds are NOT chosen here —
// the owner's grounding rule: expected values from measurement, not design.
//
// Module state by design (one stream, one map), like the guardian's spot
// cache. Each symbol keeps a ring of the last RING_MINUTES complete minutes:
// tick count, and the first/last mid of the minute (for the move).

export const RING_MINUTES = 60
export const MEDIAN_MINUTES = 20
export const ACTIVITY_STATE_KEY = 'tick_activity_json'
export const ACTIVITY_FLUSH_MS = 60_000

const BY_SYMBOL = new Map() // symbolId → Map<minuteIdx, { n, first, last }>

const minuteOf = (ms) => Math.floor(ms / 60_000)

/** One tick. `price` is the mid the guardian computed; a non-positive price is ignored. */
export function noteTick(symbolId, price, at = Date.now()) {
  if (symbolId == null || !(price > 0) || !Number.isFinite(at)) return
  const id = Number(symbolId)
  let ring = BY_SYMBOL.get(id)
  if (!ring) { ring = new Map(); BY_SYMBOL.set(id, ring) }
  const m = minuteOf(at)
  const cell = ring.get(m)
  if (cell) { cell.n++; cell.last = price } else { ring.set(m, { n: 1, first: price, last: price }) }
  // prune: keep the ring bounded whatever the tick rate
  if (ring.size > RING_MINUTES + 2) {
    const floor = m - RING_MINUTES - 1
    for (const k of ring.keys()) if (k < floor) ring.delete(k)
  }
}

/** Median of a list of numbers (zeros included: a silent minute counts as 0, not as missing). */
export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return 0
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * Per-symbol figures at `now`, over COMPLETE minutes only (the current minute
 * is still forming — the same rule as bars). `ticksLastMin` is the last
 * complete minute; `median20` the median over the 20 complete minutes before
 * it (silent minutes count 0); `relActivity` = ticksLastMin ÷ max(median20, 1)
 * — the one figure step 2 will threshold; `movePct1m` the last complete
 * minute's first→last mid move in percent (signed). Symbols with no tick in
 * the ring are absent: silence is reported by absence, never by a guessed 0.
 */
export function activitySnapshot({ now = Date.now(), symbolNames = {} } = {}) {
  const cur = minuteOf(now)
  const out = []
  for (const [id, ring] of BY_SYMBOL) {
    const last = ring.get(cur - 1)
    const prior = []
    for (let k = cur - 1 - MEDIAN_MINUTES; k < cur - 1; k++) prior.push(ring.get(k)?.n ?? 0)
    const ticksLastMin = last?.n ?? 0
    const median20 = median(prior)
    const movePct1m = last && last.first > 0 ? (last.last - last.first) / last.first * 100 : null
    let lastTickMinute = null
    for (const k of ring.keys()) if (lastTickMinute == null || k > lastTickMinute) lastTickMinute = k
    if (lastTickMinute == null || lastTickMinute < cur - RING_MINUTES) continue
    out.push({
      symbolId: id,
      symbol: symbolNames[id] || symbolNames[String(id)] || `#${id}`,
      ticksLastMin,
      median20,
      relActivity: Math.round(ticksLastMin / Math.max(median20, 1) * 100) / 100,
      movePct1m: movePct1m == null ? null : Math.round(movePct1m * 10000) / 10000,
      lastTickAt: new Date(lastTickMinute * 60_000).toISOString(),
    })
  }
  return { at: new Date(now).toISOString(), minute: cur, symbols: out }
}

/** Persist the snapshot for the read route (one small JSON; the ring itself stays in memory). */
export function flushActivity(db, setState, { now = Date.now(), symbolNames = {} } = {}) {
  const snap = activitySnapshot({ now, symbolNames })
  try { setState(db, ACTIVITY_STATE_KEY, JSON.stringify(snap)) } catch { /* diagnostics never block the stream */ }
  return snap
}

/**
 * The readout: ranked by relative activity, then by |move|; `top` bounds it.
 * `isOpen` (symbol → {open}) marks closed markets, which never rank high
 * because they have no ticks — reported, not inferred.
 */
export function activityReadout(raw, { top = 50, isOpen = null } = {}) {
  let snap = null
  try { snap = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { snap = null }
  if (!snap || !Array.isArray(snap.symbols)) return { at: null, unavailable: true, symbols: [] }
  const n = Math.max(1, Math.min(500, Math.floor(Number(top)) || 50))
  const rows = snap.symbols.map(s => {
    let open = null
    if (isOpen) { try { open = !!isOpen(s.symbol)?.open } catch { open = null } }
    return { ...s, open }
  })
  const byActivity = [...rows].sort((a, b) => (b.relActivity - a.relActivity) || (b.ticksLastMin - a.ticksLastMin)).slice(0, n)
  const byMove = [...rows].filter(r => r.movePct1m != null).sort((a, b) => Math.abs(b.movePct1m) - Math.abs(a.movePct1m)).slice(0, n)
  return { at: snap.at, minute: snap.minute, tracked: rows.length, byActivity, byMove }
}

/** Test seam only. */
export function __resetActivity() { BY_SYMBOL.clear() }
