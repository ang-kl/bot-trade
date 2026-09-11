// agent/lib/tick-strategy.js — P4: the REFERENCE ORACLE for
// tick_momentum_breakout v1 (docs/tick-momentum/plan.md §5, §6; register
// TM-01, TM-03, TM-04). A deliberately plain implementation — every window
// recomputed from arrays on every event — whose only job is to be easy to
// audit and to agree, signal for signal, with the fast incremental C++
// implementation (cpp-exec/src/tick_strategy.cpp) on the checked-in
// fixtures. It depends on nothing but quotes: no candles, no LLM, no clock
// beyond the receive time used for the staleness bound.
//
// Units. Prices are wire integers (cTrader's 1e-5). The midpoint is kept
// as TWICE-mid (bid + ask) so half increments stay integers; ranges,
// movement D, volatility V and the buffer B are in twice-mid units; the
// stop distance is returned in price units (divided by two).
//
// The accepted event: a two-sided, uncrossed, non-snapshot quote whose bid
// or ask changed, with spread within the absolute ceiling and receive gap
// within the age bound. Everything else warms nothing and counts nowhere.

import { createHash } from 'node:crypto'

export const STRATEGY_ID = 'tick_momentum_breakout'
export const STRATEGY_VERSION = 'v1'

export const DEFAULT_PARAMS = Object.freeze({
  rangeEvents: 256,            // N
  momentumEvents: 64,          // M (N/4)
  minEfficiency: 0.4,          // E
  spreadBufferMult: 0.5,       // k_spread
  confirmations: 2,            // events including the crossing
  stopVolMult: 2,              // stop = max(stopVolMult × V / 2, minStop) in price units
  minStopPrice: 1,             // broker minimum distance (wire units)
  priceIncrement: 1,           // permitted price increment (wire units) — from broker metadata, never the wire scale
  maxSpread: 1000000,          // absolute spread ceiling (wire units)
  maxQuoteAgeMs: 60000,        // receive gap that invalidates the setup
  expiryEvents: 256,           // N: untriggered setup expires
  rearmCooldownEvents: 64,     // N/4
})

export function normalizeParams(p = {}) {
  const out = { ...DEFAULT_PARAMS, ...p }
  if (p.rangeEvents && p.momentumEvents == null) out.momentumEvents = Math.max(1, Math.floor(out.rangeEvents / 4))
  if (p.rangeEvents && p.expiryEvents == null) out.expiryEvents = out.rangeEvents
  if (p.rangeEvents && p.rearmCooldownEvents == null) out.rearmCooldownEvents = Math.max(1, Math.floor(out.rangeEvents / 4))
  return out
}

/** The profile hash: strategy id + version + the parameters, canonical order. */
export function profileHash(params) {
  return profileHashFull(params).slice(0, 16)
}

/** P5: the full sha256 (64 hex) the engine record pins (ENGINE_STATUS_SHAPE
 *  profileHash is HEX64); the sidecar and the trial ledger print its first
 *  16 characters, so a pinned record matches a reported profile by prefix. */
export function profileHashFull(params) {
  const p = normalizeParams(params)
  const canon = JSON.stringify({ id: STRATEGY_ID, version: STRATEGY_VERSION, ...Object.fromEntries(Object.keys(p).sort().map(k => [k, p[k]])) })
  return createHash('sha256').update(canon).digest('hex')
}

/** The profile id the engine record carries beside the hash: strategy@version. */
export const PROFILE_ID = `${STRATEGY_ID}@${STRATEGY_VERSION}`

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const n = s.length
  return n === 0 ? 0 : (n % 2 ? s[(n - 1) / 2] : Math.floor((s[n / 2 - 1] + s[n / 2]) / 2))
}

/**
 * One symbol's strategy. feed(q) with q = { seq, recvMs, bid, ask, snapshot,
 * crossed, changed } (bid/ask null when absent) → a signal object or null.
 * `state` is readable for tests: WARMING | ARMED | CONFIRMING | SIGNALLED | EXPIRED.
 */
export class TickMomentumOracle {
  constructor(params = {}) {
    this.p = normalizeParams(params)
    this.hash = profileHash(this.p)
    this.mids = []     // accepted twice-mids, oldest first
    this.bids = []
    this.asks = []
    this.spreads = []
    this.accepted = 0
    this.lastRecvMs = null
    this.state = 'WARMING'
    this.setup = null   // frozen at arm: { H, L, bidHigh, bidLow, askHigh, askLow, B, armedAt, id, confirmed, dir }
    this.setupSeq = 0
    this.signalledAt = null
    this.expiredAt = null
    this.rejected = { invalid: 0, spread: 0, stale: 0, repeat: 0 }
  }

  _accept(q) {
    if (q.bid == null || q.ask == null || q.snapshot || q.crossed) { this.rejected.invalid++; return false }
    if (!q.changed) { this.rejected.repeat++; return false }
    if (q.ask - q.bid > this.p.maxSpread) { this.rejected.spread++; return false }
    if (this.lastRecvMs != null && q.recvMs - this.lastRecvMs > this.p.maxQuoteAgeMs) { this.rejected.stale++; return 'stale' }
    return true
  }

  _invalidate() {
    // Invalid or stale data invalidates the setup and the warm-up.
    this.mids = []; this.bids = []; this.asks = []; this.spreads = []
    this.setup = null; this.state = 'WARMING'
  }

