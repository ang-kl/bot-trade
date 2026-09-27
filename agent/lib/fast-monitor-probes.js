// ---------------------------------------------------------------------------
// agent/lib/fast-monitor-probes.js — M7 (P1/P4-4, V3-SEQUENCE:536-543; queue
// item 33; owner OD-22, 26-09-2026: "parallel probes under a cap, with
// backoff ≤ 5 min"). The broker probes of the fast monitor's price fallback.
//
// PROBLEM MEASURED (fast-monitor.js header): a position the sidecar does not
// price is priced by a broker round trip (≤ 6 s), and main awaits those one
// after another inside the pass — 48 serial round trips in one measured
// pass, worst tick 51 s, skipShare10m 0.45–0.75 against the goal table's
// ≤ 10 %.
//
// ROUND 4 DESIGN (26-09-2026). Rounds 1–3 were each refuted by a
// reproduction run side by side against origin/main; round 4 was written
// against a differential harness first (fast-monitor-m7-differential.test.js
// drives main's frozen runFastMonitor and this tree's through one virtual
// clock). The monitor's EXIT behaviour is held to main's by six invariants:
//
//   I1  NO BROKER-PRICED POSITION IS EVALUATED MORE THAN ONE TICK LATER THAN
//       MAIN WOULD, however slow other positions' work is — for a price
//       change aligned to the cadence; one that falls between the two
//       implementations' samples is a phase shift, bounded below under WHAT
//       IS HELD, AND WHAT CANNOT BE. How:
//         · LAUNCH AT THE ATTEMPT — a due position's probe starts right where
//           main would await it, inside the loop, never after it; beyond the
//           cap it queues FIFO and starts the moment a slot frees. So it starts
//           no later than main starts it (earlier probes no longer block the
//           loop).
//         · CONSUME IN MAIN'S ORDER — waiters are served strictly in the order
//           they registered (earlier passes first, then this pass in loop
//           order), which is the order main processes them in. A quote
//           observed more than one tick before main would have observed it
//           (main samples a position when its serial loop reaches it: after
//           the waiters ahead landed and acted) is not acted on as it stands:
//           it is asked again, together with every landed quote behind it as
//           far behind. A failure or an empty answer carries no price and is
//           served as it stands (re-asking those one by one would rebuild
//           main's serial chain of timeouts).
//         · CONSUME AT EVERY WAIT — at the start of every pass before any
//           awaited work; WHILE the pass awaits a read (the sidecar pull, a
//           relVol fetch), a landing does not wait for the read; BEFORE any
//           later position's broker action, the pass first settles every
//           earlier waiter (main would have finished those positions before
//           starting that action); and at the end of the pass for up to
//           `probeWaitMs` (the ticker tells each pass its tick; the wait is
//           the tick less one second), so a probe that answers inside the
//           tick is acted on in the pass that sent it.
//         · A RE-ASK IS WAITED FOR (round 5, B1) — a waiter this pass asked
//           again, because its landed quote aged while main's chain would
//           still be walking towards it, is waited for past the end-of-pass
//           deadline (PROBE_GUARD_MS bounds it): main's serial pass would be
//           sampling it at that moment. Ending the pass idle instead costs a
//           tick per re-ask, and behind slow exits that compounds down the
//           queue. The chain position and the deadline are both measured on
//           the monotonic clock (S2).
//       A probe is therefore acted on at the first of those points after it
//       lands: at once while a pass runs, and between passes on the next
//       tick. Main acts on it the moment it lands. Broker actions keep main's
//       relative order.
//   I2  INSIDE A SPIKE WINDOW EVERY TICK RE-PRICES. Results are consumed ONCE,
//       by the waiters registered before the probe landed; nothing is cached
//       for reuse. A due position whose probe was consumed earlier in the
//       pass launches a fresh one on that same tick.
//   I3  A PROBE FAILURE IS NOT A QUIET SYMBOL. A failure — the deadline
//       before the subscription was confirmed, an auth or cTrader error, a
//       closed socket, a throw — is `failed`; only a clean empty answer — the
//       broker confirmed the subscription and printed no two-sided price
//       before the deadline — is `empty` (ctrader-ws.js wsProbeSpot). Only
//       `empty` can arm the backoff, and never inside a spike window or while
//       the rest of the side is stale. Both are recorded as main records a
//       null quote (quote_unavailable) and retried on main's cadence.
//       A position the backoff holds gets its own decision state,
//       probe_backoff (round 5, S1), so the transition-gated log records it,
//       and the pass result counts it (probes.backoff).
//   I4  `null` FROM THE BOARD MEANS "NO VERDICT YET". A waiter whose probe is
//       queued or in flight has no verdict: its receipt says probe_pending,
//       and nothing — no quote_unavailable, no decision row, no lateness — is
//       recorded for it until its own result is consumed.
//   I5  LATENESS AND R3 EXCLUDE EXACTLY WHAT MAIN EXCLUDES. The eligibility of
//       the evaluation a probe answers is main's (protection-latency.js
//       latenessEligibility, unchanged) computed at the pass that ATTEMPTED
//       it — the pass main would have evaluated in — and carried through the
//       wait (and across a restart, on the receipt as `waitLateness`). R3
//       exempts main's states only; probe_pending and probe_backoff are
//       graded on lastCompletedAt like any other state. Both graders are
//       main's code, UNCHANGED by M7: protection-latency.js and
//       services/p1p4-grade.js are byte-identical to origin/main.
//   I6  PASS COUNTERS COUNT REAL BROKER CALLS ONCE. fromBroker, stale,
//       brokerQuotes and pricingMs are counted per probe, in the pass that
//       consumes it, whatever number of positions share it; a pass that only
//       launches counts nothing, so it never replaces the last priced pass's
//       record.
//
// WHAT IS HELD, AND WHAT CANNOT BE (corrected round 6, SF2). The
// differential harness holds every CADENCE-ALIGNED scenario's exit to within
// one tick of main's under the ticker's wait (and the round-3 reproductions
// X1–X5 even with no wait at all). What no parallel design can hold to one
// tick is a crossing that is NOT aligned to the cadence, because the two
// sample a position at different PHASES of its cycle:
//
//   · main samples position k only when its serial pass reaches it — C_k
//     after the pass began, C_k being main's chain ahead of k (the probe
//     round trips and actions of the positions before it: ≈ k × a probe's
//     latency, ≈ 20 s at the 48 serial round trips measured in production);
//   · this tree samples every due position at the start of its cycle.
//
// So, with P the position's cadence period:
//   · a crossing inside the C_k window (after this tree's sample, before
//     main's) is seen by main in that cycle and here at the next sample —
//     up to P − C_k LATER, plus the exits this tree serves ahead of k in
//     that pass (each a broker action, and a re-ask once the chain has aged
//     its quote: when many positions cross together this tree exits them in
//     main's position order, while main exits first those it happened to
//     sample after the crossing);
//   · a crossing in the rest of the cycle (after main's sample, before this
//     tree's next) is seen here first — up to C_k EARLIER.
// Over a crossing placed uniformly in the cycle the two cancel (window C_k
// × lateness P − C_k against window P − C_k × lead C_k): a phase shift,
// not a lag in expectation — but its worst case is a cadence period, not a
// tick. fast-monitor-m7-differential.test.js pins both directions ("phase"
// scenarios) against the bound as stated here. Holding the worst case to a
// tick would mean sampling at main's instants — which is main's serial loop.
//
// THE COST OF WAITING FOR A RE-ASK (B1). A pass that waits for a re-asked
// probe past its end-of-pass deadline can run up to PROBE_GUARD_MS (10 s)
// over, so the ticker SKIPS the ticks it overlaps — as main's own long
// serial passes do. Read `skipShare` with that in mind: a skipped tick
// under M7 is time spent serving an exit chain, not an idle pass.
//
// THE ONE DELIBERATE DEPARTURE FROM MAIN'S TIMING — OD-22's backoff. A symbol
// whose last probe was a clean empty answer, while other symbols on its side
// stream fresh quotes and it is not in a spike window, is not probed again
// until `backoffMs` (≤ 5 min) after that probe was sent; its receipt says
// probe_backoff. Main would have asked on its cadence. That is the owner's
// decision, bounded by PROBE_BACKOFF_MAX_MS, and nothing else re-orders or
// delays a probe main would make.
//
// OPEN, NOT ANSWERED HERE (OD-22's second half): whether a quiet symbol's old
// quote in an OPEN market may ever count as current (0066.HK, the 10 s recvMs
// rule in fast-monitor.js). Nothing here treats an old price as current: a
// landed quote observed more than one tick before main would have observed
// it is never evaluated — its waiter is probed again.
// ---------------------------------------------------------------------------

