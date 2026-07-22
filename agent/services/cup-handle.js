// ---------------------------------------------------------------------------
// agent/services/cup-handle.js — "Cup & Handle" breakout strategy.
// SEPARATE from the fib 61.8% fade: own module, own toggle, own label.
// Deterministic — no LLM. Long-only (the classic pattern).
//
// 5-step checklist (video spec, owner-approved 2026-07-09):
//   1. uptrend        — close above SMA 20, 50 and 200
//   2. healthy cup    — rounded bottom (≥3 bars near the low, not a V),
//                       depth 8–40% of the rim, volume: sell-off > bottom,
//                       recovery > bottom (spike → dry-up → rebuild)
//   3. tight handle   — drift holds the upper ⅓ of the cup, 2–15 bars,
//                       volume tapering vs the recovery leg
//   4. room to run    — right rim at/near the window's highest high
//   5. sector aligned — NOT computable from broker data; intentionally
//                       omitted (do it on your stock screener) — never faked
//
// Trade plan: entry = close breaking the prior-2-bar high AND the handle
// high on expanding volume · SL = entry − 1.5×ATR(14) ("baby bear") ·
// TP1 = handle high + cup depth (measured move) · take only if RR ≥ 1.5.
// ---------------------------------------------------------------------------

import { atr, vwap } from './fib-strategy.js'

const MIN_BARS = 210            // SMA200 + headroom
const CUP_MIN = 15              // cup length bounds (bars)
const CUP_MAX = 120
const HANDLE_MIN = 2
const HANDLE_MAX = 15
const DEPTH_MIN = 0.03          // cup depth as fraction of rim price
const DEPTH_MAX = 0.40
const ROUND_BOTTOM_BARS = 3     // bars that must sit near the low (U, not V)
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
 * Detect a completed cup-and-handle whose breakout is the LAST closed bar.
 * Same contract as computeFibSignal: null, or a signal object the loop,
 * risk gate and backtest already understand.
 */
