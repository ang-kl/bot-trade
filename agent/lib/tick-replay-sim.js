// agent/lib/tick-replay-sim.js — P4: the deterministic event replayer
// (docs/tick-momentum/plan.md §7; register TM-05, TM-34). Runs the
// reference strategy over an ordered stream of quote events for one symbol
// and simulates every signal as a trade with EXECUTABLE prices: a long
// buys at the first accepted ask at or after the decision plus the latency
// allowance, a short sells at the bid; exits fill at the bid (long) or ask
// (short) that actually crossed the stop or target — a gap through the
// stop fills at the price that was there, never at the stop — plus adverse
// slippage and commissions; a finite event holding cap and a wall-clock
// cap close what neither stop nor target reached. No side is ever read
// from the future: the decision uses only events up to the signal, the
// fill only events at or after it. Results are R multiples of the signal's
// stop distance, net of costs, with chronological blocks and a purge
// between them.
import { costClassOf, costExact, costsForClass, wireCostInt } from './tick-cost-schedule.js'
import { TickMomentumOracle, normalizeParams, profileHash, STRATEGY_ID, STRATEGY_VERSION } from './tick-strategy.js'

export const DEFAULT_SIM = Object.freeze({
  // Decision + network delay before the entry can fill. A number, or an
  // array of MEASURED samples (ms) — plan §7 "measured latency distribution
  // with a pessimistic tail": with samples the fill waits the p90 of them
  // (latencyPercentile), never their mean. The default is a fixed 250 ms,
  // reported as such (sim.latencySource) so a trial cannot read as measured.
  latencyMs: 250,
  latencyPercentile: 0.9,
  slippage: 0,                // global absolute slippage per fill, wire units — ADDS to the class row
  commissionPerSide: 0,       // global absolute commission per fill, wire units — ADDS to the class row
  // PR-L: the per-symbol-class cost schedule (lib/tick-cost-schedule.js).
  // `costs` is { classes, fallbackClass }, each class carrying an absolute
  // wire term AND a bps term per side — the broker charges both shapes (US
  // stock is a flat $0.02 per share, HK stock and FX are proportional), and
  // a cTrader wire unit is 1e-5 of the symbol's own price for every symbol. `symbol`
  // (a name) or `costClass` (a class directly) says which row to charge; an
  // unclassified symbol is charged the schedule's fallbackClass and SAYS so
  // on the result (sim.costSource).
  costs: null,
  symbol: null,
  costClass: null,
  targetR: 3,                 // gross target as a multiple of the stop distance
  minTargetToCost: 3,         // screening: target / round-trip cost (spread + 2·commission + 2·slippage)
  maxHoldEvents: null,        // default 4 × rangeEvents
  maxHoldMs: 6 * 3600_000,    // finite clock cap (a halted feed never delivers the event exit)
  blocks: 3,                  // chronological train / validation / test
  // Plan §7: the final block is UNTOUCHED until the owner's one confirmation
  // run — every trial computes train and validation only; includeTest:true
  // (recorded on the trial) unseals it.
  includeTest: false,
  // Purge window in events across every block boundary: trades entered
  // within it BEFORE a boundary (their holding window crosses it) and
  // trades entered within it AFTER a boundary (their feature window reaches
  // back across it) are dropped. Default: the feature window (N + M) or the
  // holding cap, whichever is larger.
  purgeEvents: null,
})

/** The latency the fill waits: a fixed number, or the p-quantile of measured samples. */
export function resolveLatency(latencyMs, percentile = 0.9) {
  if (Array.isArray(latencyMs)) {
    const xs = latencyMs.map(Number).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
    if (!xs.length) return { ms: DEFAULT_SIM.latencyMs, source: 'default (no usable samples)' }
    const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(percentile * xs.length) - 1))
    return { ms: xs[idx], source: `measured p${Math.round(percentile * 100)} of ${xs.length} samples` }
  }
  const n = Number(latencyMs)
  return { ms: Number.isFinite(n) && n >= 0 ? n : DEFAULT_SIM.latencyMs, source: 'fixed' }
}

/** Accepted-event predicate shared with the oracle: two-sided, uncrossed, non-snapshot, changed. */
function tradable(q) { return q.bid != null && q.ask != null && !q.snapshot && !q.crossed }

/**
 * PR-Q1 (V3 P6/P7, 25-09-2026): v2 is the first version whose `summary`
 * covers ONLY the blocks the trial is allowed to read. Every trial written
 * before it (v1, or no version at all) computed `summary` over every trade —
 * test block included — while `blocks` said the test block was withheld, so
 * its test period could be read by subtraction (verified: four planted
 * signals, three in the last third, gave summary.trades 4 / netR 12.24 with
 * train 1 and validation 0). Those rows are CONSULTED, and the ledger says so
 * by this version string, never by a guess.
 */
export const STATISTICS_VERSION = 'mtm-moving-block-v2'
export const LEGACY_STATISTICS_VERSIONS = Object.freeze(['mtm-moving-block-v1'])
/** A trial record keeps at most this many signals and trades for the parity report. */
export const PARITY_RECORD_MAX = 500

/**
 * The event holding cap, normalised as the sidecar does it: cpp-exec's
 * ShadowBook takes `sim.maxHoldEvents > 0 ? sim.maxHoldEvents : 4 × rangeEvents`
 * (tick_shadow.cpp:84), and agent/config/tick-shadow-sim.json ships 0 to mean
 * "the default". The replayer read `maxHoldEvents ?? 4N`, so 0 closed every
 * trade after ONE event — copying the shadow's sim into a replay made every
 * trade a one-event hold. 0, null, a negative or a non-number are all 4N here.
 */
export function normalizeMaxHoldEvents(value, rangeEvents) {
  const n = Number(value)
  return value != null && Number.isFinite(n) && n > 0 ? n : 4 * rangeEvents
}

