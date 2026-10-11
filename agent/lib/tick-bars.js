// ---------------------------------------------------------------------------
// agent/lib/tick-bars.js — bars built from the recorded quote stream, in two
// forms: TIME bars (a fixed clock interval, the shape cTrader's trendbars
// have) and N-TICK bars (a fixed count of quote changes, an activity clock).
//
// Claude · № 13,095 11-Oct (ordered № 13,093; claude-builder). Plan step 6
// (¶A·2): the owner asked for both forms, compared. The scanner's one-minute
// floor is OUR rule (scanner.cpp, scanner-feed.js), mirroring cTrader's
// smallest trendbar; cTrader's API delivers millisecond quotes with no
// volume, so volume is DEFINED here, not received:
//   · time bars: v = the number of quote CHANGES in the bar — the same unit
//     as ProtoOATrendbar.volume ("bar volume in ticks"), so a strategy that
//     reads volume as a ratio to its own average (Donchian's 1.2× rule)
//     works unchanged. vSemantics 'changed_quotes'.
//   · N-tick bars: every bar holds N changes, so a count is constant and
//     meaningless; v = bar speed in ticks per second. vSemantics
//     'bar_speed_ticks_per_s'. A strategy reading it as cTrader volume is
//     reading a different quantity, and the label says so.
//
// PURE. Input is the normalised quote list tick-research-run.js builds from
// a segment ({ seq, recvMs, bid, ask, snapshot, crossed, changed } in wire
// units, gap markers as { gapMarker: true } or the crossed sentinel it
// rewrites them to). Output bars are { t, o, h, l, c, v } objects plus the
// labels, ascending, CLOSED only (runBacktest's contract); the trailing
// unclosed bar is returned apart. A bar touched by a gap, or holding a
// silence longer than maxSilenceMs, is INVALID: kept in `invalid` with its
// reason and never in `bars`, and `segments` splits the valid bars at every
// invalid one so a consumer never reads across a hole as if it were time.
//
// Prices are bid by default, as cTrader trendbars are bid; 'mid' is offered
// for the comparison. Research only: no gate, order path or management
// module reads this (agent/research-isolation.test.js).
// ---------------------------------------------------------------------------

/** spot_feed.cpp kPointsPerPrice: wire units per price unit (tick-cost-schedule.js). */
export const POINTS_PER_PRICE = 100_000
export const V_SEMANTICS = Object.freeze({ TIME: 'changed_quotes', TICK: 'bar_speed_ticks_per_s' })
export const INVALID = Object.freeze({ GAP: 'gap', SILENCE: 'silence', PARTIAL: 'partial_first_bucket' })

const fin = v => typeof v === 'number' && Number.isFinite(v)

/**
 * Does this quote count as a tick? A two-sided, non-snapshot, non-crossed
 * quote that CHANGED a side. Repeats (changed:false), snapshots, crossed
 * quotes, one-sided quotes and gap markers do not count — and are tallied
 * in `dropped` so nothing disappears silently.
 */
export function countsAsTick(q) {
  if (!q || q.gapMarker) return false
  if (!fin(q.bid) || !fin(q.ask) || q.bid <= 0 || q.ask <= 0) return false
  if (q.snapshot || q.crossed || q.bid > q.ask) return false
  return q.changed !== false
}
const isGap = q => !!q && (q.gapMarker === true || (q.crossed === true && q.bid === 1 && q.ask === 0 && q.recvMs === 0))
const dropReason = q => (isGap(q) ? 'gap' : !fin(q?.bid) || !fin(q?.ask) || q.bid <= 0 || q.ask <= 0 ? 'one_sided' : q.snapshot ? 'snapshot' : q.crossed || q.bid > q.ask ? 'crossed' : 'repeat')

function priceOf(q, price, scale) {
  return (price === 'mid' ? (q.bid + q.ask) / 2 : q.bid) / scale
}

