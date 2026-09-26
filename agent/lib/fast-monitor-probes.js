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
// FIX ROUND 3 (26-09-2026): an adversarial refute reproduced five blockers
// against the FIRST design here (batch-launch, `Promise.all`, then evaluate
// sequentially) — that design still let one position's `executeBrokerAction`
// age out ANOTHER position's already-fetched quote before it was evaluated
// (B1), among others. The spec (V3-SEQUENCE item 33) already said the
// answer: probes run "with results used on the next pass". This module now
// does that literally:
//
//   LAUNCH  — `launch()` is fire-and-forget. It never blocks the caller and
//             is never awaited by fast-monitor.js's own pass. A result lands
//             in `results` whenever the network call actually finishes,
//             independent of which pass (if any) is running at that moment.
//   PEEK    — `peek()` is how a LATER pass asks "do I have something fresh
//             enough to evaluate with, RIGHT NOW?" — re-checked at every
//             single position's own evaluation moment, never once for a
//             whole batch. This is what closes B1: a quote fetched 4s ago
//             was fresh when this pass started, but if evaluating an EARLIER
//             position this same pass took 6 more seconds (a broker amend),
//             the SAME quote is correctly judged stale for a LATER position,
//             because the age check runs again, right before that specific
//             evaluation, against the current clock.
//   CAP     — bounds how many probes may be IN FLIGHT at once, so a batch of
//             quiet symbols launches concurrently instead of stacking behind
//             each other's 6 s broker timeout.
//   BACKOFF — bounds how OFTEN the same symbol is re-probed. It arms ONLY
//             when the symbol's LAST probe actually SUCCEEDED (no throw, no
//             timeout, no socket error) and came back with no quote — a
//             genuinely quiet symbol — and only while the rest of its side
//             still has a fresh quote for some OTHER symbol. It never arms
//             for a symbol currently inside its spike window (fast-monitor's
//             `spikeActive`): a spike is exactly when re-pricing matters
//             most, and a single failed probe must not suspend it for up to
//             5 minutes.
//
// OPEN, NOT ANSWERED HERE (OD-22's second half): the staleness RULE for a
// symbol that stays quiet in an OPEN market — whether its last (old) sidecar
// or broker quote should ever be treated as current, and for how long — is
// an owner decision (0066.HK, `fast-monitor.js:48-49,64-68`'s 10 s recvMs
// rule). This module does not invent one: it never hands a caller a quote
// older than the maxAgeMs THAT CALLER supplies to `peek()` — fast-monitor.js
// supplies its own QUOTE_MAX_AGE (10 s), unchanged from before M7.
// ---------------------------------------------------------------------------

import { BoundedMap } from './bounded-map.js'

/** Default concurrent-probe ceiling — comfortably above one side's usual open-position count; env-overridable per OD-22's cap. */
export const PROBE_CAP_DEFAULT = 8
/** Fix round 2 (26-09-2026, B3): a cap of 0 disables probing silently and an unbounded one opens as many authed broker sockets as there are due positions — both are refused. */
export const PROBE_CAP_MAX = 32

/** OD-22: the backoff must never exceed 5 minutes, however it is configured. */
export const PROBE_BACKOFF_MAX_MS = 5 * 60_000
export const PROBE_BACKOFF_DEFAULT_MS = 60_000

/** Bound on how many distinct symbols' probe history this process remembers (fix round 3 nit) — an evicted key is simply never-probed again, same as a fresh process. */
export const PROBE_KEY_CAP = 2_000

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
 * This is the TIMING half only; `ProbeScheduler.plan` additionally requires
 * the last probe to have SUCCEEDED with no quote (fix round 3, B2) and never
 * consults this at all while the position is inside its spike window.
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
 * Pure: does the given side have a FRESH, VALID quote for some symbol OTHER
 * than `excludeSymbolId`? This is the "other symbols on the same side are
 * fresh" condition backoff requires (V3-SEQUENCE:539) — a quote for the
 * probed symbol itself never counts, stale or otherwise. Fix round 3 nit:
 * a row with an age inside the window but an invalid price (missing side,
 * non-positive bid, or a crossed/equal-but-backwards book) does not count
 * as "fresh" either — freshness describes a PRICE, not a timestamp alone.
 */