/**
 * PR-Q3 (V3 P6/P7, 25-09-2026): the live filters as a STAMPED sim block.
 *
 * The live tick path refuses entries the shadow book (and, before this, the
 * replayer) takes:
 *   counterTrend — the permit feeder withholds the against-trend side
 *                  (tick-permits.js: permittedSides(trendReadingFor(...)));
 *                  the firer then refuses `no_permit`. Judged here on the
 *                  regime reading AS OF the signal (trendReadingAt's answer).
 *   priceBound   — tick_firer.cpp:138-142: refuse when the fill is more than
 *                  floor(overshootFraction × stopDistance) from the signal's
 *                  own quote (ask for a BUY, bid for a SELL), and whenever
 *                  that quote is not positive (order_guard.cpp priceWithinBound).
 *   stopFloor    — tick_firer.cpp:148-152: refuse when stopDistance <
 *                  llround(minStopFraction × entry), only when the fraction > 0.
 *   signalTtl    — NOT a filter the gateway runs today: the pending-signal
 *                  expiry the dual-environment plan (P3) adds. Its value is the
 *                  permits' maxFireDelayMs — the firer's refusal of a fire that
 *                  aged past it at the send (tick_firer.cpp:202-208), a queue
 *                  delay a replay cannot see. The replay's reading is the wait
 *                  the fill itself imposed: a signal whose first executable
 *                  quote arrives more than signalTtlMs after the moment it was
 *                  due (signal time + latency) is refused.
 *
 * TWO MODELS of what a refusal does to the book, stamped as `model` because
 * they are different populations and a reader must never have to guess:
 *   'firer' (the default) — what the gateway does TODAY. The shadow book fills
 *            every signal it takes (tick_shadow.cpp) and hands the fill to the
 *            firer, which refuses the live order (tick_firer.cpp onFill). The
 *            refused trade still HOLDS the book to its shadow exit, so the
 *            signals it blocks are not taken; it is reported apart
 *            (diagnostics.vetoedTrades), never as a trade. The book's trades
 *            are exactly the unfiltered replay's — the replay form of the
 *            shadow counterfactual (tick-shadow-counterfactual.js: removed one
 *            at a time, no freed slot).
 *   'book'  — a ShadowBook that applies the filters itself (dual plan P3,
 *            PR-Q4 — NOT built): a refused signal opens nothing and FREES the
 *            book for the next one, and a pending signal expires at its TTL.
 * Each signal is counted once, under the FIRST filter that refuses it, in the
 * order LIVE_FILTER_NAMES lists: the counter-trend veto at the signal, then at
 * the fill the TTL, the price bound and the stop floor (the firer's own order:
 * permit, bound, floor).
 *
 * The block's VALUES are never set here: the research doors resolve them from
 * the permits' own config (loadTickEntryConfig) and the regime gate, and the
 * whole block rides `sim` — so it is part of the trial id and the sim hash.
 * With the block absent (or every filter off) nothing here changes: the
 * output is byte-identical to the build before it.
 */
export const LIVE_FILTERS_VERSION = 'live-filters-v1'
/** The four filters, in the order a signal is judged. */
export const LIVE_FILTER_NAMES = Object.freeze(['counterTrend', 'signalTtl', 'priceBound', 'stopFloor'])
/**
 * The filters the gateway RUNS today (tick_firer.cpp: permit, bound, floor).
 * `signalTtl` is not one of them — it is the dual plan's planned expiry — so
 * a research body's `liveFilters: true` switches on these three only, and a
 * trial that names the TTL says in its diagnostics that it is not live.
 */
export const GATEWAY_LIVE_FILTERS = Object.freeze(['counterTrend', 'priceBound', 'stopFloor'])
/** What a refusal does to the book (see above); the first is the default. */
export const LIVE_FILTER_MODELS = Object.freeze(['firer', 'book'])
const LIVE_FILTER_KEYS = new Set(['version', 'model', 'minStopFraction', 'overshootFraction', 'signalTtlMs', 'counterTrend', 'configSource'])

/**
 * The stamped block, or null when no filter is on. Throws on a key it does
 * not know, a model it does not know or a value that is not a finite number
 * >= 0: a misspelt filter read as "off" would be a guard that never fires,
 * stamped as if it had.
 */
export function normalizeLiveFilters(lf) {
  if (lf == null || lf === false) return null
  if (typeof lf !== 'object' || Array.isArray(lf)) throw new TypeError('sim.liveFilters must be an object, null or absent')
  for (const k of Object.keys(lf)) if (!LIVE_FILTER_KEYS.has(k)) throw new TypeError(`sim.liveFilters.${k} is not a live filter field (${[...LIVE_FILTER_KEYS].join(', ')})`)
  const num = (k) => {
    const v = lf[k]
    if (v == null) return null
    const n = typeof v === 'number' ? v : NaN
    if (!Number.isFinite(n) || n < 0) throw new TypeError(`sim.liveFilters.${k} must be a finite number >= 0 or null (got ${JSON.stringify(v)})`)
    return n
  }
  const model = lf.model == null ? LIVE_FILTER_MODELS[0] : lf.model
  if (!LIVE_FILTER_MODELS.includes(model)) throw new TypeError(`sim.liveFilters.model must be one of ${LIVE_FILTER_MODELS.join(', ')} (got ${JSON.stringify(lf.model)})`)
  const minStopFraction = num('minStopFraction')
  const overshootFraction = num('overshootFraction')
  const signalTtlMs = num('signalTtlMs')
  const ct = lf.counterTrend
  let counterTrend = null
  if (ct === true || (ct && typeof ct === 'object' && !Array.isArray(ct))) {
    const age = ct === true ? null : ct.maxRegimeAgeMin
    const gateOn = ct === true ? null : ct.gateOn
    // Fix round (checker N2): a stamp that is not a number, or a gate flag
    // that is not a boolean, is refused as num() refuses a value — read as
    // null it would stamp "no age bound" on a veto meant to carry one. Null
    // is "the gate did not say"; 0 or less is the reader's own "no bound".
    if (age != null && !(typeof age === 'number' && Number.isFinite(age))) throw new TypeError(`sim.liveFilters.counterTrend.maxRegimeAgeMin must be a finite number or null (got ${JSON.stringify(age)})`)
    if (gateOn != null && typeof gateOn !== 'boolean') throw new TypeError(`sim.liveFilters.counterTrend.gateOn must be true, false or null (got ${JSON.stringify(gateOn)})`)
    counterTrend = {
      asOf: 'signal_time',
      gateOn: gateOn ?? null,
      maxRegimeAgeMin: age ?? null,
    }
  } else if (ct != null && ct !== false) {
    throw new TypeError('sim.liveFilters.counterTrend must be true, an object stamping the regime gate, or absent')
  }
  if (minStopFraction == null && overshootFraction == null && signalTtlMs == null && counterTrend == null) return null
  return {
    version: LIVE_FILTERS_VERSION,
    model,
    minStopFraction, overshootFraction, signalTtlMs, counterTrend,
    configSource: lf.configSource == null ? null : String(lf.configSource),
  }
}

