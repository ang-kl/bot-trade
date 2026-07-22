// ---------------------------------------------------------------------------
// agent/services/cup-handle.js — "Cup & Handle" breakout strategy, both the
// classic bullish pattern AND its bearish mirror ("Inverted Cup & Handle").
// SEPARATE from the fib 61.8% fade: own module, own toggle, own label.
// Deterministic — no LLM.
//
// Classic (bullish, video spec, owner-approved 2026-07-09):
//   1. uptrend        — close above SMA 20, 50 and 200
//   2. healthy cup    — rounded bottom (≥3 bars near the low, not a V),
//                       depth 15–33% of the rim, volume: sell-off > bottom,
//                       recovery > bottom (spike → dry-up → rebuild)
//   3. tight handle   — drift holds the upper ⅓ of the cup, 2–15 bars,
//                       volume tapering vs the recovery leg
//   4. room to run    — right rim at/near the window's highest high
//   5. sector aligned — NOT computable from broker data; intentionally
//                       omitted (do it on your stock screener) — never faked
//   Trade plan: entry = close breaking the prior-2-bar high AND the handle
//   high on expanding volume · SL = entry − 1.5×ATR(14) · TP1 = handle high
//   + cup depth (measured move) · take only if RR ≥ 1.5.
//
// Inverted (bearish, owner-directed 2026-07-22, "redo the depth-gated so it
// can fire Cup & Handle and inverted Cup & Handle"): the same checklist
// mirrored top-for-bottom and direction-for-direction — a rounded TOP
// (dome) instead of a rounded bottom, a handle drifting in the LOWER third
// of the dome instead of the upper third, and a breakdown below the
// prior-2-bar low AND the handle low on expanding volume, targeting the
// symmetric measured move DOWN. Same DEPTH_MIN/DEPTH_MAX gate, same
// ROUND_BOTTOM_BARS/HANDLE bounds, same BREAKOUT_VOL_X and MIN_RR floor —
// one set of thresholds governs both directions, per the owner's request.
// Both directions share ONE search function (searchCupHandle) parameterized
// by `dir` (1 = classic, -1 = inverted) so the gating logic can never drift
// out of sync between them.
// ---------------------------------------------------------------------------

import { atr, vwap } from './fib-strategy.js'

const MIN_BARS = 210            // SMA200 + headroom
const CUP_MIN = 15              // cup length bounds (bars)
const CUP_MAX = 120
const HANDLE_MIN = 2
const HANDLE_MAX = 15
const DEPTH_MIN = 0.15          // cup depth as fraction of rim price — shared by both directions
const DEPTH_MAX = 0.33
const ROUND_BOTTOM_BARS = 3     // bars that must sit near the extreme (U, not V — or dome, not spike)
const BREAKOUT_VOL_X = 1.3      // breakout volume vs handle average
const MIN_RR = 1.5

export function sma(bars, period, endIdx = bars.length - 1) {
  if (endIdx + 1 < period) return null
  let s = 0
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += bars[i].c
  return s / period
}

const avgVol = (bars, from, to) => {
  if (to < from) return 0
  let s = 0
  for (let i = from; i <= to; i++) s += bars[i].v || 0
  return s / (to - from + 1)
}
const idxMaxHigh = (bars, from, to) => {
  let best = from
  for (let i = from; i <= to; i++) if (bars[i].h > bars[best].h) best = i
  return best
}
const idxMinLow = (bars, from, to) => {
  let best = from
  for (let i = from; i <= to; i++) if (bars[i].l < bars[best].l) best = i
  return best
}

/**
 * Core search shared by both directions. dir=1 looks for the classic
 * bullish cup & handle (rim=high, extreme=low, breaks UP); dir=-1 looks for
 * the inverted bearish cup & handle (rim=low, extreme=high, breaks DOWN).
 * Returns a signal object (same contract as computeFibSignal) or null.
 */