export function computeCupHandleSignal(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null
  const last = bars.length - 1
  const close = bars[last].c

  // 1 — uptrend: above all three SMAs
  const s20 = sma(bars, 20); const s50 = sma(bars, 50); const s200 = sma(bars, 200)
  if (s20 == null || close <= s20 || close <= s50 || close <= s200) return null

  // Structure search, most recent first: right rim → handle → cup.
  for (let handleLen = HANDLE_MIN; handleLen <= HANDLE_MAX; handleLen++) {
    const rr = last - handleLen // right-rim candidate index
    if (rr < CUP_MIN + 10) break
    // right rim must be the local high vs the handle after it
    const handleHigh = Math.max(...bars.slice(rr + 1, last).map(b => b.h), -Infinity)
    if (bars[rr].h <= handleHigh) continue

    // cup: LEFT RIM FIRST — a prior high roughly level with the right rim —
    // then the bottom BETWEEN the rims. (Searching the bottom over the whole
    // window is wrong in an uptrend: the lowest low is old cheap price, not
    // the cup.)
    let lr = -1; let b = -1; let depthAbs = 0; let depth = 0
    for (let cand = rr - CUP_MIN; cand >= Math.max(rr - CUP_MAX, 0); cand--) {
      // rims roughly level: left rim within −5%/+15% of the right rim
      if (bars[cand].h < bars[rr].h * 0.95 || bars[cand].h > bars[rr].h * 1.15) continue
      const bot = idxMinLow(bars, cand + 1, rr - 1)
      const rim = Math.min(bars[cand].h, bars[rr].h)
      const dAbs = rim - bars[bot].l
      const d = dAbs / rim
      if (d < DEPTH_MIN || d > DEPTH_MAX) continue
      // the bottom must sit in the middle half of the cup, not hug a rim
      const posInCup = (bot - cand) / (rr - cand)
      if (posInCup < 0.2 || posInCup > 0.8) continue
      lr = cand; b = bot; depthAbs = dAbs; depth = d
      break
    }
    if (lr < 0) continue
    const cupLen = rr - lr
    const bottom = bars[b].l
    const rim = Math.min(bars[lr].h, bars[rr].h)

    // 2 — rounded bottom: several bars near the low, not one V-spike
    const nearLow = bottom + 0.15 * depthAbs
    let roundBars = 0
    for (let i = lr; i <= rr; i++) if (bars[i].l <= nearLow) roundBars++
    if (roundBars < ROUND_BOTTOM_BARS) continue

    // 2 — volume shape: sell-off > bottom third, recovery > bottom third
    const third = Math.max(1, Math.floor(cupLen / 3))
    const vDecline = avgVol(bars, lr, lr + third)
    const vBottom = avgVol(bars, b - Math.floor(third / 2), b + Math.floor(third / 2))
    const vRecovery = avgVol(bars, rr - third, rr)
    const volumeShapeOk = vBottom > 0 ? (vDecline > vBottom && vRecovery > vBottom) : false

    // 3 — tight handle: holds the upper ⅓ of the cup, volume tapering
    const handleLow = Math.min(...bars.slice(rr + 1, last).map(bb => bb.l), Infinity)
    if (handleLow < rim - depthAbs / 3) continue
    const vHandle = avgVol(bars, rr + 1, last - 1)
    const handleTaperOk = vRecovery > 0 ? vHandle < vRecovery : false

    // Entry trigger on the LAST bar: breaks prior-2-bar high AND handle high,
    // with volume expansion vs the handle.
    const prior2High = Math.max(bars[last - 1].h, bars[last - 2].h)
    if (close <= Math.max(prior2High, handleHigh === -Infinity ? 0 : handleHigh)) continue
    const breakoutVolX = vHandle > 0 ? (bars[last].v || 0) / vHandle : 0
    if (breakoutVolX < BREAKOUT_VOL_X) continue

    // 4 — room to run: right rim at/near the window's highest high
    const windowHigh = bars[idxMaxHigh(bars, 0, last)].h
    const roomToRun = bars[rr].h >= 0.98 * windowHigh

    // Optional VWAP confluence (breakout sense: longs only ABOVE value)
    if (opts.vwapFilter) {
      const vw = vwap(bars, lr)
      if (vw == null || close < vw) return null
    }

    const entry = close
    const a = atr(bars)
    if (!a || a <= 0) return null
    const sl = entry - 1.5 * a
    const tp1 = Math.max(bars[rr].h, handleHigh) + depthAbs // measured move
    const slDist = entry - sl
    const rrRatio = slDist > 0 ? (tp1 - entry) / slDist : 0
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

    return {
      bias: 'long',
      entry,
      sl,
      tp1,
      tp2: tp1 + depthAbs * 0.5,
      conviction,
      rr: Math.round(rrRatio * 100) / 100,
      timeframe,
      time_cap_minutes: null, // swing trade — no time cap
      strategy: 'cup_handle',
      cup: { leftRim: bars[lr].h, bottom, rightRim: bars[rr].h, depthPct: Math.round(depth * 1000) / 10, cupBars: cupLen, handleBars: handleLen },
      thesis: `Cup & Handle breakout on ${timeframe} — cup ${bars[lr].h}→${bottom}→${bars[rr].h} (depth ${Math.round(depth * 100)}%, ${cupLen} bars), ${handleLen}-bar handle, breakout vol ${Math.round(breakoutVolX * 10) / 10}× handle. Target ${Math.round(tp1 * 100000) / 100000} (measured move), SL 1.5×ATR.`,
    }
  }
  return null
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
 * Diagnostic twin of computeCupHandleSignal's search loop (Cup & Handle
 * Silence Diagnostics spec, Part A). Never returns a trade signal — instead
 * reports, per scan cycle, WHICH gate stopped the best-progressed candidate,
 * so "hasn't fired in a week" becomes a diagnosis instead of a guess.
 * computeCupHandleSignal is untouched by this — additive only.
 */