import { BoundedMap } from './bounded-map.js'

/** Default concurrent-probe ceiling — comfortably above one side's usual open-position count; env-overridable per OD-22's cap. */
export const PROBE_CAP_DEFAULT = 8
/** A cap of 0 disables probing silently and an unbounded one opens as many authed broker sockets as there are due positions — both are refused. */
export const PROBE_CAP_MAX = 32

/** OD-22: the backoff must never exceed 5 minutes, however it is configured. */
export const PROBE_BACKOFF_MAX_MS = 5 * 60_000
export const PROBE_BACKOFF_DEFAULT_MS = 60_000

/**
 * A landed quote older than this when its waiter's turn comes is never
 * evaluated: the waiter is asked again (I1, I2). One production tick — main
 * samples a position when its turn comes, so an answer that waited longer
 * than a tick behind slower work is older than main's would be. Its own
 * bound: the sidecar's FAST_MONITOR_QUOTE_MAX_AGE_MS governs sidecar quotes
 * only, and raising it must not let a broker answer be replayed (nit 4).
 */
export const PROBE_RESULT_MAX_AGE_MS = 3_000
/** Never below this, whatever the tick: a sub-second tick must not re-ask every answer that waited one pass. */
export const PROBE_RESULT_MIN_AGE_MS = 1_000
/** wsProbeSpot settles within its own 6 s deadline; a probe still open after this is settled as failed (a hung mock or a regression must never wedge a pass that waits on it). */
export const PROBE_GUARD_MS = 10_000
/** The end-of-pass wait for a direct runFastMonitor call; the ticker passes probeWaitForTick(tickMs). */
export const PROBE_WAIT_DEFAULT_MS = 2_000
/** The end-of-pass wait leaves this much of the tick free, so waiting for probes never makes the ticker skip. */
export const PROBE_WAIT_MARGIN_MS = 1_000