function searchCupHandle(bars, timeframe, opts, dir) {
  const last = bars.length - 1
  const close = bars[last].c

  const s20 = sma(bars, 20); const s50 = sma(bars, 50); const s200 = sma(bars, 200)
  if (s20 == null) return null
  const trendOk = dir === 1
    ? (close > s20 && close > s50 && close > s200)
    : (close < s20 && close < s50 && close < s200)
  if (!trendOk) return null

  for (let handleLen = HANDLE_MIN; handleLen <= HANDLE_MAX; handleLen++) {
    const rr = last - handleLen // right-rim candidate index
    if (rr < CUP_MIN + 10) break
    const handleSlice = bars.slice(rr + 1, last)
    // Right rim must be the local extreme vs the handle after it — a local
    // HIGH for the classic pattern (handle can't make a new high), a local
    // LOW for the inverted one (handle can't make a new low).
    const handleExtreme = dir === 1
      ? Math.max(...handleSlice.map(b => b.h), -Infinity)
      : Math.min(...handleSlice.map(b => b.l), Infinity)
    const rimHolds = dir === 1 ? bars[rr].h > handleExtreme : bars[rr].l < handleExtreme
    if (!rimHolds) continue

    // Cup: LEFT RIM FIRST — a prior extreme roughly level with the right
    // rim — then the cup's own extreme (bottom for classic, top for
    // inverted) BETWEEN the rims. Searching the whole window is wrong: in
    // a trend, the oldest extreme is stale price, not the cup.
    let lr = -1; let ex = -1; let depthAbs = 0; let depth = 0
    for (let cand = rr - CUP_MIN; cand >= Math.max(rr - CUP_MAX, 0); cand--) {
      const candRim = dir === 1 ? bars[cand].h : bars[cand].l
      const rrRim = dir === 1 ? bars[rr].h : bars[rr].l
      // rims roughly level: left rim within the same tolerance band either
      // direction — this is a leveling check, not a price-mirror, so the
      // same relative band applies to highs (classic) or lows (inverted).
      if (candRim < rrRim * 0.95 || candRim > rrRim * 1.15) continue
      const exIdx = dir === 1 ? idxMinLow(bars, cand + 1, rr - 1) : idxMaxHigh(bars, cand + 1, rr - 1)
      const rim = dir === 1 ? Math.min(bars[cand].h, bars[rr].h) : Math.max(bars[cand].l, bars[rr].l)
      const exPrice = dir === 1 ? bars[exIdx].l : bars[exIdx].h
      const dAbs = dir === 1 ? rim - exPrice : exPrice - rim
      const d = dAbs / rim
      if (d < DEPTH_MIN || d > DEPTH_MAX) continue
      // the extreme must sit in the middle half of the cup, not hug a rim
      const posInCup = (exIdx - cand) / (rr - cand)
      if (posInCup < 0.2 || posInCup > 0.8) continue
      lr = cand; ex = exIdx; depthAbs = dAbs; depth = d
      break
    }
    if (lr < 0) continue
    const cupLen = rr - lr
    const extremePrice = dir === 1 ? bars[ex].l : bars[ex].h
    const rim = dir === 1 ? Math.min(bars[lr].h, bars[rr].h) : Math.max(bars[lr].l, bars[rr].l)

    // 2 — rounded extreme: several bars near it, not one V-spike (or dome-spike)
    const nearExtreme = dir === 1 ? extremePrice + 0.15 * depthAbs : extremePrice - 0.15 * depthAbs
    let roundBars = 0
    for (let i = lr; i <= rr; i++) {
      const touches = dir === 1 ? bars[i].l <= nearExtreme : bars[i].h >= nearExtreme
      if (touches) roundBars++
    }
    if (roundBars < ROUND_BOTTOM_BARS) continue

    // 2 — volume shape: the move INTO the extreme and OUT of it both carry
    // more volume than the extreme itself (capitulation/blow-off → quiet
    // base/dome → expanding move away — same shape, either direction).
    const third = Math.max(1, Math.floor(cupLen / 3))
    const vInto = avgVol(bars, lr, lr + third)
    const vAtExtreme = avgVol(bars, ex - Math.floor(third / 2), ex + Math.floor(third / 2))
    const vOut = avgVol(bars, rr - third, rr)
    const volumeShapeOk = vAtExtreme > 0 ? (vInto > vAtExtreme && vOut > vAtExtreme) : false

    // 3 — tight handle: holds the outer ⅓ of the cup (upper for classic,
    // lower for inverted), volume tapering
    const handleFar = dir === 1
      ? Math.min(...bars.slice(rr + 1, last).map(bb => bb.l), Infinity)
      : Math.max(...bars.slice(rr + 1, last).map(bb => bb.h), -Infinity)
    const handleOk = dir === 1 ? handleFar >= rim - depthAbs / 3 : handleFar <= rim + depthAbs / 3
    if (!handleOk) continue
    const vHandle = avgVol(bars, rr + 1, last - 1)
    const handleTaperOk = vOut > 0 ? vHandle < vOut : false

    // Entry trigger on the LAST bar: breaks the prior-2-bar extreme AND the
    // handle extreme, with volume expansion vs the handle.
    const prior2Extreme = dir === 1
      ? Math.max(bars[last - 1].h, bars[last - 2].h)
      : Math.min(bars[last - 1].l, bars[last - 2].l)
    const breakoutLevel = dir === 1
      ? Math.max(prior2Extreme, handleExtreme === -Infinity ? 0 : handleExtreme)
      : Math.min(prior2Extreme, handleExtreme === Infinity ? Infinity : handleExtreme)
    const breakoutTriggered = dir === 1 ? close > breakoutLevel : close < breakoutLevel
    if (!breakoutTriggered) continue
    const breakoutVolX = vHandle > 0 ? (bars[last].v || 0) / vHandle : 0
    if (breakoutVolX < BREAKOUT_VOL_X) continue

    // 4 — room to run: right rim at/near the window's most extreme point
    // (highest high for classic, lowest low for inverted)
    const windowExtreme = dir === 1
      ? bars[idxMaxHigh(bars, 0, last)].h
      : bars[idxMinLow(bars, 0, last)].l
    const roomToRun = dir === 1 ? bars[rr].h >= 0.98 * windowExtreme : bars[rr].l <= 1.02 * windowExtreme

    // Optional VWAP confluence: longs only ABOVE value, shorts only BELOW
    if (opts.vwapFilter) {
      const vw = vwap(bars, lr)
      if (vw == null) return null
      if (dir === 1 ? close < vw : close > vw) return null
    }

    const entry = close
    const a = atr(bars)
    if (!a || a <= 0) return null
    const sl = dir === 1 ? entry - 1.5 * a : entry + 1.5 * a
    const tp1 = dir === 1
      ? Math.max(bars[rr].h, handleExtreme) + depthAbs
      : Math.min(bars[rr].l, handleExtreme) - depthAbs
    const slDist = Math.abs(entry - sl)
    const rrRatio = slDist > 0 ? Math.abs(tp1 - entry) / slDist : 0
    if (rrRatio < MIN_RR) continue

    // Conviction: 8 when every core check passed (matches the autotrade
    // bar), +1 room-to-run, +1 strong breakout volume; soft checks that
    // failed pull it below the bar instead of silently passing.
    let conviction = 8
    if (!volumeShapeOk) conviction -= 2
    if (!handleTaperOk) conviction -= 1
    if (roomToRun) conviction += 1
    if (breakoutVolX >= 1.8) conviction += 1
    conviction = Math.max(0, Math.min(10, conviction))

    const bias = dir === 1 ? 'long' : 'short'
    const strategy = dir === 1 ? 'cup_handle' : 'inv_cup_handle'
    return {
      bias,
      entry,
      sl,
      tp1,
      tp2: dir === 1 ? tp1 + depthAbs * 0.5 : tp1 - depthAbs * 0.5,
      conviction,
      rr: Math.round(rrRatio * 100) / 100,
      timeframe,
      time_cap_minutes: null, // swing trade — no time cap
      strategy,
      cup: {
        leftRim: dir === 1 ? bars[lr].h : bars[lr].l,
        extreme: extremePrice,
        rightRim: dir === 1 ? bars[rr].h : bars[rr].l,
        depthPct: Math.round(depth * 1000) / 10,
        cupBars: cupLen,
        handleBars: handleLen,
        shape: dir === 1 ? 'cup' : 'inverted_cup',
      },
      thesis: dir === 1
        ? `Cup & Handle breakout on ${timeframe} — cup ${bars[lr].h}→${extremePrice}→${bars[rr].h} (depth ${Math.round(depth * 100)}%, ${cupLen} bars), ${handleLen}-bar handle, breakout vol ${Math.round(breakoutVolX * 10) / 10}× handle. Target ${Math.round(tp1 * 100000) / 100000} (measured move), SL 1.5×ATR.`
        : `Inverted Cup & Handle breakdown on ${timeframe} — dome ${bars[lr].l}→${extremePrice}→${bars[rr].l} (depth ${Math.round(depth * 100)}%, ${cupLen} bars), ${handleLen}-bar handle, breakdown vol ${Math.round(breakoutVolX * 10) / 10}× handle. Target ${Math.round(tp1 * 100000) / 100000} (measured move), SL 1.5×ATR.`,
    }
  }
  return null
}

