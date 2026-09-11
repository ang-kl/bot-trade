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
  latencyMs: 250,             // decision + network delay before the entry can fill
  slippage: 0,                // adverse slippage per fill, wire units
  commissionPerSide: 0,       // per fill, wire units of price
  targetR: 3,                 // gross target as a multiple of the stop distance
  minTargetToCost: 3,         // screening: target / round-trip cost (spread + 2·commission + 2·slippage)
  maxHoldEvents: null,        // default 4 × rangeEvents
  maxHoldMs: 6 * 3600_000,    // finite clock cap (a halted feed never delivers the event exit)
  blocks: 3,                  // chronological train / validation / test
})

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
  const blocks = blockSummaries(trades, events.length, s.blocks, maxHoldEvents)
  return { strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION, profileHash: profileHash(p), params: p, sim: s, trades, summary, blocks, rejected, events: events.length }
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
    tailShare: n ? +(trades.filter(t => t.netR >= 2).length / n).toFixed(4) : null,
    exits: { stop: by('stop'), target: by('target'), hold_events: by('hold_events'), hold_clock: by('hold_clock'), data_end: by('data_end') },
    avgHoldEvents: n ? Math.round(trades.reduce((a, t) => a + t.holdEvents, 0) / n) : null,
    timeInMarketEvents: trades.reduce((a, t) => a + t.holdEvents, 0),
  }
}

/** Chronological blocks by event index; a trade belongs to the block of its entry and trades that straddle a boundary within the purge window are dropped. */
export function blockSummaries(trades, totalEvents, blocks, purgeEvents) {
  const out = []
  const size = Math.floor(totalEvents / blocks)
  const names = blocks === 3 ? ['train', 'validation', 'test'] : Array.from({ length: blocks }, (_, i) => `block${i + 1}`)
  for (let b = 0; b < blocks; b++) {
    const lo = b * size, hi = b === blocks - 1 ? totalEvents : (b + 1) * size
    const inBlock = trades.filter(t => t.entryIdx >= lo && t.entryIdx < hi)
    const purged = inBlock.filter(t => t.exitIdx >= hi && b < blocks - 1 && (t.exitIdx - hi) < purgeEvents ? false : true)
    out.push({ name: names[b], fromIdx: lo, toIdx: hi, purged: inBlock.length - purged.length, ...summarize(purged) })
  }
  return out
}
