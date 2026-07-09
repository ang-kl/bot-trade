// ---------------------------------------------------------------------------
// agent/services/fib-strategy.js
//
// Deterministic Fibonacci 61.8% retracement fade strategy — replaces the
// LLM-based scan/analyze pipeline. Detects the most recent swing leg via a
// simple fractal pivot method, computes the 61.8% retracement zone, and
// fades price back toward the swing origin when price re-enters that zone.
//
// NO LLM calls — every number here is computed from OHLC bars, same spirit
// as agent/services/risk.js.
// ---------------------------------------------------------------------------

import { wsGetTrendbarsBatch, TRENDBAR_PERIODS } from '../lib/ctrader-ws.js'
import { tfMs } from '../lib/timeframes.js'
import { computeCupHandleSignal } from './cup-handle.js'

const FRACTAL_WIDTH = 2       // 5-bar fractal (2 bars either side)
const ZONE_TOLERANCE = 0.05   // +/-5% of leg range around the 61.8% level
// Leg-significance floor: reject legs smaller than this many ATR(14). Fading
// micro-legs is where spread/slippage (not modelled anywhere upstream)
// exceeds the theoretical edge — the main reason the reference backtest bled
// out on low timeframes.
const MIN_LEG_ATR_MULT = 3
const ATR_PERIOD = 14
// SL buffer beyond the swing origin. Kept small deliberately: at the 61.8%
// level tp1Distance is 0.618×range and slDistance is (0.382 + buffer)×range,
// so the buffer sets the signal's R:R — 0.02 gives rr≈1.54 at the level,
// clearing risk.js's minRR of 1.5. (The old 0.05 buffer pinned rr to 1.43
// at the level, so the risk gate vetoed every at-level entry as bad_rr.)
const SL_BUFFER = 0.02
const TP2_EXTENSION = 0.272   // -27.2% extension beyond the swing end
const BAR_COUNT = 150         // bars fetched per timeframe
// Checked in this order (largest first); first timeframe with a valid
// signal wins. All timeframes are eligible — none are excluded.
const TIMEFRAMES = ['1mo', '1w', '1d', '4h', '1h', '30m', '15m', '5m']
// Position time cap by signal timeframe. Drives loop.js's style filter
// (scalp ≤30m, day ≤480m, swing ≤7d, mid-term beyond) and the position
// auto-expiry — a 1d fade is a multi-day swing, not a 180-minute day trade.
const TIME_CAP_MINUTES = {
  '5m': 240, '15m': 480, '30m': 720, '1h': 1440, '4h': 4320, '1d': 20160,
  '1w': 60480,    // a weekly fade is a ~6-week position
  '1mo': 259200,  // a monthly fade is a ~6-month position
}
const SCAN_CONCURRENCY = 3    // symbols scanned at once (avoid WS burst)

// In-memory bar cache. A timeframe's bars only change when a new bar closes,
// so refetching 1d candles every 5-minute loop is pure waste — cache entries
// expire after one bar duration.
const barCache = new Map() // `${symbolId}|${period}` -> { bars, fetchedAt }

function cachedBars(symbolId, period) {
  const entry = barCache.get(`${symbolId}|${period}`)
  if (!entry) return null
  const ttl = tfMs(period) || 300_000
  return Date.now() - entry.fetchedAt < ttl ? entry.bars : null
}

// Position time cap for a timeframe — the fixed table for the classic set,
// 24× the bar duration (clamped to the table's own range) for custom
// timeframes like 1.5h or 6h that the trader typed in.
function timeCapFor(timeframe) {
  return TIME_CAP_MINUTES[timeframe]
    ?? Math.min(Math.max(Math.round((tfMs(timeframe) / 60_000) * 24), 240), 259_200)
}

/**
 * Mean true range over the trailing `period` bars. Local implementation —
 * the agent stays standalone from the frontend's src/lib/indicator-calc.js.
 */