/** Bound on how many distinct symbols' probe history this process remembers — an evicted key is simply never-probed again, same as a fresh process. */
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

/** The end-of-pass probe wait for a ticker of `tickMs`: the tick less PROBE_WAIT_MARGIN_MS, at most PROBE_WAIT_DEFAULT_MS, never negative. Pure. */
export function probeWaitForTick(tickMs) {
  const t = Number(tickMs)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.min(PROBE_WAIT_DEFAULT_MS, t - PROBE_WAIT_MARGIN_MS))
}

/** How old a landed quote may be when its turn comes, for a ticker of `tickMs`: one tick, at least PROBE_RESULT_MIN_AGE_MS. Pure. */
export function probeMaxAgeForTick(tickMs) {
  const t = Number(tickMs)
  if (!(Number.isFinite(t) && t > 0)) return PROBE_RESULT_MAX_AGE_MS
  return Math.max(PROBE_RESULT_MIN_AGE_MS, t)
}

/**
 * Pure: the TIMING half of the backoff. Never arms for a symbol never
 * probed, nor while the rest of its side is NOT fresh (a quiet feed must
 * keep retrying — only a quiet SYMBOL backs off). ProbeBoard.backoffActive
 * additionally requires the last answer to have been a clean `empty` and
 * never consults this inside a spike window.
 */
export function shouldBackoff({ lastProbeAtMs = null, nowMs, backoffMs, sideHasFreshQuote = false } = {}) {
  if (!sideHasFreshQuote) return false
  if (lastProbeAtMs == null) return false
  const n = Number(nowMs), l = Number(lastProbeAtMs), b = Number(backoffMs)
  if (!Number.isFinite(n) || !Number.isFinite(l) || !Number.isFinite(b) || b <= 0) return false
  return n - l < b
}

/**
 * Pure: does the given side have a FRESH, VALID quote for some symbol OTHER
 * than `excludeSymbolId`? The "other symbols on the same side are fresh"
 * condition backoff requires (V3-SEQUENCE:539) — a quote for the probed
 * symbol itself never counts, and a row with an age inside the window but an
 * invalid price (missing side, non-positive bid, crossed book) is not fresh:
 * freshness describes a PRICE, not a timestamp alone.
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
 * Normalise one probe answer (I3):
 *   { kind: 'quote', bid, ask }   — both sides arrived (validity is the evaluator's check, as on main)
 *   { kind: 'empty', reason }     — subscribed, no two-sided price before the deadline
 *   { kind: 'failed', reason }    — anything else
 * A bare {bid, ask} is a quote. A bare null is `failed`: the legacy
 * wsGetSpotOnce contract cannot tell failure from silence, so it never arms
 * the backoff.
 */