/**
 * Detect a completed classic (bullish) cup-and-handle whose breakout is the
 * LAST closed bar. Same contract as computeFibSignal: null, or a signal
 * object the loop, risk gate and backtest already understand. Unchanged
 * behavior from before the inverted pattern was added — own registry key
 * ('cup_handle'), own toggle.
 */
export function computeCupHandleSignal(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  return searchCupHandle(bars, timeframe, opts, 1)
}

/**
 * Detect a completed INVERTED (bearish) cup-and-handle whose breakdown is
 * the LAST closed bar — the mirror pattern, own registry key
 * ('inv_cup_handle'), own toggle, so it can be armed/disarmed independently
 * of the classic pattern.
 */
export function computeInvCupHandleSignal(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  return searchCupHandle(bars, timeframe, opts, -1)
}

// Gate order matters here ONLY for ranking near-misses: a candidate that
// gets further down this list is a more useful "why didn't it fire" answer
// than one that failed on gate 1. Not used by computeCupHandleSignal itself.
const GATE_RANK = {
  no_cup_structure: 0,
  round_bottom: 1,
  handle_range: 2,
  breakout_not_triggered: 3,
  breakout_volume: 4,
  rr_floor: 5,
  null: 6, // would have fired
}

/**
 * Diagnostic twin of searchCupHandle's search loop (Cup & Handle Silence
 * Diagnostics spec, Part A). Never returns a trade signal — instead
 * reports, per scan cycle, WHICH gate stopped the best-progressed
 * candidate, so "hasn't fired in a week" becomes a diagnosis instead of a
 * guess. searchCupHandle/computeCupHandleSignal/computeInvCupHandleSignal
 * are untouched by this — additive only. Shared by both directions'
 * public trace exports below.
 */