function finaliseSeries(all) {
  // Valid closed bars, the invalid ones apart, and the valid runs split at
  // every invalid bar.
  const bars = [], invalid = [], segments = []
  let run = []
  for (const b of all) {
    if (b.invalid) { invalid.push({ t: b.t, reason: b.invalid, n: b.n }); if (run.length) { segments.push(run); run = [] }; continue }
    bars.push(b); run.push(b)
  }
  if (run.length) segments.push(run)
  return { bars, invalid, segments }
}

/**
 * TIME bars of `barMs` from the quote list. `t` is the bucket start (epoch
 * ms, like the stored replay windows). Empty buckets produce NO bar (cTrader
 * emits none either); the first bucket is always invalid (partial: what came
 * before its first tick is unknown); the last, unclosed bucket is
 * returned as `open`, never as a bar.
 */
export function timeBars(quotes, { barMs, price = 'bid', maxSilenceMs = null, scale = POINTS_PER_PRICE, label = null } = {}) {
  if (!Number.isInteger(barMs) || barMs <= 0) throw new RangeError('barMs must be a positive integer')
  const form = label ?? `time_${barMs}ms`
  const dropped = { gap: 0, one_sided: 0, snapshot: 0, crossed: 0, repeat: 0 }
  const all = []
  let cur = null, lastTickMs = null, gapPending = false, firstSeen = true
  const close = () => { if (cur) { all.push(cur); cur = null } }
  for (const q of Array.isArray(quotes) ? quotes : []) {
    if (!countsAsTick(q)) {
      dropped[dropReason(q)]++
      // A hole seen while a bar is open: the recorder cannot say whether
      // the dropped quotes fell inside this bucket or the next, so BOTH the
      // open bar and the bar that follows are invalid (the plan's rule: any
      // bar that overlaps a gap is invalid; when in doubt, both do).
      if (isGap(q)) { if (cur) cur.invalid = cur.invalid || INVALID.GAP; gapPending = true; lastTickMs = null }
      continue
    }
    const t0 = Math.floor(q.recvMs / barMs) * barMs
    const p = priceOf(q, price, scale)
    if (cur && t0 !== cur.t) { close() }
    if (!cur) {
      cur = { t: t0, o: p, h: p, l: p, c: p, v: 0, n: 0, form, barMs, vSemantics: V_SEMANTICS.TIME, invalid: null }
      if (gapPending) { cur.invalid = INVALID.GAP; gapPending = false }
      // The first bucket of a stream is partial by definition: nothing says
      // whether quotes before its first tick were absent or unrecorded.
      if (firstSeen) { cur.invalid = cur.invalid || INVALID.PARTIAL; firstSeen = false }
      // A silence longer than the bound BETWEEN this tick and the last one
      // (even across bucket boundaries) breaks continuity: the bar that
      // follows the silence is not a bar of a live market.
      if (maxSilenceMs != null && lastTickMs != null && q.recvMs - lastTickMs > maxSilenceMs) cur.invalid = cur.invalid || INVALID.SILENCE
    } else if (maxSilenceMs != null && lastTickMs != null && q.recvMs - lastTickMs > maxSilenceMs) {
      cur.invalid = cur.invalid || INVALID.SILENCE
    }
    if (p > cur.h) cur.h = p
    if (p < cur.l) cur.l = p
    cur.c = p; cur.v++; cur.n++
    lastTickMs = q.recvMs
  }
  const open = cur
  const out = finaliseSeries(all)
  return { form, barMs, price, vSemantics: V_SEMANTICS.TIME, ...out, open, dropped }
}

/**
 * N-TICK bars: every `n` counted ticks close a bar. `t` is the first tick's
 * receive time; `durMs` the span; `v` = speed in ticks per second (null when
 * the span is zero). A gap inside a bar invalidates it and starts a new one
 * after the gap. `nominalMs` is the time-bar size this count was chosen to
 * approximate (see nominalTickCount) and goes on the label only.
 */
