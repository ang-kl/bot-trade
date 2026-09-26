// ---------------------------------------------------------------------------
// agent/lib/fast-monitor-probes.js — M7 (P1/P4-4, V3-SEQUENCE:536-543;
// queue item 33; owner OD-22, 26-09-2026: "parallel probes under a cap, with
// backoff ≤ 5 min").
//
// PROBLEM MEASURED (fast-monitor.js header, fast-monitor-sidecar-quotes.js):
// the fast monitor prices most open positions from the sidecar's one-pull-
// per-side quote table, and falls back to a broker round trip
// (wsGetSpotOnce) only for a symbol the sidecar does not carry or whose
// quote is stale. That fallback used to run ONE AT A TIME, awaited inline in
// the per-position loop — 48 serial round trips in one measured pass, worst
// tick 51 s, skipShare10m 0.45-0.75 against the goal table's <= 10% (M7's
// own post-deploy prediction, V3-SEQUENCE:543).
//
// THIS MODULE holds the two mechanisms the spec calls for, kept separate
// from fast-monitor.js's own wiring so each is testable on its own:
//
//   CAP     — bounds how many broker probes may be IN FLIGHT at once, so a
//             batch of quiet symbols runs concurrently instead of stacking
//             behind each other's 6 s broker timeout.
//   BACKOFF — bounds how OFTEN the same symbol is re-probed. It arms ONLY
//             while the rest of its side still has a fresh sidecar quote for
//             some OTHER symbol — i.e. only when THIS symbol is the quiet
//             one, never when the whole feed has gone stale (a feed outage
//             must keep retrying every tick, not back off).
//
// OPEN, NOT ANSWERED HERE (OD-22's second half): the staleness RULE for a
// symbol that stays quiet in an OPEN market — whether its last (old) sidecar
// or broker quote should ever be treated as current, and for how long — is
// an owner decision (0066.HK, `fast-monitor.js:48-49,64-68`'s 10 s recvMs
// rule). This module does not invent one: backoff below only throttles how
// often THIS PROCESS re-asks the broker; it never decides that a stale quote
// is good enough to trade on. Callers that reuse a cached/backed-off result
// still apply their own "no quote" handling exactly as before.
// ---------------------------------------------------------------------------

/** Default concurrent-probe ceiling — comfortably above one side's usual open-position count; env-overridable per OD-22's cap. */
export const PROBE_CAP_DEFAULT = 8
/** Fix round (26-09-2026, B3): a cap of 0 disables probing silently and an unbounded one opens as many authed broker sockets as there are due positions — both are refused. */
export const PROBE_CAP_MAX = 32

/** OD-22: the backoff must never exceed 5 minutes, however it is configured. */
export const PROBE_BACKOFF_MAX_MS = 5 * 60_000
export const PROBE_BACKOFF_DEFAULT_MS = 60_000

/**
 * Validate a cap value: floor it FIRST (so 0.5 is 0, not a valid 1), THEN
 * require it be at least 1, THEN clamp it to PROBE_CAP_MAX. A non-finite,
 * sub-1 or missing value falls back to PROBE_CAP_DEFAULT rather than being
 * silently coerced into something that disables or unbounds probing.
 */
export function clampCap(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return PROBE_CAP_DEFAULT
  const floored = Math.floor(num)
  if (floored < 1) return PROBE_CAP_DEFAULT
  return Math.min(floored, PROBE_CAP_MAX)
}

export function probeCap(env = process.env) {
  return clampCap(env?.FAST_MONITOR_PROBE_CAP)
}

/** Always <= PROBE_BACKOFF_MAX_MS, whatever the env says (OD-22's ceiling is not configurable away). */
export function probeBackoffMs(env = process.env) {
  const n = Number(env?.FAST_MONITOR_PROBE_BACKOFF_MS)
  if (!(Number.isFinite(n) && n > 0)) return PROBE_BACKOFF_DEFAULT_MS
  return Math.min(n, PROBE_BACKOFF_MAX_MS)
}

/**
 * Pure: does a symbol's backoff arm right now? Never arms for a symbol that
 * has not been probed yet, and never arms while the rest of its side is NOT
 * fresh (a quiet feed must keep retrying — only a quiet SYMBOL backs off).
 */
export function shouldBackoff({ lastProbeAtMs = null, nowMs, backoffMs, sideHasFreshQuote = false } = {}) {
  if (!sideHasFreshQuote) return false
  if (lastProbeAtMs == null) return false
  const n = Number(nowMs), l = Number(lastProbeAtMs), b = Number(backoffMs)
  if (!Number.isFinite(n) || !Number.isFinite(l) || !Number.isFinite(b) || b <= 0) return false
  return n - l < b
}

/**
 * Pure: of `candidates` (probe keys already filtered to ones NOT in flight,
 * cached-fresh or backed off), which may launch right now under `cap` given
 * `inflightCount` already running. Order is preserved; the remainder is
 * deferred (picked up on a later pass once room frees up).
 */
export function selectUnderCap(candidates, inflightCount, cap) {
  const room = Math.max(0, Math.floor(cap) - Math.floor(inflightCount))
  const list = Array.isArray(candidates) ? candidates : []
  return { launch: list.slice(0, room), deferred: list.slice(room) }
}

/**
 * Pure: does the given side have a FRESH quote for some symbol OTHER than
 * `excludeSymbolId`? This is the "other symbols on the same side are fresh"
 * condition backoff requires (V3-SEQUENCE:539) — a quote for the probed
 * symbol itself never counts, stale or otherwise.
 */