export function atr(bars, period = ATR_PERIOD) {
  if (bars.length < 2) return 0
  const slice = bars.slice(-(period + 1))
  let sum = 0
  let n = 0
  for (let i = 1; i < slice.length; i++) {
    const prevClose = slice[i - 1].c
    const tr = Math.max(
      slice[i].h - slice[i].l,
      Math.abs(slice[i].h - prevClose),
      Math.abs(slice[i].l - prevClose),
    )
    sum += tr
    n++
  }
  return n > 0 ? sum / n : 0
}

/**
 * Wilder-smoothed RSI over closes. Returns null when there aren't enough
 * bars. Local implementation — the agent stays standalone.
 */
export function rsi(bars, period = 14) {
  if (bars.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = bars[i].c - bars[i - 1].c
    if (d >= 0) gain += d; else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

// Default RSI confluence thresholds (only applied when the filter is on):
// a long fade should be entered into weakness (RSI at/below longMax), a
// short fade into strength (RSI at/above shortMin).
export const RSI_FILTER_DEFAULTS = { longMax: 45, shortMin: 55 }

/**
 * Anchored VWAP from bar index `anchorIdx` to the last bar: Σ(typical×vol)/Σvol.
 * Anchored to the swing leg's origin, not calendar sessions — FX has no
 * exchange session, and leg-anchoring makes the question structural:
 * "is price cheap/rich relative to this leg's volume-weighted average?"
 * Volume is broker TICK volume (all cTrader offers) — fine as a weighting,
 * do not read it as real traded volume. Falls back to equal weights when a
 * feed reports zero volume. Returns null on an empty range.
 */
export function vwap(bars, anchorIdx = 0) {
  let pv = 0
  let v = 0
  let n = 0
  let sumTypical = 0
  for (let i = Math.max(0, anchorIdx); i < bars.length; i++) {
    const b = bars[i]
    const typical = (b.h + b.l + b.c) / 3
    const vol = Number(b.v) || 0
    pv += typical * vol
    v += vol
    sumTypical += typical
    n++
  }
  if (n === 0) return null
  return v > 0 ? pv / v : sumTypical / n
}

/**
 * Unfilled 3-bar fair value gaps (imbalances). Bullish FVG: low[i] > high[i-2]
 * (the gap is the zone between them); bearish: high[i] < low[i-2]. A gap is
 * "filled" once any LATER bar trades through it — only unfilled gaps return.
 * Returns [{ dir: 'bull'|'bear', top, bottom, idx }].
 */
export function findFVGs(bars) {
  const gaps = []
  for (let i = 2; i < bars.length; i++) {
    if (bars[i].l > bars[i - 2].h) gaps.push({ dir: 'bull', top: bars[i].l, bottom: bars[i - 2].h, idx: i })
    else if (bars[i].h < bars[i - 2].l) gaps.push({ dir: 'bear', top: bars[i - 2].l, bottom: bars[i].h, idx: i })
  }
  // Keep only gaps no later bar has traded through.
  return gaps.filter(g => {
    for (let j = g.idx + 1; j < bars.length; j++) {
      if (g.dir === 'bull' && bars[j].l <= g.bottom) return false
      if (g.dir === 'bear' && bars[j].h >= g.top) return false
    }
    return true
  })
}

/**
 * Find confirmed swing highs/lows using a simple N-bar fractal (a bar is a
 * swing point if it's the extreme of the `2*fractalWidth+1` bars centred on
 * it). Excludes the trailing `fractalWidth` bars, which can't yet be
 * confirmed.
 */
export function findSwings(bars, fractalWidth = FRACTAL_WIDTH) {
  const highs = []
  const lows = []
  for (let i = fractalWidth; i < bars.length - fractalWidth; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - fractalWidth; j <= i + fractalWidth; j++) {
      if (bars[j].h > bars[i].h) isHigh = false
      if (bars[j].l < bars[i].l) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) highs.push({ idx: i, price: bars[i].h, t: bars[i].t })
    if (isLow) lows.push({ idx: i, price: bars[i].l, t: bars[i].t })
  }
  return { highs, lows }
}

/**
 * Compute a Fibonacci 61.8% retracement fade signal from closed OHLC bars.
 * Returns null if there's no confirmed swing leg, or price isn't currently
 * in the 61.8% reaction zone, or the leg already invalidated.
 */
export function computeFibSignal(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < FRACTAL_WIDTH * 2 + 10) return null

  const { highs, lows } = findSwings(bars)
  if (highs.length === 0 || lows.length === 0) return null

  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]
  if (lastHigh.idx === lastLow.idx) return null

  const upLeg = lastHigh.idx > lastLow.idx // low happened first, then high -> leg is UP
  const swingA = upLeg ? lastLow : lastHigh // leg origin (fib 100%)
  const swingB = upLeg ? lastHigh : lastLow // leg end (fib 0%)
  const range = Math.abs(swingB.price - swingA.price)
  if (range <= 0) return null

  // Leg must be significant relative to recent volatility — micro-legs are
  // noise whose "zone reactions" are spread-sized.
  if (range < MIN_LEG_ATR_MULT * atr(bars)) return null

  const level618 = upLeg
    ? swingB.price - 0.618 * range
    : swingB.price + 0.618 * range

  const tolerance = ZONE_TOLERANCE * range
  const lastClose = bars[bars.length - 1].c
  const distFromLevel = Math.abs(lastClose - level618)
  if (distFromLevel > tolerance) return null

  // Invalidation: price already broke past the swing origin — the leg
  // failed to react at all, so the fade thesis is dead.
  const buffer = SL_BUFFER * range
  const invalidated = upLeg
    ? lastClose < swingA.price - buffer
    : lastClose > swingA.price + buffer
  if (invalidated) return null

  const bias = upLeg ? 'long' : 'short'

  // Optional RSI confluence (off by default): a fade should enter longs
  // into weakness and shorts into strength — fib alone has no documented
  // standalone edge, so this is the standard "combine with another
  // indicator" gate, A/B-testable via the backtest harness.
  if (opts.rsiFilter) {
    const { longMax, shortMin } = { ...RSI_FILTER_DEFAULTS, ...opts.rsiFilter }
    const r = rsi(bars)
    if (r == null) return null
    if (bias === 'long' && r > longMax) return null
    if (bias === 'short' && r < shortMin) return null
  }

  // Optional VWAP confluence (off by default): anchored to the swing leg's
  // origin — long fades only below value (entry ≤ VWAP), shorts only above.
  if (opts.vwapFilter) {
    const anchorIdx = Math.min(swingA.idx, swingB.idx)
    const vw = vwap(bars, anchorIdx)
    if (vw == null) return null
    if (bias === 'long' && lastClose > vw) return null
    if (bias === 'short' && lastClose < vw) return null
  }

  // Optional FVG confluence (off by default): require an unfilled fair value
  // gap in the signal's direction overlapping the 61.8% zone — the fib level
  // and the imbalance agree on where price should react.
  if (opts.fvgFilter) {
    const zoneTop = level618 + tolerance
    const zoneBottom = level618 - tolerance
    const wantDir = bias === 'long' ? 'bull' : 'bear'
    const overlap = findFVGs(bars).some(g =>
      g.dir === wantDir && g.bottom <= zoneTop && g.top >= zoneBottom)
    if (!overlap) return null
  }

  const entry = lastClose
  const sl = upLeg ? swingA.price - buffer : swingA.price + buffer
  const tp1 = swingB.price
  const tp2 = upLeg ? swingB.price + TP2_EXTENSION * range : swingB.price - TP2_EXTENSION * range

  const slDistance = Math.abs(entry - sl)
  const tp1Distance = Math.abs(tp1 - entry)
  const rr = slDistance > 0 ? tp1Distance / slDistance : 0

  // Conviction = zone proximity mapped onto 0–10. R:R is deliberately NOT
  // blended in: the fib geometry pins rr into a narrow structural band
  // (~1.2–2.0), so it can't discriminate between setups — a blended score
  // capped out at 7 and made the default auto_trade threshold of 8
  // unreachable. Proximity spans the full band: 10 = close sits exactly on
  // the 61.8% level, 0 = at the zone edge. hot ≥6 → inner 40% of the zone,
  // auto_trade ≥8 → inner 20%.
  const proximity = 1 - Math.min(1, distFromLevel / tolerance)
  const conviction = Math.round(proximity * 10)

  const roundedLevel = Math.round(level618 * 100000) / 100000

  return {
    bias,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    rr: Math.round(rr * 100) / 100,
    level618: roundedLevel,
    swingA: swingA.price,
    swingB: swingB.price,
    timeframe,
    time_cap_minutes: timeCapFor(timeframe) || null,
    strategy: 'fib_618_fade',
    thesis: `61.8% Fib fade — swing ${upLeg ? 'up' : 'down'} ${swingA.price} → ${swingB.price}, reacting at ${roundedLevel} on ${timeframe}. Targeting return to ${tp1}.`,
  }
}