export function tickBars(quotes, { n, price = 'bid', maxSilenceMs = null, scale = POINTS_PER_PRICE, nominalMs = null, label = null } = {}) {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer')
  const form = label ?? (nominalMs ? `tick_${n}_approx_${nominalMs}ms` : `tick_${n}`)
  const dropped = { gap: 0, one_sided: 0, snapshot: 0, crossed: 0, repeat: 0 }
  const all = []
  let cur = null, lastTickMs = null
  const finish = (b, lastMs) => {
    b.durMs = lastMs - b.t
    b.speed = b.durMs > 0 ? Math.round((b.n / (b.durMs / 1000)) * 1000) / 1000 : null
    b.v = b.speed
    all.push(b)
  }
  for (const q of Array.isArray(quotes) ? quotes : []) {
    if (!countsAsTick(q)) {
      dropped[dropReason(q)]++
      if (isGap(q)) {
        // The bar in progress straddles a hole: invalid, closed where it stands.
        if (cur) { cur.invalid = INVALID.GAP; finish(cur, lastTickMs ?? cur.t); cur = null }
        lastTickMs = null
      }
      continue
    }
    const p = priceOf(q, price, scale)
    if (cur && maxSilenceMs != null && lastTickMs != null && q.recvMs - lastTickMs > maxSilenceMs) {
      cur.invalid = cur.invalid || INVALID.SILENCE
    }
    if (!cur) {
      cur = { t: q.recvMs, o: p, h: p, l: p, c: p, v: null, n: 0, form, nTicks: n, nominalMs, vSemantics: V_SEMANTICS.TICK, invalid: null, durMs: null, speed: null }
      if (maxSilenceMs != null && lastTickMs != null && q.recvMs - lastTickMs > maxSilenceMs) cur.invalid = INVALID.SILENCE
    }
    if (p > cur.h) cur.h = p
    if (p < cur.l) cur.l = p
    cur.c = p; cur.n++
    lastTickMs = q.recvMs
    if (cur.n >= n) { finish(cur, q.recvMs); cur = null }
  }
  const open = cur
  const out = finaliseSeries(all)
  return { form, nTicks: n, nominalMs, price, vSemantics: V_SEMANTICS.TICK, ...out, open, dropped }
}

/**
 * The tick count that makes an N-tick bar "about" `nominalMs` long on THIS
 * stream: the median count of ticks per complete nominalMs bucket. Partial
 * first/last buckets and gap-touched buckets are left out. Returns null when
 * no complete bucket holds a tick, so a caller cannot build tick≈1m bars on
 * a stream that never had a minute of quotes.
 */
export function nominalTickCount(quotes, { nominalMs } = {}) {
  if (!Number.isInteger(nominalMs) || nominalMs <= 0) throw new RangeError('nominalMs must be a positive integer')
  const tb = timeBars(quotes, { barMs: nominalMs })
  const counts = tb.bars.map(b => b.n).filter(c => c > 0).sort((a, b) => a - b)
  if (!counts.length) return { n: null, buckets: 0, medianTicks: null, nominalMs }
  const m = Math.floor(counts.length / 2)
  const median = counts.length % 2 ? counts[m] : Math.round((counts[m - 1] + counts[m]) / 2)
  return { n: Math.max(1, Math.round(median)), buckets: counts.length, medianTicks: median, nominalMs, minTicks: counts[0], maxTicks: counts[counts.length - 1] }
}

/**
 * A strategy's design floor: a bar form shorter than the timeframe the
 * strategy was designed on is refused BY DESIGN, not by data. `floorMs` is
 * the caller's reading of the registry (step 8 passes it); this module holds
 * no strategy table of its own.
 */
export function refusedByDesignFloor(barMs, floorMs) {
  if (!fin(floorMs) || floorMs <= 0) return null
  return fin(barMs) && barMs < floorMs ? { refused: true, reason: `refused by design floor: ${barMs}ms bar under the strategy's ${floorMs}ms floor` } : { refused: false, reason: null }
}