function traceDirection(bars, timeframe, dir) {
  const scanned_at = new Date().toISOString()
  const bias = dir === 1 ? 'long' : 'short'
  const base = { timeframe, scanned_at, bias, uptrend_ok: false, cup_found: false, best_candidate: null }
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return base

  const last = bars.length - 1
  const close = bars[last].c
  const s20 = sma(bars, 20); const s50 = sma(bars, 50); const s200 = sma(bars, 200)
  // Field kept named `uptrend_ok` for both directions — pre-dates this
  // pattern (DB column, existing classic-direction tests) — read it as
  // "required trend context holds": above all 3 SMAs for the classic
  // search, below all 3 for the inverted one (see `bias`).
  const uptrend_ok = s20 != null && (dir === 1
    ? (close > s20 && close > s50 && close > s200)
    : (close < s20 && close < s50 && close < s200))
  if (!uptrend_ok) return { ...base, uptrend_ok }

  let best = null
  const considerCandidate = (c) => {
    const rank = GATE_RANK[c.blocked_at ?? 'null']
    if (!best || rank > GATE_RANK[best.blocked_at ?? 'null']) best = c
  }

  for (let handleLen = HANDLE_MIN; handleLen <= HANDLE_MAX; handleLen++) {
    const rr = last - handleLen
    if (rr < CUP_MIN + 10) break
    const handleSlice = bars.slice(rr + 1, last)
    const handleExtreme = dir === 1
      ? Math.max(...handleSlice.map(b => b.h), -Infinity)
      : Math.min(...handleSlice.map(b => b.l), Infinity)
    const rimHolds = dir === 1 ? bars[rr].h > handleExtreme : bars[rr].l < handleExtreme
    if (!rimHolds) {
      considerCandidate({ handleLen, cupLen: null, depthPct: null, posInCup: null, blocked_at: 'no_cup_structure' })
      continue
    }

    let lr = -1; let ex = -1; let depthAbs = 0; let depth = 0
    for (let cand = rr - CUP_MIN; cand >= Math.max(rr - CUP_MAX, 0); cand--) {
      const candRim = dir === 1 ? bars[cand].h : bars[cand].l
      const rrRim = dir === 1 ? bars[rr].h : bars[rr].l
      if (candRim < rrRim * 0.95 || candRim > rrRim * 1.15) continue
      const exIdx = dir === 1 ? idxMinLow(bars, cand + 1, rr - 1) : idxMaxHigh(bars, cand + 1, rr - 1)
      const rim = dir === 1 ? Math.min(bars[cand].h, bars[rr].h) : Math.max(bars[cand].l, bars[rr].l)
      const exPrice = dir === 1 ? bars[exIdx].l : bars[exIdx].h
      const dAbs = dir === 1 ? rim - exPrice : exPrice - rim
      const d = dAbs / rim
      if (d < DEPTH_MIN || d > DEPTH_MAX) continue
      const posInCup = (exIdx - cand) / (rr - cand)
      if (posInCup < 0.2 || posInCup > 0.8) continue
      lr = cand; ex = exIdx; depthAbs = dAbs; depth = d
      break
    }
    if (lr < 0) {
      considerCandidate({ handleLen, cupLen: null, depthPct: null, posInCup: null, blocked_at: 'no_cup_structure' })
      continue
    }

    const cupLen = rr - lr
    const extremePrice = dir === 1 ? bars[ex].l : bars[ex].h
    const rim = dir === 1 ? Math.min(bars[lr].h, bars[rr].h) : Math.max(bars[lr].l, bars[rr].l)
    const posInCup = Math.round(((ex - lr) / cupLen) * 1000) / 1000

    const nearExtreme = dir === 1 ? extremePrice + 0.15 * depthAbs : extremePrice - 0.15 * depthAbs
    let roundBars = 0
    for (let i = lr; i <= rr; i++) {
      const touches = dir === 1 ? bars[i].l <= nearExtreme : bars[i].h >= nearExtreme
      if (touches) roundBars++
    }
    const roundBottomOk = roundBars >= ROUND_BOTTOM_BARS
    if (!roundBottomOk) {
      considerCandidate({ handleLen, cupLen, depthPct: Math.round(depth * 1000) / 10, posInCup, roundBars, roundBottomOk, blocked_at: 'round_bottom' })
      continue
    }

    const third = Math.max(1, Math.floor(cupLen / 3))
    const vInto = avgVol(bars, lr, lr + third)
    const vAtExtreme = avgVol(bars, ex - Math.floor(third / 2), ex + Math.floor(third / 2))
    const vOut = avgVol(bars, rr - third, rr)
    const volumeShapeOk = vAtExtreme > 0 ? (vInto > vAtExtreme && vOut > vAtExtreme) : false

    const handleFar = dir === 1
      ? Math.min(...bars.slice(rr + 1, last).map(bb => bb.l), Infinity)
      : Math.max(...bars.slice(rr + 1, last).map(bb => bb.h), -Infinity)
    const handleRangeOk = dir === 1 ? handleFar >= rim - depthAbs / 3 : handleFar <= rim + depthAbs / 3
    if (!handleRangeOk) {
      considerCandidate({ handleLen, cupLen, depthPct: Math.round(depth * 1000) / 10, posInCup, roundBars, roundBottomOk, volumeShapeOk, blocked_at: 'handle_range' })
      continue
    }
    const vHandle = avgVol(bars, rr + 1, last - 1)
    const handleTaperOk = vOut > 0 ? vHandle < vOut : false

    const prior2Extreme = dir === 1
      ? Math.max(bars[last - 1].h, bars[last - 2].h)
      : Math.min(bars[last - 1].l, bars[last - 2].l)
    const breakoutLevel = dir === 1
      ? Math.max(prior2Extreme, handleExtreme === -Infinity ? 0 : handleExtreme)
      : Math.min(prior2Extreme, handleExtreme === Infinity ? Infinity : handleExtreme)
    const breakoutTriggered = dir === 1 ? close > breakoutLevel : close < breakoutLevel
    const breakoutVolX = vHandle > 0 ? Math.round(((bars[last].v || 0) / vHandle) * 100) / 100 : 0
    const shared = { handleLen, cupLen, depthPct: Math.round(depth * 1000) / 10, posInCup, roundBars, roundBottomOk, volumeShapeOk, handleTaperOk, breakoutVolX }
    if (!breakoutTriggered) {
      considerCandidate({ ...shared, blocked_at: 'breakout_not_triggered' })
      continue
    }
    if (breakoutVolX < BREAKOUT_VOL_X) {
      considerCandidate({ ...shared, blocked_at: 'breakout_volume' })
      continue
    }

    const entry = close
    const a = atr(bars)
    const sl = a && a > 0 ? (dir === 1 ? entry - 1.5 * a : entry + 1.5 * a) : null
    const tp1 = sl != null
      ? (dir === 1 ? Math.max(bars[rr].h, handleExtreme) + depthAbs : Math.min(bars[rr].l, handleExtreme) - depthAbs)
      : null
    const slDist = sl != null ? Math.abs(entry - sl) : 0
    const rrRatio = sl != null && slDist > 0 ? Math.round((Math.abs(tp1 - entry) / slDist) * 100) / 100 : 0
    considerCandidate({ ...shared, rrRatio, blocked_at: rrRatio >= MIN_RR ? null : 'rr_floor' })
  }

  // cup_found answers "did the search find a valid cup structure at all?" —
  // not "would it have fired": a candidate stuck at no_cup_structure never
  // found a cup, everything past that gate did.
  const cup_found = best != null && best.blocked_at !== 'no_cup_structure'
  return { ...base, uptrend_ok, cup_found, best_candidate: best }
}