/** Sorted-key copy, so two blocks compare by value whatever their key order. */
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v

/**
 * One comparable string for a stamped block (null for none), so the parity
 * report and the replay rung compare two blocks by value, whatever their key
 * order. `{ book: true }` keys only what changes the BOOK: a 'firer' block
 * leaves the book exactly the unfiltered one, so it keys as no block.
 */
export function liveFiltersKey(lf, { book = false } = {}) {
  if (lf == null) return null
  if (book && lf.model !== 'book') return null
  return JSON.stringify(canonical(lf))
}

/**
 * The fill-time refusal a live filter makes, or null. Pure; `entry` is the
 * fill price with slippage (what the firer sees as the book's entry) and
 * `overdueMs` how long past its due time (signal + latency) the fill came.
 */
export function fillVeto(lf, signal, entry, overdueMs = 0) {
  if (!lf) return null
  if (lf.signalTtlMs != null && overdueMs > lf.signalTtlMs) return 'signalTtl'
  if (lf.overshootFraction != null) {
    const ref = signal.side === 'BUY' ? Number(signal.ask) : Number(signal.bid)
    const maxDev = Math.floor(lf.overshootFraction * signal.stopDistance)
    if (!(ref > 0) || maxDev < 0 || Math.abs(entry - ref) > maxDev) return 'priceBound'
  }
  if (lf.minStopFraction != null && lf.minStopFraction > 0) {
    // llround of a positive value is Math.round (half away from zero agrees
    // for x > 0); tick-shadow-counterfactual.js stopFloorWire is the same.
    const floorDist = Math.round(lf.minStopFraction * entry)
    if (signal.stopDistance < floorDist) return 'stopFloor'
  }
  return null
}

/**
 * simulate(events, params, sim) → { trades, summary, blocks, rejected, parity }.
 * `events` are oracle quotes { seq, recvMs, bid, ask, snapshot, crossed, changed }
 * in order for ONE symbol; `signalsOverride` lets a test plant signals.
 *
 * PR-Q3: with `sim.liveFilters` on, `trendSidesAt(recvMs)` answers the order
 * sides the regime reading AS OF that moment permits (the caller's
 * permittedSides over trendReadingAt), or null when there is no reading —
 * no reading grants both sides, as the live feeder does. Required when the
 * counter-trend filter is on: a filter that cannot be judged is refused, not
 * stamped as applied. Under the 'firer' model `trades` are the trades the
 * firer would have placed; the refused trades the book held are reported by
 * the diagnostics (vetoedTrades) and, flagged `vetoedBy`, in the parity
 * record, which is the book's own record.
 *
 * PR-Q1: with the test block withheld (`includeTest` not true and more than
 * one block), `summary`, its `diagnostics` and the `parity` record cover ONLY
 * the events before the test block, and only trades that ENTERED and EXITED
 * there — a trade whose exit read a test-block price is test-period
 * information. The train and validation `blocks` rows are built from the same
 * in-scope trades. `summary.scope` says which. `trades` and `rejected` stay the
 * whole in-memory run (the C++ shadow-book fixture is pinned against them);
 * nothing persisted reads them for a withheld trial.
 */