export function sideHasFreshQuoteExcluding(quotesMap, excludeSymbolId, nowMs, maxAgeMs) {
  if (!quotesMap || typeof quotesMap.entries !== 'function') return false
  const ex = excludeSymbolId == null ? null : Number(excludeSymbolId)
  for (const [id, q] of quotesMap.entries()) {
    if (ex != null && Number(id) === ex) continue
    if (!q) continue
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || !(q.bid > 0) || q.ask < q.bid) continue
    const age = Number.isFinite(q.ageMs) ? q.ageMs : (Number.isFinite(q.recvMs) ? Number(nowMs) - q.recvMs : Infinity)
    if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) return true
  }
  return false
}

/**
 * A bounded-concurrency, backing-off probe scheduler that never blocks its
 * caller. One instance is meant to live for the process (fast-monitor.js
 * keeps a module-level one), so the cap and backoff apply ACROSS ticks.
 *
 * `nowFn` is passed IN to `plan`/`peek`/`launch` on every call — a live
 * function, not a snapshot value — rather than read from a clock this
 * object owns: fast-monitor.js's own clock is injectable (fixed in tests,
 * `Date.now` in production), and both backoff timing AND a launched probe's
 * OWN completion stamp must use that SAME clock. A scheduler with its own
 * `Date.now()` would judge freshness against real wall-clock gaps between
 * test cases (milliseconds) while the caller's simulated clock believes
 * hours have passed.
 */
export class ProbeScheduler {
  constructor({ cap = PROBE_CAP_DEFAULT, backoffMs = PROBE_BACKOFF_DEFAULT_MS } = {}) {
    // Fix round 2 (B3): the constructor validates its OWN cap rather than
    // trusting the caller to have — a cap of 0 or unbounded must never
    // reach `this.cap` by any path, including a direct reconfigure
    // (fast-monitor.js's `_setFastMonitorProbeCapForTests` goes through
    // this same `clampCap`, not a bare assignment).
    this.cap = clampCap(cap)
    this.backoffMs = Math.min(backoffMs, PROBE_BACKOFF_MAX_MS)
    this.inflight = new Set()
    // Fix round 3 nit: bounded, so a process that has ever probed more than
    // PROBE_KEY_CAP distinct symbols does not grow these without limit. An
    // evicted key is simply treated as never-probed on its next sighting —
    // the same as it would be on a fresh restart.
    this.lastProbeAt = new BoundedMap(PROBE_KEY_CAP, { lru: true, name: 'probe.lastProbeAt' })
    this.results = new BoundedMap(PROBE_KEY_CAP, { lru: true, name: 'probe.results' }) // key -> { quote, error, fetchedAtMs, durationMs }
    this._inflightPromises = new Map() // key -> promise, test seam only (see _drainForTests)
  }

  inflightCount() { return this.inflight.size }

  /**
   * What THIS CALL knows about `key`, judged against `nowMs` (the caller's
   * OWN clock, at the exact moment of THIS evaluation — never cached from
   * earlier in the pass; this is what closes B1):
   *   'quote'    — a fresh (age <= maxAgeMs), priced result. Safe to
   *                evaluate with. `durationMs` is that probe's OWN
   *                round-trip time, never blended with anything else.
   *   'no_quote' — a fresh, CLEAN confirmation there is nothing (no error) —
   *                the genuine pre-M7 "quote unavailable" case (closed
   *                market, feed gap). Nothing to wait for.
   *   'stale'    — a result exists but has aged past maxAgeMs. Must not be
   *                used for evaluation; `plan()` decides whether to relaunch.
   *   'none'     — no result has ever been recorded for this key.
   */
  peek(key, nowMs, maxAgeMs) {
    const r = this.results.get(key)
    if (!r || r.fetchedAtMs == null) return { state: 'none' }
    const age = Number(nowMs) - r.fetchedAtMs
    if (!(age >= 0) || age > maxAgeMs) return { state: 'stale', error: r.error }
    if (r.quote != null) return { state: 'quote', quote: r.quote, durationMs: r.durationMs }
    return { state: 'no_quote', error: r.error, durationMs: r.durationMs }
  }