/**
 * Fetch bars for a symbol across TIMEFRAMES (one authenticated connection
 * for all uncached timeframes) and return the first timeframe — largest
 * first — that produces a valid signal.
 *
 * Returns `{ symbol, signal, lastPrice, error }`:
 * - `lastPrice` is the freshest close seen on any timeframe, present even
 *   when there's no signal — the monitor phase prices open positions from it.
 * - `error` is set when the bar fetch failed outright (rate limit, expired
 *   token); callers must surface it instead of reading "no signal".
 */
export async function scanSymbolFib(creds, symbol, symbolId, opts = {}) {
  const { host, clientId, clientSecret, accessToken, accountId } = creds

  // Classic set plus any custom timeframes the trader added (e.g. 1.5h) —
  // a custom TF armed for autotrade must also be scanned, or it never fires.
  const scanTfs = [...new Set([...TIMEFRAMES, ...(opts.extraTimeframes || [])])]
    .filter(tf => tfMs(tf) > 0)
    .sort((a, b) => tfMs(b) - tfMs(a))

  const stale = scanTfs.filter(tf => !cachedBars(symbolId, tf))
  if (stale.length > 0) {
    try {
      const fetched = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, stale, BAR_COUNT)
      const now = Date.now()
      for (const tf of stale) {
        barCache.set(`${symbolId}|${tf}`, { bars: fetched[tf] || [], fetchedAt: now })
      }
    } catch (err) {
      return { symbol, signal: null, lastPrice: null, error: `trendbar fetch failed: ${err.message}` }
    }
  }

  let signal = null
  let lastPrice = null
  let lastPriceT = -1
  const now = Date.now()
  for (const timeframe of scanTfs) {
    const bars = cachedBars(symbolId, timeframe) || []
    const last = bars[bars.length - 1]
    if (last && last.t > lastPriceT) { lastPrice = last.c; lastPriceT = last.t }
    // Signals are evaluated on CLOSED bars only. cTrader's trendbar response
    // includes the current forming bar, and a mid-bar "close" is the classic
    // repainting/lookahead trap: intrabar wicks trigger entries a closed-bar
    // rule (and any backtest of it) would never take. The forming bar's close
    // still feeds lastPrice above — right for pricing, wrong for signals.
    if (!signal) {
      const periodMs = tfMs(timeframe) || 0
      const closed = last && last.t + periodMs > now ? bars.slice(0, -1) : bars
      signal = computeFibSignal(closed, timeframe, opts)
      // Cup & Handle is a SEPARATE strategy (own module/toggle) that shares
      // this scan's bar cache — one fetch serves both rule sets.
      if (!signal && opts.cupHandle) {
        signal = computeCupHandleSignal(closed, timeframe, opts)
      }
    }
  }
  return { symbol, signal, lastPrice, error: null }
}