export function simulate(events, params = {}, sim = {}, { signalsOverride = null, trendSidesAt = null } = {}) {
  const p = normalizeParams(params)
  const s = { ...DEFAULT_SIM, ...sim }
  s.statisticsVersion = STATISTICS_VERSION
  // PR-Q3: absent, null or every filter off is the SAME stored sim as before
  // the block existed — no key at all — so it keys the same trial id.
  const lf = normalizeLiveFilters(s.liveFilters)
  if (lf) s.liveFilters = lf
  else delete s.liveFilters
  if (lf?.counterTrend && typeof trendSidesAt !== 'function') throw new TypeError('sim.liveFilters.counterTrend is on but no trendSidesAt reader was given: the veto could not be judged')
  const maxHoldEvents = normalizeMaxHoldEvents(s.maxHoldEvents, p.rangeEvents)
  // 0 and null are the same request (4N), so they are stored the same way and
  // key the same trial id; the resolved cap is stated beside it.
  s.maxHoldEvents = s.maxHoldEvents != null && Number(s.maxHoldEvents) > 0 ? maxHoldEvents : null
  s.maxHoldEventsResolved = maxHoldEvents
  const latency = resolveLatency(s.latencyMs, s.latencyPercentile)
  s.latencyMs = latency.ms
  s.latencySource = latency.source
  const purgeEvents = s.purgeEvents ?? Math.max(p.rangeEvents + p.momentumEvents, maxHoldEvents)
  s.purgeEvents = purgeEvents
  // PR-L: resolve the per-class cost ONCE — `simulate` runs one symbol, so
  // one class holds for the whole run. The absolute wire-unit fields add on
  // top, so a sim with no schedule behaves exactly as it did before.
  const row = costsForClass(s.costs || { classes: {}, fallbackClass: null }, s.costClass ?? (s.symbol ? costClassOf(s.symbol) : null))
  s.costClass = row.class
  s.costSource = row.source
  // ROUND-TWO CHECKER, MINOR 4: the EFFECTIVE terms — the class row with the
  // legacy global absolute fields folded in ONCE. Charging `global + class`
  // while reporting only the class row let the two drift apart, and the
  // `reprice@1 === recorded netR` invariant held only while both globals
  // were 0. cpp-exec/src/tick_shadow.cpp folds the same way at construction.
  s.commissionWirePerSide = row.commissionWirePerSide + (Number(s.commissionPerSide) || 0)
  s.commissionBpsPerSide = row.commissionBpsPerSide
  s.slippageWirePerSide = row.slippageWirePerSide + (Number(s.slippage) || 0)
  s.slippageBpsPerSide = row.slippageBpsPerSide
  // Slippage shifts an INTEGER price, so it rounds — away from zero, so a
  // non-zero slippage never becomes a free fill on a cheap symbol. Commission
  // is EXACT (a double) and subtracted before the R division, so a sub-wire
  // commission still bites. cpp-exec/src/tick_shadow.cpp does the same.
  const slipAt = (price) => wireCostInt(s.slippageWirePerSide, s.slippageBpsPerSide, price)
  const commAt = (price) => costExact(s.commissionWirePerSide, s.commissionBpsPerSide, price)
  const oracle = new TickMomentumOracle(p)
  const trades = []
  const rejected = { cost: 0, noFill: 0 }
  let signals = 0
  // PR-Q1: where the withheld test block starts, cut exactly as
  // blockSummaries cuts it. Everything the trial REPORTS stops here unless the
  // owner's confirmation run (includeTest) unseals it.
  const nBlocks = Number(s.blocks)
  const withheld = s.includeTest !== true && nBlocks > 1
  const sealedAt = withheld ? (nBlocks - 1) * Math.floor(events.length / nBlocks) : events.length
  const signalLog = []          // every signal (taken or not) with its event index, for the parity record
  const settleEvents = p.expiryEvents + p.rearmCooldownEvents
  let warmAt = null, settledAt = null  // { idx, ms } — the replay's own warm-up, for the parity window
  let sealedCounters = null
  // PR-Q3: per-filter veto counts (principle 7: vetoes are part of what is
  // minimised, so each is counted, never folded into noFill), the signals the
  // counter-trend filter judged with no reading, and every fill — so that
  // signals = filled + costRejected + noFill + vetoed + pending holds at any
  // cut, and a reader can check that the counts add up.
  const vetoed = { counterTrend: 0, signalTtl: 0, priceBound: 0, stopFloor: 0 }
  const vetoLog = []
  const heldVetoed = []  // model 'firer': the refused trades the book held to their shadow exit
  const bookRefuses = lf?.model === 'book'
  let counterTrendNoReading = 0, filled = 0
  let pending = null     // a signal waiting for its fill
  let pendingVeto = null // model 'firer': the counter-trend refusal judged at the signal, applied at its fill
  const veto = (name, sig, idx) => { vetoed[name]++; vetoLog.push({ idx, seq: sig.seq, recvMs: sig.recvMs, side: sig.side, filter: name }) }
  // A closed trade goes to the ledger — or, refused by a filter under the
  // 'firer' model, beside it: the book held it, the firer placed nothing.
  const close = (position, rec) => { if (position.vetoedBy) heldVetoed.push({ ...rec, vetoedBy: position.vetoedBy }); else trades.push(rec) }
  const counters = (idx) => ({ events: idx, acceptedEvents: oracle.accepted, warmedEvaluations: oracle.warmedEvaluations, signals, oracleRejected: { ...oracle.rejected }, costRejected: rejected.cost, noFill: rejected.noFill, vetoes: { ...vetoed }, counterTrendNoReading, filled, pending: pending ? 1 : 0 })
  const mark = (position, q) => {
    const exit = position.side === 'BUY' ? q.bid - slipAt(q.bid) : q.ask + slipAt(q.ask)
    const gross = position.side === 'BUY' ? exit - position.entry : position.entry - exit
    const r = (gross - commAt(position.entry) - commAt(exit)) / position.signal.stopDistance
    position.markMinR = Math.min(position.markMinR, r)
    position.markMaxR = Math.max(position.markMaxR, r)
    position.markDrawdownR = Math.max(position.markDrawdownR, position.markMaxR - r)
  }
  const marks = position => ({ markMinR: position.markMinR, markMaxR: position.markMaxR, markDrawdownR: position.markDrawdownR, entryMs: position.entryMs })
  let open = null        // { side, signal, entry, stop, target, entryIdx, entryMs, tradableSeen }
  const planted = signalsOverride ? new Map(signalsOverride.map(sg => [sg.seq, sg])) : null
  for (let i = 0; i < events.length; i++) {
    const q = events[i]
    if (i === sealedAt && sealedCounters == null) sealedCounters = counters(i)
    // 1. manage the open trade on this event (exits use THIS event's executable side)
    if (open && tradable(q)) {
      mark(open, q)
      open.tradableSeen++
      let exit = null, reason = null
      if (open.side === 'BUY') {
        if (q.bid <= open.stop) { exit = q.bid - slipAt(q.bid); reason = 'stop' }
        else if (q.bid >= open.target) { exit = q.bid - slipAt(q.bid); reason = 'target' }
      } else {
        if (q.ask >= open.stop) { exit = q.ask + slipAt(q.ask); reason = 'stop' }
        else if (q.ask <= open.target) { exit = q.ask + slipAt(q.ask); reason = 'target' }
      }
      if (!exit && (open.tradableSeen >= maxHoldEvents || q.recvMs - open.entryMs >= s.maxHoldMs)) {
        exit = open.side === 'BUY' ? q.bid - slipAt(q.bid) : q.ask + slipAt(q.ask)
        reason = open.tradableSeen >= maxHoldEvents ? 'hold_events' : 'hold_clock'
      }
      if (exit != null) {
        const gross = open.side === 'BUY' ? exit - open.entry : open.entry - exit
        const net = gross - (commAt(open.entry) + commAt(exit))
        close(open, { ...marks(open), side: open.side, signalSeq: open.signal.seq, entrySeq: open.entrySeq, exitSeq: q.seq, entry: open.entry, exit, stop: open.stop, target: open.target, stopDistance: open.signal.stopDistance, reason, holdEvents: open.tradableSeen, holdMs: q.recvMs - open.entryMs, grossR: +(gross / open.signal.stopDistance).toFixed(4), netR: +(net / open.signal.stopDistance).toFixed(4), entryIdx: open.entryIdx, exitIdx: i })
        open = null
      }
    }
    // 2a. PR-Q3 signal TTL, model 'book': a pending signal whose fill is
    // overdue by more than the TTL expires unfilled and frees the book (a gap
    // marker's recvMs 0 is not a time). Under 'firer' the book fills it as the
    // shadow does and the refusal is judged at that fill (fillVeto).
    if (pending && bookRefuses && lf.signalTtlMs != null && q.recvMs > 0 && q.recvMs - (pending.recvMs + s.latencyMs) > lf.signalTtlMs) {
      veto('signalTtl', pending, i)
      pending = null
    }
    // 2. fill a pending signal at the first tradable event past the latency
    if (pending && !open && tradable(q) && q.recvMs >= pending.recvMs + s.latencyMs) {
      const entry = pending.side === 'BUY' ? q.ask + slipAt(q.ask) : q.bid - slipAt(q.bid)
      // PR-Q3: the refusal judged on THIS fill — the counter-trend one carried
      // from the signal, else the TTL, the price bound, the stop floor.
      const refused = lf ? (pendingVeto || fillVeto(lf, pending, entry, q.recvMs - (pending.recvMs + s.latencyMs))) : null
      if (refused && bookRefuses) {
        veto(refused, pending, i)   // 'book': nothing opens, the book is free
      } else {
        const stop = pending.side === 'BUY' ? entry - pending.stopDistance : entry + pending.stopDistance
        const target = pending.side === 'BUY' ? entry + s.targetR * pending.stopDistance : entry - s.targetR * pending.stopDistance
        open = { side: pending.side, signal: pending, entry, stop, target, entryIdx: i, entrySeq: q.seq, entryMs: q.recvMs, tradableSeen: 0, markMinR: 0, markMaxR: 0, markDrawdownR: 0 }
        mark(open, q)
        // 'firer': the book holds the trade the firer refused
        if (refused) { open.vetoedBy = refused; veto(refused, pending, i) } else filled++
      }
      pending = null
      pendingVeto = null
    }
    // 3. the strategy sees the event AFTER the trade management (no lookahead on its own fill)
    const sig = planted ? (planted.get(q.seq) || null) : oracle.feed(q)
    if (!planted && warmAt == null && oracle.warmedEvaluations > 0) warmAt = { idx: i, ms: q.recvMs }
    if (!planted && settledAt == null && oracle.warmedEvaluations > settleEvents) settledAt = { idx: i, ms: q.recvMs }
    if (sig) { signals++; signalLog.push({ idx: i, seq: sig.seq, recvMs: sig.recvMs, side: sig.side }) }
    if (sig && !open && !pending) {
      // The screen prices the round trip at the signal's MID — one price for
      // both ends, so the same number reaches the sidecar's ShadowBook.
      const mid = (sig.bid + sig.ask) / 2
      const cost = (sig.ask - sig.bid) + 2 * commAt(mid) + 2 * slipAt(mid)
      const target = s.targetR * sig.stopDistance
      if (cost > 0 && target / cost < s.minTargetToCost) { rejected.cost++; continue }
      // PR-Q3: the counter-trend veto on the reading AS OF the signal. No
      // reading grants both sides (the live feeder's fail-open) and is counted.
      // 'book' refuses the signal here; 'firer' lets the book take it (the
      // shadow does) and the firer refuses its fill — no permit for the side.
      if (lf?.counterTrend) {
        const sides = trendSidesAt(sig.recvMs)
        if (sides == null) counterTrendNoReading++
        else if (!sides.includes(sig.side)) {
          if (bookRefuses) { veto('counterTrend', sig, i); continue }
          pendingVeto = 'counterTrend'
        }
      }
      pending = sig
    } else if (sig) {
      rejected.noFill++ // a signal while a trade is open or pending is not taken
    }
  }
  if (pending) { rejected.noFill++; pending = null; pendingVeto = null }
  // A trade still open at the end of the data is marked to the last
  // executable side and reported as such — an unclosed trade must not
  // vanish from the ledger.
  if (open) {
    for (let i = events.length - 1; i >= 0; i--) {
      const q = events[i]
      if (!tradable(q)) continue
      const exit = open.side === 'BUY' ? q.bid - slipAt(q.bid) : q.ask + slipAt(q.ask)
      const gross = open.side === 'BUY' ? exit - open.entry : open.entry - exit
      const net = gross - (commAt(open.entry) + commAt(exit))
      close(open, { ...marks(open), side: open.side, signalSeq: open.signal.seq, entrySeq: open.entrySeq, exitSeq: q.seq, entry: open.entry, exit, stop: open.stop, target: open.target, stopDistance: open.signal.stopDistance, reason: 'data_end', holdEvents: open.tradableSeen, holdMs: q.recvMs - open.entryMs, grossR: +(gross / open.signal.stopDistance).toFixed(4), netR: +(net / open.signal.stopDistance).toFixed(4), entryIdx: open.entryIdx, exitIdx: i })
      break
    }
    open = null
  }
  // PR-Q1, THE LEAK FIX. This was `summarize(trades)` over EVERY trade while
  // the test block's row said `withheld` — and runTrials, the ledger and GET
  // /state/tick-research all return this summary. Withheld, it now covers the
  // trades that entered AND exited before the test block; with includeTest it
  // is every trade, exactly as before, so the replay gate's inputs for the
  // owner's confirmation run are unchanged.
  const inScope = withheld ? trades.filter(t => t.exitIdx < sealedAt) : trades
  const summary = summarize(inScope)
  summary.scope = withheld ? 'train_validation' : 'all_blocks'
  const scoped = withheld ? (sealedCounters || counters(events.length)) : counters(events.length)
  const vetoTotal = LIVE_FILTER_NAMES.reduce((a, k) => a + scoped.vetoes[k], 0)
  const diagnostics = {
    // PR-Q3: no trade because every fill the book made (or would have made)
    // was refused by a filter is `live_filtered`, never "no executable fills".
    outcome: inScope.length ? 'trades_observed' : scoped.warmedEvaluations === 0 && !planted ? 'insufficient_warmup' : scoped.signals === 0 ? 'no_signals' : scoped.costRejected === scoped.signals ? 'cost_screened'
      : lf && vetoTotal > 0 && scoped.filled === 0 ? 'live_filtered' : 'no_executable_fills',
    scope: summary.scope,
    events: scoped.events, warmupPriorEvents: Math.max(p.rangeEvents + 1, p.momentumEvents),
    acceptedEvents: scoped.acceptedEvents, warmedEvaluations: scoped.warmedEvaluations, signals: scoped.signals, oracleRejected: scoped.oracleRejected,
    costRejected: scoped.costRejected, noFill: scoped.noFill,
    note: 'Zero trades are insufficient evidence of profitability, not a measured losing strategy. Warm-up resets on stale or invalid quotes; purge may also leave no evaluable validation block.'
      + (withheld ? ' Withheld: every figure here stops at the test block, so nothing in this summary reads the test period.' : ''),
  }
  if (lf) {
    // PR-Q3: each filter's vetoes, and the accounting they must satisfy —
    // every signal is filled, cost-screened, not taken (book busy, or still
    // pending at the end of the data), vetoed, or pending at the scope's cut.
    diagnostics.model = lf.model
    diagnostics.vetoes = { ...scoped.vetoes, total: vetoTotal }
    // Fix round (checker N1): a filter this block runs that the gateway does
    // not (the signal TTL) is named, so its vetoes are never read as trades
    // the live path would have refused.
    if (lf.signalTtlMs != null) diagnostics.plannedNotLive = { signalTtl: 'planned_not_live: the gateway runs no pending-signal expiry today (maxFireDelayMs is a queue delay after the fill); these vetoes remove trades the gateway would place' }
    if (lf.counterTrend) diagnostics.counterTrendNoReading = scoped.counterTrendNoReading
    diagnostics.filled = scoped.filled
    diagnostics.pendingAtScopeEnd = scoped.pending
    diagnostics.countsAddUp = scoped.signals === scoped.filled + scoped.costRejected + scoped.noFill + vetoTotal + scoped.pending
    // 'firer': what each veto COST (principle 7) — the refused trades the book
    // held, in the same scope as the summary (entered and exited before the
    // test block when it is withheld). A positive netR is profit the filter
    // gave up; a negative one is a loss it avoided.
    if (!bookRefuses) {
      const held = withheld ? heldVetoed.filter(t => t.exitIdx < sealedAt) : heldVetoed
      const tally = (xs) => {
        let net = 0, win = 0, loss = 0, wins = 0
        for (const t of xs) { net += t.netR; if (t.netR > 0) { win += t.netR; wins++ } else loss -= t.netR }
        return { trades: xs.length, wins, netR: +net.toFixed(4), profitFactor: loss > 0 ? +(win / loss).toFixed(4) : null }
      }
      diagnostics.vetoedTrades = {
        ...tally(held),
        byFilter: Object.fromEntries(LIVE_FILTER_NAMES.map(k => [k, tally(held.filter(t => t.vetoedBy === k))])),
        note: 'The trades the shadow book held and the firer refused (model firer), closed in this scope. Not in `trades`, the summary or the blocks; a refused trade still open at the scope\'s end is counted in `vetoes` only.',
      }
    }
  }
  summary.diagnostics = diagnostics
  // The time span the scope covers (gap markers carry recvMs 0 and are skipped).
  let fromMs = null, toMs = null
  for (let i = 0; i < sealedAt; i++) { const ms = events[i].recvMs; if (ms > 0) { if (fromMs == null) fromMs = ms; toMs = ms } }
  summary.window = { fromMs, toMs, events: sealedAt }
  // Q1 FOLLOW-UP (checker B4): withheld, the train and validation rows are
  // built from the SAME in-scope trades as the summary. They were built from
  // every trade, so a trade entered before the seal and exited inside the test
  // block (the purge window is caller-set, and a hold cap counts only tradable
  // events) put a test-block price into the validation row's netR — measured:
  // purgeEvents 0 on the fixture gave the train row netR -1.1375 from a trade
  // that exited at event 260 of a test block starting at 258, while
  // summary.trades read 0.
  const blocks = blockSummaries(withheld ? inScope : trades, events.length, s.blocks, purgeEvents, { includeTest: s.includeTest === true })
  // PR-Q1: what the parity report compares with the sidecar's own record —
  // the scoped signals and trades, and when this replay had warmed and
  // settled (a replay that starts mid-stream is cold while the live strategy
  // is not, so nothing before `settledFromMs` can be compared).
  const within = (a) => a && a.idx < sealedAt ? a.ms : null
  const scopedSignals = withheld ? signalLog.filter(x => x.idx < sealedAt) : signalLog
  // A trade that entered in scope and was still open at the test block is in
  // the record by its ENTRY only (the live book took it too); its exit and
  // result are test-period information and are not written.
  // PR-Q3, model 'firer': the record is the BOOK's — the refused trades it
  // held are in it, flagged `vetoedBy`, because the shadow holds them too.
  const book = heldVetoed.length ? [...trades, ...heldVetoed].sort((a, b) => a.entryIdx - b.entryIdx) : trades
  const bookInScope = withheld ? book.filter(t => t.exitIdx < sealedAt) : book
  const straddling = withheld ? book.filter(t => t.entryIdx < sealedAt && t.exitIdx >= sealedAt) : []
  const flag = (t) => t.vetoedBy ? { vetoedBy: t.vetoedBy } : {}
  const recordTrades = [
    ...bookInScope.map(t => ({ side: t.side, signalSeq: t.signalSeq, entrySeq: t.entrySeq, entryMs: t.entryMs, exitMs: t.entryMs + t.holdMs, reason: t.reason, ...flag(t) })),
    ...straddling.map(t => ({ side: t.side, signalSeq: t.signalSeq, entrySeq: t.entrySeq, entryMs: t.entryMs, exitMs: null, reason: 'open_at_scope_end', ...flag(t) })),
  ]
  const parity = {
    scope: summary.scope, fromMs, toMs, warmFromMs: within(warmAt), settledFromMs: within(settledAt), settleEvents,
    latencyMs: s.latencyMs,
    signalsTotal: scopedSignals.length, tradesTotal: recordTrades.length,
    truncated: scopedSignals.length > PARITY_RECORD_MAX || recordTrades.length > PARITY_RECORD_MAX,
    signals: scopedSignals.slice(0, PARITY_RECORD_MAX).map(x => ({ seq: x.seq, recvMs: x.recvMs, side: x.side })),
    trades: recordTrades.slice(0, PARITY_RECORD_MAX),
  }
  if (lf) {
    // PR-Q3: which signal each filter refused, scoped like the signals (a
    // veto made at a test-block event is test-period information). A record
    // only: nothing compares it with the sidecar's fire_refused rows yet.
    const scopedVetoes = withheld ? vetoLog.filter(v => v.idx < sealedAt) : vetoLog
    parity.vetoesTotal = scopedVetoes.length
    parity.vetoes = scopedVetoes.slice(0, PARITY_RECORD_MAX).map(v => ({ seq: v.seq, recvMs: v.recvMs, side: v.side, filter: v.filter }))
    if (scopedVetoes.length > PARITY_RECORD_MAX) parity.truncated = true
    // The whole in-memory run's counts, beside `rejected`'s (withheld, the
    // persisted trial carries the scoped ones from the diagnostics instead).
    rejected.vetoed = { ...vetoed }
  }
  // PR-Q3: the whole run's refused-but-held trades (model 'firer') ride beside
  // `trades` in memory, like `trades` never persisted for a withheld trial.
  const out = { strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION, profileHash: profileHash(p), params: p, sim: s, trades, summary, blocks, rejected, parity, events: events.length }
  if (lf) out.vetoedTrades = heldVetoed
  return out
}