/** Classic (bullish) direction's trace — unchanged behavior/signature. */
export function traceCupHandleSearch(bars, timeframe) {
  return traceDirection(bars, timeframe, 1)
}

/** Inverted (bearish) direction's trace — same shape, own toggle. */
export function traceInvCupHandleSearch(bars, timeframe) {
  return traceDirection(bars, timeframe, -1)
}

/**
 * Watchlist screener — the video's funnel, restricted to what broker data
 * can honestly answer. Runs on DAILY bars.
 * Checkable here: price floor, average volume, relative volume > 1,
 * SMA 20/50/200 stack. NOT available from cTrader (do these on your stock
 * screener): P/E, optionable/shortable, sector rankings.
 */
export function screenBars(bars, { minPrice = 20, minAvgVolume = 0 } = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) {
    return { pass: false, checks: [{ ok: false, text: `only ${bars?.length ?? 0} daily bars — need ${MIN_BARS} for SMA200` }] }
  }
  const last = bars.length - 1
  const close = bars[last].c
  const s20 = sma(bars, 20); const s50 = sma(bars, 50); const s200 = sma(bars, 200)
  const avg50v = avgVol(bars, last - 50, last - 1)
  const relVol = avg50v > 0 ? (bars[last].v || 0) / avg50v : 0
  const checks = [
    { ok: close > minPrice, text: `price ${round5(close)} > ${minPrice}` },
    { ok: minAvgVolume <= 0 || avg50v >= minAvgVolume, text: `avg volume(50) ${Math.round(avg50v)} ≥ ${minAvgVolume}` },
    { ok: relVol > 1, text: `relative volume ${Math.round(relVol * 100) / 100} > 1` },
    { ok: s20 != null && close > s20, text: 'above SMA20' },
    { ok: s50 != null && close > s50, text: 'above SMA50' },
    { ok: s200 != null && close > s200, text: 'above SMA200' },
  ]
  return { pass: checks.every(c => c.ok), relVol: Math.round(relVol * 100) / 100, close: round5(close), checks }
}

const round5 = x => Math.round(x * 100000) / 100000