/**
 * Deterministic replacement for the old LLM runScan — no LLM. Runs the
 * 61.8% Fib fade check across every symbol (bounded concurrency) and shapes
 * the output like the old scan result so the rest of loop.js doesn't change.
 *
 * Every scanned symbol gets a `price` (signal entry or latest close) because
 * the monitor phase resolves open-position prices from these rows. Fetch
 * failures are counted in `errors` and surfaced in the row's thesis.
 */
export async function runFibScan(creds, symbolMap, symbols, options = {}) {
  const hotThreshold = Number(options.hotThreshold) || 6
  const scanOpts = {
    rsiFilter: options.rsiFilter || null,
    vwapFilter: options.vwapFilter || null,
    fvgFilter: options.fvgFilter || null,
    cupHandle: !!options.cupHandle,
    extraTimeframes: options.extraTimeframes || [],
  }
  const batch = symbols.slice(0, 15)

  const results = []
  for (let i = 0; i < batch.length; i += SCAN_CONCURRENCY) {
    const chunk = batch.slice(i, i + SCAN_CONCURRENCY)
    const chunkResults = await Promise.all(chunk.map(async (w) => {
      const symbol = w.symbol
      const symbolId = symbolMap[symbol.toUpperCase()]
      if (!symbolId) return { symbol, signal: null, lastPrice: null, error: 'symbolId unknown — call POST /actions/symbol-map' }
      return scanSymbolFib(creds, symbol, symbolId, scanOpts)
    }))
    results.push(...chunkResults)
  }

  const scans = results.map(r => {
    const sig = r.signal
    return {
      symbol: r.symbol,
      bias: sig ? sig.bias : 'skip',
      confidence: sig ? sig.conviction : 0,
      thesis: sig ? sig.thesis : (r.error ? `SCAN ERROR: ${r.error}` : 'No 61.8% reaction zone found'),
      strategy: sig ? sig.strategy : null,
      timeframe: sig ? sig.timeframe : null,
      session_fit: 'n/a',
      trade_at: 'now',
      price: sig ? sig.entry : r.lastPrice,
      trade_grade: sig ? (sig.conviction >= hotThreshold ? 'potential' : 'weak') : 'none',
    }
  })

  const signals = {}
  for (const r of results) if (r.signal) signals[r.symbol] = r.signal

  const errors = results.filter(r => r.error).map(r => `${r.symbol}: ${r.error}`)
  const hot = scans.filter(s => s.confidence >= hotThreshold && s.bias !== 'skip').map(s => s.symbol)
  const warm = scans.filter(s => s.confidence >= 4 && s.confidence < hotThreshold && s.bias !== 'skip').map(s => s.symbol)

  return {
    scans,
    hot,
    warm,
    desk_note: `Deterministic 61.8% Fibonacci fade scan — ${scans.length} symbols, ${hot.length} hot, ${warm.length} warm${errors.length ? `, ${errors.length} fetch error(s)` : ''}.`,
    usage: { output_tokens: 0 },
    signals,
    errors,
  }
}