/** A small deterministic PRNG (mulberry32) so the bootstrap is reproducible. */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * The 5th percentile of bootstrapped mean R (plan §7 "uncertainty"): the
 * expectancy a run of this many trades cannot rule out. null below 2
 * trades. Lives here (PR-H) so the replayer's summaries and the shadow
 * portfolio (services/tick-shadow.js re-exports it) judge by ONE method —
 * the replay stage's `minExpectancyLowerR` and the shadow stage's are the
 * same statistic.
 */
export function expectancyLowerR(rs, { resamples = 1000, seed = 7, pct = 0.05 } = {}) {
  const xs = rs.filter(Number.isFinite)
  if (xs.length < 2) return null
  const rand = rng(seed)
  const means = []
  for (let b = 0; b < resamples; b++) {
    let sum = 0
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rand() * xs.length)]
    means.push(sum / xs.length)
  }
  means.sort((a, b) => a - b)
  return +means[Math.min(means.length - 1, Math.floor(pct * means.length))].toFixed(4)
}

/**
 * The Wilson score interval for a win rate (plan D2, 25-09-2026: win rate is
 * REPORTED with its interval, never judged against a pass/fail bar). k wins
 * of n trades, z = 1.96 for 95 %. Returns percentages to 2 dp, or null when
 * there are no trades. Wilson, not the normal approximation: the latter
 * collapses to [0, 0] at k = 0 and goes below 0 at k = 1 of 10, which is a
 * confident wrong interval exactly where a small sample needs an honest one.
 */