  /**
   * Decide what a probe for `key` should do THIS pass, without running
   * anything: 'pending' (already in flight — do not relaunch; entirely
   * ordinary now that probes are never awaited within a pass, since a 6 s
   * round trip regularly outlives a single 3 s tick), 'backoff' (its LAST
   * probe SUCCEEDED and returned no quote, other symbols on this side are
   * fresh, and the position is NOT inside its spike window) or 'eligible'
   * (may launch, subject to the cap).
   *
   * Fix round 3, B1/B2: backoff requires `last.error == null` — a throw,
   * timeout or socket error is never treated as "genuinely quiet", so a
   * technical failure keeps retrying aggressively rather than being
   * mistaken for silence. `spikeActive` bypasses backoff entirely: a spike
   * is exactly when re-pricing matters most, and a single failed probe
   * must not suspend it for up to 5 minutes (the B2 reproduction).
   */
  plan(key, { sideHasFreshQuote = false, spikeActive = false, nowMs } = {}) {
    if (this.inflight.has(key)) return 'pending'
    if (!spikeActive) {
      const last = this.results.get(key)
      const cleanNoQuote = last ? (last.error == null && last.quote == null) : false
      if (cleanNoQuote && shouldBackoff({ lastProbeAtMs: this.lastProbeAt.get(key) ?? null, nowMs, backoffMs: this.backoffMs, sideHasFreshQuote })) {
        return 'backoff'
      }
    }
    return 'eligible'
  }

  /**
   * Order `keys` fairly for the cap: symbols never probed at all come first
   * (in the order given — first noticed this pass, not alphabetical), then
   * symbols probed before, oldest `lastProbeAt` first. Without this,
   * `selectUnderCap` — which is itself order-preserving — would relaunch the
   * same head-of-list `cap` keys every pass while the rest starve
   * indefinitely on a persistently over-subscribed side.
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
   * Launch `runProbe(key)` WITHOUT blocking the caller — fire-and-forget.
   * This is the spec's "results used on the next pass" (V3-SEQUENCE:537),
   * taken literally: nothing in fast-monitor.js's current pass ever awaits
   * this call. A later pass's `peek(key, ...)` is how the result is used,
   * once it has arrived and while it is still fresh.
   *
   * `nowFn` stamps `lastProbeAt` (at launch) and `fetchedAtMs` (at
   * completion) on the CALLER's clock (see the class note above), so a
   * later `peek()`'s age check is judged on the same clock throughout.
   * `monoFn` (defaults to `nowFn`; fast-monitor.js passes its own
   * monotonic `mono()`) measures the probe's OWN round-trip duration —
   * this is what `finishPricing`'s `lastPricingMs` reports (fix round 3,
   * B5): never another position's broker-action time, never a fabricated
   * "since batch start" figure.
   *
   * A key already in flight is never relaunched — the caller should check
   * `plan()` first, but this guard makes double-launch impossible even if
   * it does not.
   */
  launch(key, runProbe, nowFn, monoFn = () => Date.now()) {
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    this.lastProbeAt.set(key, nowFn())
    const startMono = monoFn()
    const settle = (quote, error) => {
      this.results.set(key, { quote: quote ?? null, error: error ?? null, fetchedAtMs: nowFn(), durationMs: Math.max(0, monoFn() - startMono) })
      this.inflight.delete(key)
      this._inflightPromises.delete(key)
    }
    // Call runProbe SYNCHRONOUSLY (not deferred behind a Promise.resolve()
    // microtask): a caller that captures a resolver/rejecter reference from
    // inside runProbe (as fast-monitor-probes.test.js's in-flight tests do,
    // and as any real WS call effectively does by opening its socket the
    // instant it is invoked) must be able to use that reference right after
    // launch() returns, not one tick later. This is still fire-and-forget —
    // launch() itself never awaits anything — it only starts the work eagerly,
    // the same way calling fetch() starts a request immediately.
    let started
    try {
      started = runProbe(key)
    } catch (err) {
      settle(null, err)
      return
    }
    const tracked = Promise.resolve(started).then(
      (quote) => settle(quote ?? null, null),
      (err) => settle(null, err),
    )
    this._inflightPromises.set(key, tracked)
  }

  /**
   * Test seam: resolves once every probe currently in flight has settled.
   * Production code never calls this — a pass never waits on a probe it
   * just launched, by design. Tests use it to make "the background probe
   * finished" deterministic instead of racing real timers.
   */
  async _drainForTests() {
    await Promise.all([...this._inflightPromises.values()])
  }

  /** Test seam / process restart: drop all state. */
  reset() {
    this.inflight.clear()
    this.lastProbeAt.clear()
    this.results.clear()
    this._inflightPromises.clear()
  }
}
