// ---------------------------------------------------------------------------
// agent/services/route-timing.js — per-route latency and payload size, kept in
// memory so the NEXT slow episode is measured rather than reconstructed.
//
// WHY (#125, "find where the 8-29s actually goes"): I went looking for it on
// 2026-08-04 and it was not there. 48 samples across four routes on
// production:
//
//   /state/veto-breakdown            p50 0.508  p90 0.648  max 1.239
//   /state/trades?account=all        p50 0.344  p90 0.470  max 0.639
//   /state/positions?account=all     p50 0.401  p90 0.513  max 1.077
//   /health                          p50 0.281  p90 0.295  max 0.452
//
// A full sweep of all fourteen read routes came back between 0.26s and 0.73s.
// So the honest answer to "where does it go" is: nowhere today. Which is
// exactly the problem — the report was real when it was made, the conditions
// have changed, and nothing was recording at the time. A one-off measurement
// cannot catch an intermittent stall; a resident histogram can.
//
// WHY THE `[http]` LOG LINE ALREADY THERE IS NOT ENOUGH. index.js:337 prints
// every request with its duration. That is a stream, not a memory: reading it
// means having the Railway log window open at the moment it happens, and the
// retention will not cover an episode noticed a day later. This keeps the
// SHAPE — count, p50, p90, max, worst example — so the question can be asked
// after the fact.
//
// BOUNDED BY CONSTRUCTION. A latency recorder that grows without limit is the
// same class of bug as the unbounded Maps in #123, and it would be a poor
// joke to introduce one here. Routes are keyed by PATH ONLY, never by query
// string — `?account=<id>&limit=<n>` would mint a fresh key per distinct
// query and turn this into an unbounded map keyed by user input. Samples per
// route are a fixed-size ring. Both caps are asserted by tests.
// ---------------------------------------------------------------------------

/** Samples retained per route. A ring — the newest overwrite the oldest. */
export const SAMPLES_PER_ROUTE = 200

/**
 * Distinct routes tracked. Past this, new routes are counted in an `other`
 * bucket rather than silently dropped: a route that appeared after the cap
 * would otherwise be invisible in exactly the incident it caused.
 */
export const MAX_ROUTES = 120

const store = new Map()   // path -> { n, bytes, ring: Float64Array, i, worst }
let overflow = 0          // requests to routes beyond MAX_ROUTES

/** Normalise a request path to a stable key. */
export function routeKey(path) {
  const p = String(path || '/').split('?')[0]
  // Numeric ids in the path are the other way this map could grow without
  // bound — /positions/234848341 is a different path per position.
  return p.replace(/\/\d{4,}/g, '/:id').slice(0, 120)
}

/** Record one completed request. Never throws — instrumentation is not a gate. */
export function recordRequest(path, ms, bytes = 0) {
  try {
    const key = routeKey(path)
    let e = store.get(key)
    if (!e) {
      if (store.size >= MAX_ROUTES) { overflow++; return }
      e = { n: 0, bytes: 0, ring: new Float64Array(SAMPLES_PER_ROUTE), i: 0, worst: null }
      store.set(key, e)
    }
    e.n++
    e.bytes += Number(bytes) || 0
    e.ring[e.i % SAMPLES_PER_ROUTE] = Number(ms) || 0
    e.i++
    if (!e.worst || ms > e.worst.ms) e.worst = { ms: Number(ms) || 0, at: new Date().toISOString(), bytes: Number(bytes) || 0 }
  } catch { /* a broken counter must never break a response */ }
}

function pct(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[i]
}

/**
 * The histogram, worst-first.
 *
 * `avgBytes` is here beside the timings on purpose. The 2026-08-04 sweep found
 * nothing slow but did find /state/veto-breakdown returning 507 KB per call —
 * a cost a latency-only view would have missed entirely, because half a
 * megabyte over a fast link still looks fast from the server's side.
 */
export function routeTimings({ minSamples = 1 } = {}) {
  const rows = []
  for (const [route, e] of store) {
    const taken = Math.min(e.i, SAMPLES_PER_ROUTE)
    if (taken < minSamples) continue
    const s = Array.from(e.ring.slice(0, taken)).sort((a, b) => a - b)
    rows.push({
      route,
      requests: e.n,
      sampled: taken,
      p50: pct(s, 0.5),
      p90: pct(s, 0.9),
      p99: pct(s, 0.99),
      max: s[s.length - 1] ?? null,
      avgBytes: e.n > 0 ? Math.round(e.bytes / e.n) : 0,
      worst: e.worst,
    })
  }
  rows.sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0))
  return {
    routes: rows,
    tracked: store.size,
    maxRoutes: MAX_ROUTES,
    samplesPerRoute: SAMPLES_PER_ROUTE,
    // Named rather than hidden — a cap nobody can see is a lie about coverage.
    overflowRequests: overflow,
    note: overflow > 0
      ? `${overflow} request(s) hit routes beyond the ${MAX_ROUTES}-route cap and are counted here only`
      : null,
  }
}

/** Test seam. */
export function resetRouteTimings() { store.clear(); overflow = 0 }