  feed(q) {
    const { p } = this
    const acc = this._accept(q)
    if (acc === 'stale') { this._invalidate(); this.lastRecvMs = q.recvMs; return null }
    if (!acc) {
      // Plan §4/§5: a snapshot (or a continuity break marked as one), a
      // one-sided update or a crossed quote invalidates the setup and the
      // warm-up; a repeat or an over-wide spread merely does not count.
      if (q.bid == null || q.ask == null || q.snapshot || q.crossed) this._invalidate()
      return null
    }
    this.lastRecvMs = q.recvMs
    const N = p.rangeEvents, M = p.momentumEvents
    const mid2 = q.bid + q.ask
    const spread = q.ask - q.bid
    // Windows over the PRIOR events (the candidate is excluded).
    const priorMids = this.mids
    const warm = priorMids.length >= N + 1 && priorMids.length >= M
    let signal = null
    if (warm) {
      const lastN = priorMids.slice(-N)
      const H = Math.max(...lastN), L = Math.min(...lastN)
      const diffsN = []
      for (let i = priorMids.length - N; i < priorMids.length; i++) diffsN.push(priorMids[i] - priorMids[i - 1])
      const V = Math.sqrt(M * diffsN.reduce((s, d) => s + d * d, 0) / diffsN.length)
      const medSpread = median(this.spreads.slice(-N))
      const B = Math.max(4 * p.priceIncrement, Math.round(p.spreadBufferMult * 2 * medSpread))
      // Movement over M events uses the candidate's own mid and diff.
      const seq = [...priorMids.slice(-M), mid2]
      const D = mid2 - seq[0]
      let sumAbs = 0
      for (let i = 1; i < seq.length; i++) sumAbs += Math.abs(seq[i] - seq[i - 1])
      const E = sumAbs > 0 ? Math.abs(D) / sumAbs : 0
      this.accepted++
      const ev = this.accepted

      if (this.state === 'SIGNALLED') {
        const s = this.setup
        if (mid2 >= s.L && mid2 <= s.H && ev - this.signalledAt >= p.rearmCooldownEvents) { this.setup = null; this.state = 'WARMING' }
      } else if (this.state === 'EXPIRED') {
        if (ev - this.expiredAt >= Math.max(1, Math.floor(p.rangeEvents / 4))) { this.setup = null; this.state = 'WARMING' }
      }

      if (this.state === 'WARMING' && this.setup == null) {
        // Arm only inside a positive prior range.
        if (H > L && mid2 >= L && mid2 <= H && Number.isFinite(V) && V > 0) {
          const lastBids = this.bids.slice(-N), lastAsks = this.asks.slice(-N)
          this.setup = { H, L, bidHigh: Math.max(...lastBids), bidLow: Math.min(...lastBids), askHigh: Math.max(...lastAsks), askLow: Math.min(...lastAsks), B, armedAt: ev, id: ++this.setupSeq, confirmed: 0, dir: null }
          this.state = 'ARMED'
        }
      } else if (this.state === 'ARMED' || this.state === 'CONFIRMING') {
        const s = this.setup
        if (ev - s.armedAt > p.expiryEvents && this.state === 'ARMED') {
          this.state = 'EXPIRED'; this.expiredAt = ev
        } else {
          const longOk = mid2 > s.H + s.B && D > 0 && E >= p.minEfficiency && q.bid > s.bidHigh
          const shortOk = mid2 < s.L - s.B && D < 0 && E >= p.minEfficiency && q.ask < s.askLow
          const dir = longOk ? 'BUY' : shortOk ? 'SELL' : null
          if (dir && (s.dir == null || s.dir === dir)) {
            s.dir = dir
            s.confirmed += 1 // the crossing counts as confirmation event 1
            this.state = 'CONFIRMING'
            if (s.confirmed >= p.confirmations) {
              const stopDist = Math.max(p.minStopPrice, Math.round(p.stopVolMult * V / 2))
              // PR-D: the direction is stated where it is decided — the frozen boundary the mid broke.
              signal = { symbolId: q.symbolId ?? null, side: dir, dirReason: dir === 'BUY' ? 'tick:break_high' : 'tick:break_low', seq: q.seq, recvMs: q.recvMs, trigger2: mid2, bid: q.bid, ask: q.ask, stopDistance: stopDist, spread, V: +V.toFixed(6), D, E: +E.toFixed(6), H: s.H, L: s.L, B: s.B, setupId: s.id, profileHash: this.hash, confirmations: s.confirmed }
              this.state = 'SIGNALLED'; this.signalledAt = ev
            }
          } else {
            // Retracement or a failed condition resets the confirmation count
            // (the frozen setup stays until it expires).
            s.confirmed = 0; s.dir = null
            if (this.state === 'CONFIRMING') this.state = 'ARMED'
            if (ev - s.armedAt > p.expiryEvents) { this.state = 'EXPIRED'; this.expiredAt = ev }
          }
        }
      }
    } else {
      this.accepted++
    }
    this.mids.push(mid2); this.bids.push(q.bid); this.asks.push(q.ask); this.spreads.push(spread)
    const keep = N + M + 2
    if (this.mids.length > keep) { this.mids.splice(0, this.mids.length - keep); this.bids.splice(0, this.bids.length - keep); this.asks.splice(0, this.asks.length - keep); this.spreads.splice(0, this.spreads.length - keep) }
    return signal
  }
}

/** Runs the oracle over an event list (one symbol) and returns every signal. */
export function runOracle(events, params = {}) {
  const o = new TickMomentumOracle(params)
  const out = []
  for (const q of events) { const s = o.feed(q); if (s) out.push(s) }
  return { signals: out, rejected: o.rejected, accepted: o.accepted, profileHash: o.hash }
}