export function sideHasFreshQuoteExcluding(quotesMap, excludeSymbolId, nowMs, maxAgeMs) {
  if (!quotesMap || typeof quotesMap.entries !== 'function') return false
  const ex = excludeSymbolId == null ? null : Number(excludeSymbolId)
  for (const [id, q] of quotesMap.entries()) {
    if (ex != null && Number(id) === ex) continue
    if (!q) continue
    const age = Number.isFinite(q.ageMs) ? q.ageMs : (Number.isFinite(q.recvMs) ? Number(nowMs) - q.recvMs : Infinity)
    if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) return true
  }
  return false
}

/**
 * A bounded-concurrency, backing-off probe scheduler. One instance is meant
 * to live for the process (fast-monitor.js keeps a module-level one), so the
 * cap and backoff apply ACROSS ticks, not just within one.
 *
 * `nowMs` is passed IN to `plan`/`run` on every call rather than read from a
 * clock this object owns: fast-monitor.js's own clock is injectable (a
 * fixed clock in tests, `Date.now` in production), and the scheduler must
 * judge backoff against THAT SAME clock — a scheduler with its own
 * `Date.now()` would arm backoff against real wall-clock gaps between test
 * cases (milliseconds) while the caller's simulated clock believes hours
 * have passed, backing off probes the test never meant to suppress.
 */
export class ProbeScheduler {
  constructor({ cap = PROBE_CAP_DEFAULT, backoffMs = PROBE_BACKOFF_DEFAULT_MS } = {}) {
    // B3 (fix round, 26-09-2026): the constructor validates its OWN cap
    // rather than trusting the caller to have — a cap of 0 or unbounded
    // must never reach `this.cap` by any path, including a direct
    // reconfigure (fast-monitor.js's `_setFastMonitorProbeCapForTests`
    // goes through this same `clampCap`, not a bare assignment).
    this.cap = clampCap(cap)
    this.backoffMs = Math.min(backoffMs, PROBE_BACKOFF_MAX_MS)
    this.inflight = new Set()
    this.lastProbeAt = new Map()
    this.results = new Map() // key -> { quote, at, error }
  }

  inflightCount() { return this.inflight.size }

  /** The last completed probe's result for `key`, or null if none yet. */
  lastResult(key) { return this.results.get(key) ?? null }

  /**
   * Decide what a probe for `key` should do THIS pass, without running
   * anything: 'pending' (already in flight — do not relaunch), 'backoff'
   * (its LAST probe returned no quote, and other symbols on this side are
   * fresh — never used to reuse a quote, only to skip re-probing) or
   * 'eligible' (may launch, subject to the cap). `nowMs` is the CALLER's
   * clock (see the class note above).
   *
   * B1 (fix round, 26-09-2026): backoff arms ONLY when the previous probe
   * for this key returned NO quote. A key whose last probe actually priced
   * it is never backed off — there is nothing stale to protect against
   * re-probing, and the caller must not be tempted to reuse that quote on
   * a later pass. `lastResult(key)` — not `shouldBackoff` alone — is what
   * makes that true: a key with a successful last probe always evaluates
   * to 'eligible' here regardless of elapsed time or side freshness.
   */
  plan(key, { sideHasFreshQuote = false, nowMs } = {}) {
    if (this.inflight.has(key)) return 'pending'
    const last = this.results.get(key)
    const lastProbeHadNoQuote = last ? last.quote == null : false
    if (lastProbeHadNoQuote && shouldBackoff({ lastProbeAtMs: this.lastProbeAt.get(key) ?? null, nowMs, backoffMs: this.backoffMs, sideHasFreshQuote })) {
      return 'backoff'
    }
    return 'eligible'
  }

  /**
   * Order `keys` fairly for the cap (B2, fix round 26-09-2026): symbols
   * never probed at all come first (in the order given — first noticed
   * this pass, not alphabetical), then symbols probed before, oldest
   * `lastProbeAt` first. Without this, `selectUnderCap` — which is itself
   * order-preserving — would relaunch the same head-of-list `cap` keys
   * every pass while the rest starve indefinitely on a persistently
   * over-subscribed side.
   */
  sortFair(keys) {
    const list = Array.isArray(keys) ? keys : []
    const never = []
    const probed = []
    for (const k of list) (this.lastProbeAt.has(k) ? probed : never).push(k)
    probed.sort((a, b) => this.lastProbeAt.get(a) - this.lastProbeAt.get(b))
    return [...never, ...probed]
  }

  /**
   * Launch `runProbe(key)` now, marking `key` in flight for the duration.
   * Never rejects: a failed probe is recorded as a null result, same as one
   * that is merely quiet, so cap and backoff bookkeeping is uniform.
   * `nowMs` is the CALLER's clock, stamped on both the attempt and the
   * result (see the class note above).
   */
  async run(key, runProbe, nowMs) {
    this.inflight.add(key)
    this.lastProbeAt.set(key, nowMs)
    try {
      const quote = await runProbe(key)
      this.results.set(key, { quote: quote ?? null, at: nowMs, error: null })
      return quote ?? null
    } catch (err) {
      this.results.set(key, { quote: null, at: nowMs, error: err })
      return null
    } finally {
      this.inflight.delete(key)
    }
  }

  /** Test seam / process restart: drop all state. */
  reset() {
    this.inflight.clear()
    this.lastProbeAt.clear()
    this.results.clear()
  }
}