export function wilsonInterval(k, n, z = 1.96) {
  const K = Number(k), N = Number(n)
  if (!(N > 0) || !Number.isFinite(K) || K < 0 || K > N) return null
  const p = K / N, z2 = z * z
  const denom = 1 + z2 / N
  const centre = (p + z2 / (2 * N)) / denom
  const half = (z * Math.sqrt(p * (1 - p) / N + z2 / (4 * N * N))) / denom
  const pct = (x) => +(100 * x).toFixed(2)
  return { pct: pct(p), lo: pct(Math.max(0, centre - half)), hi: pct(Math.min(1, centre + half)) }
}

export function summarize(trades) {
  const n = trades.length
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR <= 0)
  const grossWin = wins.reduce((a, t) => a + t.netR, 0), grossLoss = -losses.reduce((a, t) => a + t.netR, 0)
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) { eq += t.netR; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq) }
  let markedEq = 0, markedPeak = 0, markedDD = 0
  const hasMarks = trades.length > 0 && trades.every(t => [t.markMinR, t.markMaxR, t.markDrawdownR].every(Number.isFinite))
  if (hasMarks) for (const t of trades) {
    markedDD = Math.max(markedDD, markedPeak - (markedEq + t.markMinR), t.markDrawdownR)
    markedPeak = Math.max(markedPeak, markedEq + t.markMaxR)
    markedEq += t.netR
  }
  const by = (k) => trades.filter(t => t.reason === k).length
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRate: n ? +(wins.length / n).toFixed(4) : null,
    netR: +eq.toFixed(4), avgR: n ? +(eq / n).toFixed(4) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : (grossWin > 0 ? Infinity : null),
    maxDrawdownR: +maxDD.toFixed(4),
    markToMarketDrawdownR: hasMarks ? +markedDD.toFixed(4) : null,
    drawdownBasis: 'closed_trades_only', // basis of the existing maxDrawdownR gate
    markToMarketBasis: hasMarks ? 'executable_quotes_net_of_costs' : null,
    blockExpectancy: blockExpectancyLowerR(trades.map(t => t.netR)),
    // PR-H: the bootstrap 5th-percentile expectancy in R, the replay
    // stage's `minExpectancyLowerR` when read from the TEST block
    expectancyLowerR: expectancyLowerR(trades.map(t => t.netR)),
    tailShare: n ? +(trades.filter(t => t.netR >= 2).length / n).toFixed(4) : null,
    exits: { stop: by('stop'), target: by('target'), hold_events: by('hold_events'), hold_clock: by('hold_clock'), data_end: by('data_end') },
    avgHoldEvents: n ? Math.round(trades.reduce((a, t) => a + t.holdEvents, 0) / n) : null,
    timeInMarketEvents: trades.reduce((a, t) => a + t.holdEvents, 0),
  }
}

