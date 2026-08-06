// ---------------------------------------------------------------------------
// agent/services/cup-handle-parity.js — do the production detector and its
// diagnostic twin agree on the SAME bars?
//
// THE FINDING THIS ANSWERS (audit Part 2, 2026-08-06). The cup-handle
// diagnostic reported 1,777 traces clearing every gate over a week in which
// production emitted ZERO `cup_handle` signals. The diagnostic's own verdict
// was "that is a bug, not a market".
//
// It could not be more than a verdict, because the two paths were never run
// against the same input. `searchCupHandle` (production) and `traceDirection`
// (diagnostic) are two hand-maintained copies of one search loop, fed from
// different call sites at different times with different bar windows. A count
// from one compared against a count from the other cannot distinguish
//
//   (a) the twin's gates differ from production's,
//   (b) the twin sees different bars,
//   (c) production fires and something downstream drops the signal,
//
// and each of those wants a different repair. This module removes the
// ambiguity by construction: ONE array of bars, both paths, one verdict.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not change a gate, loosen a
// threshold, or make either path more likely to fire. A parity harness that
// edited the thing it measures would be worthless. Everything here is a read.
// ---------------------------------------------------------------------------

import {
  computeCupHandleSignal, computeInvCupHandleSignal,
  traceCupHandleSearch, traceInvCupHandleSearch,
  GATE_ORDER,
} from './cup-handle.js'

/** The gates production applies that the diagnostic twin does NOT model. */
export const UNTRACED_GATES = Object.freeze([
  // `opts.vwapFilter` — production returns null when the close is on the wrong
  // side of VWAP. traceDirection takes no opts and cannot see this, so with
  // the filter on, every VWAP-rejected setup still reads "would have fired".
  'vwap_filter',
  // ATR: production refuses outright (`if (!a || a <= 0) return null`); the
  // twin degrades to sl=null → rr 0 → `rr_floor`. Same outcome, different
  // reported reason — a divergence in the ANSWER, not the decision.
  'atr_unavailable',
])

/**
 * Run one bar series through both paths and report where they part.
 *
 * @param {Array<{o,h,l,c,v}>} bars
 * @param {string} timeframe
 * @param {{dir?: 1|-1, opts?: object}} [options] `opts` is forwarded to the
 *   PRODUCTION path only — the twin has no equivalent, which is itself one of
 *   the things worth measuring.
 * @returns {{strategy, barCount, productionSignal, diagnosticWouldFire, agree,
 *   trendOk, blockedAt, firstDivergence, rr}}
 */
export function cupHandleParity(bars, timeframe = '1d', { dir = 1, opts = {} } = {}) {
  const strategy = dir === 1 ? 'cup_handle' : 'inv_cup_handle'
  const signal = dir === 1
    ? computeCupHandleSignal(bars, timeframe, opts)
    : computeInvCupHandleSignal(bars, timeframe, opts)
  const trace = dir === 1 ? traceCupHandleSearch(bars, timeframe) : traceInvCupHandleSearch(bars, timeframe)

  const productionSignal = signal != null
  const best = trace?.best_candidate ?? null
  // "Cleared everything" in the twin's vocabulary is `blocked_at: null` on the
  // best-progressed candidate. No candidate at all is not the same thing and
  // must not be counted as one.
  const diagnosticWouldFire = best != null && best.blocked_at == null
  const agree = productionSignal === diagnosticWouldFire

  let firstDivergence = null
  if (!agree) {
    if (diagnosticWouldFire && !productionSignal) {
      // The twin says yes, production says no. In order of likelihood given
      // what the two loops actually contain.
      if (opts?.vwapFilter) firstDivergence = 'vwap_filter'
      else if (best?.rrRatio != null && best.rrRatio < 1.5 + 0.005) firstDivergence = 'rr_floor_rounding'
      else firstDivergence = 'unexplained_twin_fires'
    } else {
      firstDivergence = 'unexplained_production_fires'
    }
  }

  return {
    strategy,
    barCount: Array.isArray(bars) ? bars.length : 0,
    productionSignal,
    diagnosticWouldFire,
    agree,
    trendOk: trace?.uptrend_ok ?? null,
    blockedAt: best?.blocked_at ?? (trace?.uptrend_ok === false ? 'trend_context' : null),
    firstDivergence,
    rr: signal?.rr ?? best?.rrRatio ?? null,
  }
}

/**
 * Parity over many series, with the disagreements kept rather than counted.
 *
 * `byGate` is ordered by GATE_ORDER so it reads as the funnel it is: each gate
 * is only reached by what survived the one above, and an unordered histogram
 * of the same numbers would invite the "this gate rarely blocks" misreading
 * when the truth is "almost nothing reaches it".
 *
 * @param {Array<{name?: string, bars: Array, timeframe?: string, dir?: 1|-1, opts?: object}>} series
 */
export function parityScan(series, { timeframe = '1d' } = {}) {
  const rows = []
  for (const s of Array.isArray(series) ? series : []) {
    const r = cupHandleParity(s.bars, s.timeframe || timeframe, { dir: s.dir ?? 1, opts: s.opts })
    rows.push({ name: s.name ?? null, ...r })
  }
  const disagreements = rows.filter(r => !r.agree)
  const byGate = {}
  for (const g of [...GATE_ORDER, 'trend_context']) {
    const n = rows.filter(r => r.blockedAt === g).length
    if (n) byGate[g] = n
  }
  return {
    n: rows.length,
    fired: rows.filter(r => r.productionSignal).length,
    twinWouldFire: rows.filter(r => r.diagnosticWouldFire).length,
    agreements: rows.length - disagreements.length,
    disagreements,
    byGate,
    // Say what was NOT compared. A parity report that omits its own blind
    // spots is the same species of claim as the summary that started all this.
    untracedGates: UNTRACED_GATES,
  }
}