export function probeResultOf(answer) {
  if (answer && typeof answer === 'object' && typeof answer.kind === 'string') {
    if (answer.kind === 'quote') return { kind: 'quote', bid: answer.bid, ask: answer.ask }
    if (answer.kind === 'empty') return { kind: 'empty', reason: answer.reason ?? null }
    return { kind: 'failed', reason: answer.reason ?? 'failed' }
  }
  if (answer && typeof answer === 'object' && ('bid' in answer || 'ask' in answer)) return { kind: 'quote', bid: answer.bid, ask: answer.ask }
  return { kind: 'failed', reason: 'no quote (a null answer cannot say whether the broker failed or the symbol was silent)' }
}

const TIMED_OUT = Symbol('timed out')

/**
 * Race `promise` against `ms` on the caller's clock: an injected `sleep`
 * (virtual time in the harness), else a referenced timer that is cleared as
 * soon as the race settles — never unref'd (an unref'd timer cannot fire when
 * it is the last thing on the loop; fast-monitor.js withBudget has the story).
 * Resolves to the promise's value, or TIMED_OUT.
 */
export function raceTimeout(promise, ms, sleep = null) {
  if (!(ms >= 0) || !Number.isFinite(ms)) return promise
  if (sleep) return Promise.race([promise, sleep(ms).then(() => TIMED_OUT)])
  let timer = null
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })])
    .finally(() => { if (timer) clearTimeout(timer) })
}
export const isTimedOut = (v) => v === TIMED_OUT

/**
 * The probes and their waiters, for one process. fast-monitor.js keeps one
 * module-level board, so the cap, the queue and the backoff memory span
 * passes. Every method that stamps time takes the CALLER's clock
 * `{ now, mono, sleep }` (injected in tests, Date.now / performance.now in
 * production) — a board with its own clock would judge freshness against a
 * different time than the pass it serves.
 *
 * A WAITER is one due position waiting on one probe: { posId, key, probe,
 * ...ctx }. Waiters form one FIFO in registration order (I1). A PROBE is
 * { key, state: 'queued'|'inflight'|'settled', result, launchedAt,
 * settledAt, durationMs, settled: Promise, counted, pick }; positions on the
 * same feed key JOIN the probe that is still open (queued or in flight)
 * rather than launching another, and never join one that has landed (I2).
 */
export class ProbeBoard {
  constructor({ cap = PROBE_CAP_DEFAULT, backoffMs = PROBE_BACKOFF_DEFAULT_MS } = {}) {
    this.cap = clampCap(cap)
    this.backoffMs = Math.min(backoffMs, PROBE_BACKOFF_MAX_MS)
    this.waiters = []
    this.open = new Map()
    this.queue = []
    this.inflight = 0
    this.history = new BoundedMap(PROBE_KEY_CAP, { lru: true, name: 'probe.history' }) // key → { lastLaunchAt, lastKind }
    this.landings = []
    this.all = new Set() // every probe not yet settled — the drain seam
    this.gen = 0 // bumped by reset(): a probe from before a reset settles into nothing
    // Where main's serial loop would be in the chain of waiters being served:
    // the latest landing served plus the actions taken since, on the caller's
    // wall clock; null while no chain is open (fast-monitor.js sets it).
    this.chainAt = null
  }

  inflightCount() { return this.inflight }
  queuedCount() { return this.queue.length }
  head() { return this.waiters[0] ?? null }
  waiterOf(posId) { return this.waiters.find(w => w.posId === posId) ?? null }
  hasLanded(w) { return w?.probe?.state === 'settled' }
  shift() { return this.waiters.shift() ?? null }

  /** Drop every waiter whose position fails `keep(posId)` (closed, paused, re-routed). Its probe runs on; its answer is simply not consumed. */
  retain(keep) { this.waiters = this.waiters.filter(w => keep(w.posId, w)) }

  /**
   * Whether an empty answer for `key` would (re-)arm OD-22's backoff right
   * now, time aside: the last answer was a clean `empty`, the rest of the
   * side streams, and no spike window is open. When this is false a backoff
   * has LIFTED for a reason other than its time running out (SF1).
   */
  backoffCanArm(key, { sideHasFreshQuote = false, spikeActive = false } = {}) {
    if (spikeActive || !sideHasFreshQuote) return false
    const h = this.history.get(key)
    return !!h && h.lastKind === 'empty'
  }