/**
 * Chronological blocks by event index (plan §7). A trade belongs to the
 * block of its entry. PURGE across every boundary, both ways: a trade
 * entered within `purgeEvents` before a boundary is dropped (its holding
 * window may cross it, and its exit would leak the next block's prices
 * into this block's record), and a trade entered within `purgeEvents`
 * after a boundary is dropped (its feature window reaches back across it —
 * the embargo). AUDIT 11-09-2026: the previous rule dropped only a trade
 * whose exit fell inside the window after the boundary and kept one that
 * exited later — inverted — and embargoed nothing.
 *
 * The FINAL block is untouched unless `includeTest` is set: its row carries
 * `withheld: true` and no figures, so a research trial cannot consult the
 * test period by accident; the owner's one confirmation run unseals it.
 */
export function blockSummaries(trades, totalEvents, blocks, purgeEvents, { includeTest = true } = {}) {
  const out = []
  const size = Math.floor(totalEvents / blocks)
  const names = blocks === 3 ? ['train', 'validation', 'test'] : Array.from({ length: blocks }, (_, i) => `block${i + 1}`)
  for (let b = 0; b < blocks; b++) {
    const lo = b * size, hi = b === blocks - 1 ? totalEvents : (b + 1) * size
    const inBlock = trades.filter(t => t.entryIdx >= lo && t.entryIdx < hi)
    const kept = inBlock.filter(t => {
      if (b < blocks - 1 && t.entryIdx >= hi - purgeEvents) return false   // holding window may cross the boundary ahead
      if (b > 0 && t.entryIdx < lo + purgeEvents) return false             // feature window reaches back across the boundary behind
      return true
    })
    const row = { name: names[b], fromIdx: lo, toIdx: hi, purged: inBlock.length - kept.length }
    row.eligibleEntryEvents = Math.max(0, hi - lo - (b > 0 ? purgeEvents : 0) - (b < blocks - 1 ? purgeEvents : 0))
    // Q1 FOLLOW-UP (checker B4): a withheld row carries no count derived from
    // its trades — `purged` counted the trades entered in the test block's
    // first purgeEvents, which is test-period information (3 against 0
    // depending on what the test block held).
    if (b === blocks - 1 && blocks > 1 && !includeTest) { out.push({ ...row, purged: null, withheld: true, trades: null }); continue }
    out.push({ ...row, ...summarize(kept) })
  }
  return out
}

