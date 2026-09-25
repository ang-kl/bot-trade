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
//
// STATUS CLASSES (V3 M1, 25-09-2026). This recorded no status codes, so a 503
// was timed like any other answer and the startup window's report failures
// were invisible here. Every response is now classed 2xx/3xx/4xx/5xx, plus
// 'aborted' for a request whose client went away before an answer finished,
// with the last 5xx kept per route.
// ---------------------------------------------------------------------------

/** Samples retained per route. A ring — the newest overwrite the oldest. */
export const SAMPLES_PER_ROUTE = 200

/**
 * Distinct routes tracked. Past this, new routes are counted in an `other`
 * bucket rather than silently dropped: a route that appeared after the cap
 * would otherwise be invisible in exactly the incident it caused.
 *
 * 120 → 256 (V3 M1, 25-09-2026) — and only after finding what filled 120.
 * Production sat at the cap with 90 overflow requests. The middleware runs
 * before express.static and the SPA fallback and keyed by the raw path, so
 * the cap was spent on paths nothing bounded: every hashed chunk under
 * /assets (31 in one build, a new set per deploy, plus the previous build's
 * names still requested by open tabs), /fonts, every SPA page and every probe
 * a scanner sends, and the parameterised API routes whose ids are short or not
 * numeric (/state/scans/:symbol, /state/position/:id below 4 digits,
 * /state/analysis/:id, /state/backtest-reports/:name). requestRouteKey now
 * keys a matched API route by its PATTERN (bounded by the code's own route
 * table) and every unmatched request by a fixed bucket, so the key set is
 * bounded by construction; the larger cap is headroom, not the fix.
 */
export const MAX_ROUTES = 256

const store = new Map()   // key -> { n, bytes, ring: Float64Array, i, worst, status, last5xx }
let overflow = 0          // requests to routes beyond MAX_ROUTES

/** Status class of a response: '2xx' … '5xx', 'aborted' (no response finished), 'other'. Pure. */
export function statusClass(status) {
  if (status === 'aborted') return 'aborted'
  const s = Number(status)
  if (s >= 600 || !(s >= 200)) return 'other'
  if (s >= 500) return '5xx'
  if (s >= 400) return '4xx'
  if (s >= 300) return '3xx'
  return '2xx'
}
const freshStatus = () => ({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, aborted: 0, other: 0 })

// Top-level segments an UNMATCHED request keeps in its bucket name. Anything
// else — an SPA page, a favicon, a scanner's /wp-login.php — is '/*'.
const KNOWN_TOP = new Set(['state', 'actions', 'assets', 'fonts', 'api', 'auth', 'board'])

/** Normalise a request path to a stable key. */
export function routeKey(path) {
  const p = String(path || '/').split('?')[0]
  // Numeric ids in the path are the other way this map could grow without
  // bound — /positions/234848341 is a different path per position.
  return p.replace(/\/\d{4,}/g, '/:id').slice(0, 120)
}

/** The bucket for a request no string route pattern answered. Pure. */
export function unmatchedKey(fullPath) {
  const seg = String(fullPath || '/').split('?')[0].split('/')[1] || ''
  if (!seg) return '/'
  return KNOWN_TOP.has(seg) ? `/${seg}/*` : '/*'
}

/**
 * The key for one request, read at 'finish' (V3 M1). By then a mounted router
 * has stripped its prefix from req.path — /state/X and /actions/X both read
 * '/X', which is how the two mounts collided — and left it in req.baseUrl. A
 * request a route answered is keyed by baseUrl + the route's PATTERN
 * ('/state' + '/scans/:symbol'), never the raw path, so user input cannot mint
 * keys. Anything else — a static file, the SPA fallback (a RegExp route that
 * calls next() for API paths), a 401 from the auth middleware before routing,
 * a 404 — lands in one of unmatchedKey's fixed buckets.
 */
export function requestRouteKey(req) {
  const base = String(req?.baseUrl || '')
  const pattern = req?.route?.path
  if (typeof pattern === 'string') return routeKey(base + pattern)
  return unmatchedKey(base + String(req?.path || '/'))
}

/**
 * Record one completed request. Never throws — instrumentation is not a gate.
 * `status` is the response status code, or 'aborted' when the client went
 * away before a response finished; omitted, the request is timed but not
 * classed.
 */
export function recordRequest(path, ms, bytes = 0, status = null) {
  try {
    const key = routeKey(path)
    let e = store.get(key)
    if (!e) {
      if (store.size >= MAX_ROUTES) { overflow++; return }
      e = { n: 0, bytes: 0, ring: new Float64Array(SAMPLES_PER_ROUTE), i: 0, worst: null, status: freshStatus(), last5xx: null }
      store.set(key, e)
    }
    e.n++
    e.bytes += Number(bytes) || 0
    e.ring[e.i % SAMPLES_PER_ROUTE] = Number(ms) || 0
    e.i++
    if (!e.worst || ms > e.worst.ms) e.worst = { ms: Number(ms) || 0, at: new Date().toISOString(), bytes: Number(bytes) || 0 }
    if (status != null) {
      const cls = statusClass(status)
      e.status[cls]++
      if (cls === '5xx') e.last5xx = { at: new Date().toISOString(), status: Number(status), ms: Number(ms) || 0 }
    }
  } catch { /* a broken counter must never break a response */ }
}

/**
 * The Express middleware (V3 M1): times EVERY request — /health and
 * /actions/* included — and records its status class under requestRouteKey.
 * Mounted before the auth middleware so a 401 is counted too. `log` receives
 * the `[http]` journal line for every request except /health, which the
 * healthcheck polls; `onStatus(key, status, atMs)` feeds the startup-window
 * counts in runtime-record.js. Both are optional and neither may throw into
 * the response path.
 */
export function routeTimingMiddleware({ log = null, onStatus = null } = {}) {
  return (req, res, next) => {
    const t0 = Date.now()
    const path = req.path
    const method = req.method
    let done = false
    const settle = (status) => {
      if (done) return
      done = true
      try {
        const ms = Date.now() - t0
        const key = requestRouteKey(req)
        if (log && path !== '/health') log(`[http] ${method} ${path} → ${status} (${ms}ms)`)
        recordRequest(key, ms, Number(res.getHeader('content-length')) || 0, status)
        if (onStatus) onStatus(key, status, Date.now())
      } catch { /* a broken counter must never break a response */ }
    }
    res.once('finish', () => settle(res.statusCode))
    // 'close' without 'finish': the client went away first. Counted as
    // 'aborted' rather than lost — a request that never got an answer is the
    // shape a startup stall leaves in a browser.
    res.once('close', () => settle('aborted'))
    next()
  }
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
      // V3 M1: every response classed, and the last 5xx with its time.
      status: { ...e.status },
      last5xx: e.last5xx,
    })
  }
  rows.sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0))
  const statusTotals = freshStatus()
  for (const e of store.values()) for (const k of Object.keys(statusTotals)) statusTotals[k] += e.status[k]
  return {
    routes: rows,
    statusTotals,
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