  /**
   * OD-22's backoff for `key` at `nowMs` (I3): only after a clean `empty`
   * answer, only while the side is otherwise fresh, never in a spike window,
   * and for at most backoffMs after that probe was sent.
   */
  backoffActive(key, { nowMs, sideHasFreshQuote = false, spikeActive = false } = {}) {
    if (!this.backoffCanArm(key, { sideHasFreshQuote, spikeActive })) return false
    const h = this.history.get(key)
    return shouldBackoff({ lastProbeAtMs: h.lastLaunchAt, nowMs, backoffMs: this.backoffMs, sideHasFreshQuote })
  }

  /**
   * Register a due position as a waiter on `key`'s probe: join the open one,
   * or create one (started now under the cap, or queued FIFO). `run()` makes
   * the broker call; `pick` is why the broker is asked ('missing' | 'stale').
   */
  register({ posId, key, run, pick = null, ctx = {} }, clock) {
    let probe = this.open.get(key)
    if (!probe) probe = this._create(key, run, pick, clock)
    const w = { ...ctx, posId, key, probe }
    this.waiters.push(w)
    return w
  }

  /** Give a waiter whose landed quote went stale a fresh probe, keeping its place in the FIFO. */
  reprobe(w, run, clock) {
    w.probe = this.open.get(w.key) ?? this._create(w.key, run, w.probe?.pick ?? null, clock)
    return w
  }

  /** A promise that resolves at the next probe landing (never, while nothing is open). */
  nextLanding() { return new Promise(resolve => this.landings.push(resolve)) }

  _create(key, run, pick, clock) {
    let settle
    const probe = { key, run, pick, gen: this.gen, state: 'queued', result: null, launchedAt: null, settledAt: null, settledMono: null, durationMs: null, counted: false, startMono: null, settled: new Promise(r => { settle = r }) }
    probe._resolve = settle
    this.open.set(key, probe)
    this.all.add(probe)
    if (this.inflight < this.cap) this._start(probe, clock)
    else this.queue.push({ probe, clock })
    return probe
  }

  _start(probe, clock) {
    probe.state = 'inflight'
    this.inflight++
    probe.launchedAt = clock.now()
    probe.startMono = clock.mono()
    const h = this.history.get(probe.key)
    this.history.set(probe.key, { lastLaunchAt: probe.launchedAt, lastKind: h?.lastKind ?? null })
    let started
    try { started = Promise.resolve(probe.run()) } catch (err) { started = Promise.reject(err) }
    const answered = started.then(probeResultOf, (err) => ({ kind: 'failed', reason: err?.message || String(err) }))
    raceTimeout(answered, PROBE_GUARD_MS, clock.sleep)
      .then(r => (isTimedOut(r) ? { kind: 'failed', reason: `probe still open after ${PROBE_GUARD_MS} ms` } : r))
      .then(r => this._settle(probe, r, clock))
  }

  _settle(probe, result, clock) {
    if (probe.state === 'settled') return
    if (probe.gen !== this.gen) { probe.state = 'settled'; probe.result = result; probe._resolve(); return }
    probe.state = 'settled'
    probe.result = result
    probe.settledAt = clock.now()
    probe.settledMono = clock.mono()
    probe.durationMs = Math.max(0, probe.settledMono - probe.startMono)
    this.inflight--
    if (this.open.get(probe.key) === probe) this.open.delete(probe.key)
    this.all.delete(probe)
    this.history.set(probe.key, { lastLaunchAt: probe.launchedAt, lastKind: result.kind })
    probe._resolve()
    const landings = this.landings.splice(0)
    for (const r of landings) r()
    while (this.inflight < this.cap && this.queue.length) {
      const next = this.queue.shift()
      this._start(next.probe, next.clock)
    }
  }

  /** Test seam: resolves once every probe open right now has settled (a queued one included). */
  async _drainForTests() {
    while (this.all.size) await Promise.all([...this.all].map(p => p.settled))
  }

  /** Test seam / process restart: drop all state (probes in flight settle into nothing). */
  reset() {
    this.gen++
    this.chainAt = null
    this.waiters = []
    this.open.clear()
    this.queue = []
    this.inflight = 0
    this.history.clear()
    this.all.clear()
    const landings = this.landings.splice(0)
    for (const r of landings) r()
  }
}