/** Candidate dependent-trade statistic, reported beside the existing gate.
 * Circular moving blocks retain adjacent outcomes; sqrt(n) is an explicit
 * default assumption, not a measured independence horizon or a daily block.
 */
export function blockExpectancyLowerR(rs, { blockLength = null, resamples = 1000, seed = 7, pct = 0.05 } = {}) {
  const xs = rs.filter(Number.isFinite)
  const length = blockLength ?? Math.ceil(Math.sqrt(xs.length))
  const result = { method: 'circular-moving-block-v1', blockLength: length, trades: xs.length, lowerR: null, resamples, seed, percentile: pct }
  if (xs.length < 2 || !Number.isInteger(length) || length < 1 || length >= xs.length || !Number.isInteger(resamples) || resamples < 1 || !(pct >= 0 && pct <= 1)) return result
  const rand = rng(seed), means = []
  for (let b = 0; b < resamples; b++) {
    let sum = 0, n = 0
    while (n < xs.length) {
      const start = Math.floor(rand() * xs.length)
      for (let j = 0; j < length && n < xs.length; j++, n++) sum += xs[(start + j) % xs.length]
    }
    means.push(sum / xs.length)
  }
  means.sort((a, b) => a - b)
  return { ...result, lowerR: +means[Math.min(means.length - 1, Math.floor(pct * means.length))].toFixed(4) }
}
