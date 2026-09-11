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
import { TickMomentumOracle, normalizeParams, profileHash, STRATEGY_ID, STRATEGY_VERSION } from './tick-strategy.js'

export const DEFAULT_SIM = Object.freeze({
  // Decision + network delay before the entry can fill. A number, or an
  // array of MEASURED samples (ms) — plan §7 "measured latency distribution
  // with a pessimistic tail": with samples the fill waits the p90 of them
  // (latencyPercentile), never their mean. The default is a fixed 250 ms,
  // reported as such (sim.latencySource) so a trial cannot read as measured.
  latencyMs: 250,
  latencyPercentile: 0.9,
  slippage: 0,                // adverse slippage per fill, wire units
  commissionPerSide: 0,       // per fill, wire units of price
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
 * simulate(events, params, sim) → { trades, summary, blocks, rejected }.
 * `events` are oracle quotes { seq, recvMs, bid, ask, snapshot, crossed, changed }
 * in order for ONE symbol; `signalsOverride` lets a test plant signals.
 */
export function simulate(events, params = {}, sim = {}, { signalsOverride = null } = {}) {
  const p = normalizeParams(params)
  const s = { ...DEFAULT_SIM, ...sim }
  const maxHoldEvents = s.maxHoldEvents ?? 4 * p.rangeEvents
  const latency = resolveLatency(s.latencyMs, s.latencyPercentile)
  s.latencyMs = latency.ms
  s.latencySource = latency.source
  const purgeEvents = s.purgeEvents ?? Math.max(p.rangeEvents + p.momentumEvents, maxHoldEvents)
  s.purgeEvents = purgeEvents
  const oracle = new TickMomentumOracle(p)
  const trades = []
  const rejected = { cost: 0, noFill: 0 }
  let open = null        // { side, signal, entry, stop, target, entryIdx, entryMs, tradableSeen }
  let pending = null     // a signal waiting for its fill
  const planted = signalsOverride ? new Map(signalsOverride.map(sg => [sg.seq, sg])) : null
  for (let i = 0; i < events.length; i++) {
    const q = events[i]
    // 1. manage the open trade on this event (exits use THIS event's executable side)
    if (open && tradable(q)) {
      open.tradableSeen++
      let exit = null, reason = null
      if (open.side === 'BUY') {
        if (q.bid <= open.stop) { exit = q.bid - s.slippage; reason = 'stop' }
        else if (q.bid >= open.target) { exit = q.bid - s.slippage; reason = 'target' }
      } else {
        if (q.ask >= open.stop) { exit = q.ask + s.slippage; reason = 'stop' }
        else if (q.ask <= open.target) { exit = q.ask + s.slippage; reason = 'target' }
      }
      if (!exit && (open.tradableSeen >= maxHoldEvents || q.recvMs - open.entryMs >= s.maxHoldMs)) {
        exit = open.side === 'BUY' ? q.bid - s.slippage : q.ask + s.slippage
        reason = open.tradableSeen >= maxHoldEvents ? 'hold_events' : 'hold_clock'
      }
      if (exit != null) {
        const gross = open.side === 'BUY' ? exit - open.entry : open.entry - exit
        const net = gross - 2 * s.commissionPerSide
        trades.push({ side: open.side, signalSeq: open.signal.seq, entrySeq: open.entrySeq, exitSeq: q.seq, entry: open.entry, exit, stop: open.stop, target: open.target, stopDistance: open.signal.stopDistance, reason, holdEvents: open.tradableSeen, holdMs: q.recvMs - open.entryMs, grossR: +(gross / open.signal.stopDistance).toFixed(4), netR: +(net / open.signal.stopDistance).toFixed(4), entryIdx: open.entryIdx, exitIdx: i })
        open = null
      }
    }
    // 2. fill a pending signal at the first tradable event past the latency
    if (pending && !open && tradable(q) && q.recvMs >= pending.recvMs + s.latencyMs) {
      const entry = pending.side === 'BUY' ? q.ask + s.slippage : q.bid - s.slippage
      const stop = pending.side === 'BUY' ? entry - pending.stopDistance : entry + pending.stopDistance
      const target = pending.side === 'BUY' ? entry + s.targetR * pending.stopDistance : entry - s.targetR * pending.stopDistance
      open = { side: pending.side, signal: pending, entry, stop, target, entryIdx: i, entrySeq: q.seq, entryMs: q.recvMs, tradableSeen: 0 }
      pending = null
    }
    // 3. the strategy sees the event AFTER the trade management (no lookahead on its own fill)
    const sig = planted ? (planted.get(q.seq) || null) : oracle.feed(q)
    if (sig && !open && !pending) {
      const cost = (sig.ask - sig.bid) + 2 * s.commissionPerSide + 2 * s.slippage
      const target = s.targetR * sig.stopDistance
      if (cost > 0 && target / cost < s.minTargetToCost) { rejected.cost++; continue }
      pending = sig
    } else if (sig) {
      rejected.noFill++ // a signal while a trade is open or pending is not taken
    }
  }
  if (pending) rejected.noFill++
  // A trade still open at the end of the data is marked to the last
  // executable side and reported as such — an unclosed trade must not
  // vanish from the ledger.
  if (open) {
    for (let i = events.length - 1; i >= 0; i--) {
      const q = events[i]
      if (!tradable(q)) continue
      const exit = open.side === 'BUY' ? q.bid - s.slippage : q.ask + s.slippage
      const gross = open.side === 'BUY' ? exit - open.entry : open.entry - exit
      const net = gross - 2 * s.commissionPerSide
      trades.push({ side: open.side, signalSeq: open.signal.seq, entrySeq: open.entrySeq, exitSeq: q.seq, entry: open.entry, exit, stop: open.stop, target: open.target, stopDistance: open.signal.stopDistance, reason: 'data_end', holdEvents: open.tradableSeen, holdMs: q.recvMs - open.entryMs, grossR: +(gross / open.signal.stopDistance).toFixed(4), netR: +(net / open.signal.stopDistance).toFixed(4), entryIdx: open.entryIdx, exitIdx: i })
      break
    }
    open = null
  }
  const summary = summarize(trades)
  const blocks = blockSummaries(trades, events.length, s.blocks, purgeEvents, { includeTest: s.includeTest === true })
  return { strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION, profileHash: profileHash(p), params: p, sim: s, trades, summary, blocks, rejected, events: events.length }
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

export function summarize(trades) {
  const n = trades.length
  const wins = trades.filter(t => t.netR > 0), losses = trades.filter(t => t.netR <= 0)
  const grossWin = wins.reduce((a, t) => a + t.netR, 0), grossLoss = -losses.reduce((a, t) => a + t.netR, 0)
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) { eq += t.netR; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq) }
  const by = (k) => trades.filter(t => t.reason === k).length
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRate: n ? +(wins.length / n).toFixed(4) : null,
    netR: +eq.toFixed(4), avgR: n ? +(eq / n).toFixed(4) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : (grossWin > 0 ? Infinity : null),
    maxDrawdownR: +maxDD.toFixed(4),
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
    if (b === blocks - 1 && blocks > 1 && !includeTest) { out.push({ ...row, withheld: true, trades: null }); continue }
    out.push({ ...row, ...summarize(kept) })
  }
  return out
}