export function traceCupHandleSearch(bars, timeframe) {
  const scanned_at = new Date().toISOString()
  const base = { timeframe, scanned_at, uptrend_ok: false, cup_found: false, best_candidate: null }
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return base

  const last = bars.length - 1
  const close = bars[last].c
  const s20 = sma(bars, 20); const s50 = sma(bars, 50); const s200 = sma(bars, 200)
  const uptrend_ok = s20 != null && close > s20 && close > s50 && close > s200
  if (!uptrend_ok) return { ...base, uptrend_ok }

  let best = null
  // Keep whichever candidate got furthest through the checklist — that's the
  // most useful "why didn't it fire" answer, not just the last one scanned.
  const considerCandidate = (c) => {
    const rank = GATE_RANK[c.blocked_at ?? 'null']
    if (!best || rank > GATE_RANK[best.blocked_at ?? 'null']) best = c
  }

  for (let handleLen = HANDLE_MIN; handleLen <= HANDLE_MAX; handleLen++) {
    const rr = last - handleLen
    if (rr < CUP_MIN + 10) break
    const handleHighArr = bars.slice(rr + 1, last).map(b => b.h)
    const handleHigh = Math.max(...handleHighArr, -Infinity)
    if (bars[rr].h <= handleHigh) { // right rim not the local high — not a real candidate
      considerCandidate({ handleLen, cupLen: null, depthPct: null, posInCup: null, blocked_at: 'no_cup_structure' })
      continue
    }

    let lr = -1; let b = -1; let depthAbs = 0; let depth = 0
    for (let cand = rr - CUP_MIN; cand >= Math.max(rr - CUP_MAX, 0); cand--) {
      if (bars[cand].h < bars[rr].h * 0.95 || bars[cand].h > bars[rr].h * 1.15) continue
      const bot = idxMinLow(bars, cand + 1, rr - 1)
      const rim = Math.min(bars[cand].h, bars[rr].h)
      const dAbs = rim - bars[bot].l
      const d = dAbs / rim
      if (d < DEPTH_MIN || d > DEPTH_MAX) continue
      const posInCup = (bot - cand) / (rr - cand)
      if (posInCup < 0.2 || posInCup > 0.8) continue
      lr = cand; b = bot; depthAbs = dAbs; depth = d
      break
    }
    if (lr < 0) {
      considerCandidate({ handleLen, cupLen: null, depthPct: null, posInCup: null, blocked_at: 'no_cup_structure' })
      continue
    }

    const cupLen = rr - lr
    const bottom = bars[b].l
    const rim = Math.min(bars[lr].h, bars[rr].h)
    const posInCup = Math.round(((b - lr) / cupLen) * 1000) / 1000

    const nearLow = bottom + 0.15 * depthAbs
    let roundBars = 0
    for (let i = lr; i <= rr; i++) if (bars[i].l <= nearLow) roundBars++
    const roundBottomOk = roundBars >= ROUND_BOTTOM_BARS
    if (!roundBottomOk) {
      considerCandidate({ handleLen, cupLen, depthPct: Math.round(depth * 1000) / 10, posInCup, roundBars, roundBottomOk, blocked_at: 'round_bottom' })
      continue
    }

    const third = Math.max(1, Math.floor(cupLen / 3))
    const vDecline = avgVol(bars, lr, lr + third)
    const vBottom = avgVol(bars, b - Math.floor(third / 2), b + Math.floor(third / 2))
    const vRecovery = avgVol(bars, rr - third, rr)
    const volumeShapeOk = vBottom > 0 ? (vDecline > vBottom && vRecovery > vBottom) : false

    const handleLow = Math.min(...bars.slice(rr + 1, last).map(bb => bb.l), Infinity)
    const handleRangeOk = handleLow >= rim - depthAbs / 3
    if (!handleRangeOk) {
      considerCandidate({ handleLen, cupLen, depthPct: Math.round(depth * 1000) / 10, posInCup, roundBars, roundBottomOk, volumeShapeOk, blocked_at: 'handle_range' })
      continue
    }
    const vHandle = avgVol(bars, rr + 1, last - 1)
    const handleTaperOk = vRecovery > 0 ? vHandle < vRecovery : false

    const prior2High = Math.max(bars[last - 1].h, bars[last - 2].h)
    const breakoutLevel = Math.max(prior2High, handleHigh === -Infinity ? 0 : handleHigh)
    const breakoutTriggered = close > breakoutLevel
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
    const sl = a && a > 0 ? entry - 1.5 * a : null
    const tp1 = sl != null ? Math.max(bars[rr].h, handleHigh) + depthAbs : null
    const slDist = sl != null ? entry - sl : 0
    const rrRatio = sl != null && slDist > 0 ? Math.round(((tp1 - entry) / slDist) * 100) / 100 : 0
    considerCandidate({ ...shared, rrRatio, blocked_at: rrRatio >= MIN_RR ? null : 'rr_floor' })
  }

  // cup_found answers "did the search find a valid cup structure at all?" —
  // not "would it have fired": a candidate stuck at no_cup_structure never
  // found a cup, everything past that gate did.
  const cup_found = best != null && best.blocked_at !== 'no_cup_structure'
  return { ...base, uptrend_ok, cup_found, best_candidate: best }
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