/**
 * Deterministic replacement for the old LLM runAnalysis — reuses the signal
 * already computed during the scan phase (no second network round trip) and
 * shapes a "synthesis" object matching the old LLM output so autoTrade()
 * and DB persistence in loop.js are unchanged.
 */
export function synthesizeFibSignal(symbol, signal, threshold = 8) {
  if (!signal) {
    return {
      symbol,
      dispatched: [],
      reports: [],
      synthesis: {
        symbol,
        consensus_bias: 'skip',
        overall_conviction: 0,
        synthesis: 'No 61.8% Fibonacci reaction zone active.',
        auto_trade: false,
        strategy: 'fib_618_fade',
      },
      ms: 0,
      usage: { output_tokens: 0 },
    }
  }

  return {
    symbol,
    dispatched: [signal.strategy || 'fib_618_fade'],
    reports: [{
      minionId: signal.strategy || 'fib_618_fade',
      name: signal.strategy === 'cup_handle' ? 'Cup & Handle' : 'Fibonacci Fade',
      role: signal.strategy === 'cup_handle' ? 'Deterministic cup & handle breakout' : 'Deterministic 61.8% retracement fade',
      bias: signal.bias,
      conviction: signal.conviction,
      report: signal.thesis,
      entry: signal.entry,
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
    }],
    synthesis: {
      symbol,
      consensus_bias: signal.bias,
      overall_conviction: signal.conviction,
      synthesis: signal.thesis,
      entry: signal.entry,
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
      auto_trade: signal.conviction >= threshold,
      strategy: signal.strategy,
      timeframe: signal.timeframe,
      risk_note: `R:R ${signal.rr} to TP1, 61.8% level=${signal.level618}`,
      invalidation_trigger: `Close beyond swing origin ${signal.swingA}`,
      time_cap_minutes: signal.time_cap_minutes,
    },
    ms: 0,
    usage: { output_tokens: 0 },
  }
}
