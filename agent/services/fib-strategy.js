// ---------------------------------------------------------------------------
// agent/services/fib-strategy.js
//
// Deterministic Fibonacci 61.8% retracement fade strategy — replaces the
// LLM-based scan/analyze pipeline (scanner.js / analyzer.js). Detects the
// most recent swing leg via a simple fractal pivot method, computes the
// 61.8% retracement zone, and fades price back toward the swing origin
// when price re-enters that zone.
//
// NO LLM calls — every number here is computed from OHLC bars, same spirit
// as agent/services/risk.js.
// ---------------------------------------------------------------------------

import { wsGetTrendbars, wsSymbolsByIds } from '../lib/ctrader-ws.js'

const FRACTAL_WIDTH = 2       // 5-bar fractal (2 bars either side)
const ZONE_TOLERANCE = 0.05   // +/-5% of leg range around the 61.8% level
const SL_BUFFER = 0.05        // 5% of leg range beyond the swing origin
const TP2_EXTENSION = 0.272   // -27.2% extension beyond the swing end
const BAR_COUNT = 150         // bars fetched per timeframe
// Checked in this order (largest first); first timeframe with a valid
// signal wins. All timeframes are eligible — none are excluded.
const TIMEFRAMES = ['1d', '4h', '1h', '30m', '15m', '5m']

function scalePrice(raw, digits) {
  return raw / Math.pow(10, digits)
}

/**
 * Convert a raw GET_TRENDBARS_RES payload into ascending {t,o,h,l,c,v} bars.
 */
export function convertTrendbars(payload, digits) {
  return (payload?.trendbar || [])
    .map(b => ({
      t: (b.utcTimestampInMinutes || 0) * 60_000,
      o: scalePrice(b.low + (b.deltaOpen || 0), digits),
      h: scalePrice(b.low + (b.deltaHigh || 0), digits),
      l: scalePrice(b.low, digits),
      c: scalePrice(b.low + (b.deltaClose || 0), digits),
      v: b.volume || 0,
    }))
    .sort((a, b) => a.t - b.t)
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
    const window = bars.slice(i - fractalWidth, i + fractalWidth + 1)
    if (window.every(b => bars[i].h >= b.h)) highs.push({ idx: i, price: bars[i].h, t: bars[i].t })
    if (window.every(b => bars[i].l <= b.l)) lows.push({ idx: i, price: bars[i].l, t: bars[i].t })
  }
  return { highs, lows }
}

/**
 * Compute a Fibonacci 61.8% retracement fade signal from closed OHLC bars.
 * Returns null if there's no confirmed swing leg, or price isn't currently
 * in the 61.8% reaction zone, or the leg already invalidated.
 */
export function computeFibSignal(bars, timeframe) {
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
  const entry = lastClose
  const sl = upLeg ? swingA.price - buffer : swingA.price + buffer
  const tp1 = swingB.price
  const tp2 = upLeg ? swingB.price + TP2_EXTENSION * range : swingB.price - TP2_EXTENSION * range

  const slDistance = Math.abs(entry - sl)
  const tp1Distance = Math.abs(tp1 - entry)
  const rr = slDistance > 0 ? tp1Distance / slDistance : 0

  const proximity = 1 - Math.min(1, distFromLevel / tolerance)
  const rrScore = Math.min(1, rr / 3)
  const conviction = Math.round((proximity * 0.4 + rrScore * 0.6) * 10)

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
    strategy: 'fib_618_fade',
    thesis: `61.8% Fib fade — swing ${upLeg ? 'up' : 'down'} ${swingA.price} → ${swingB.price}, reacting at ${roundedLevel} on ${timeframe}. Targeting return to ${tp1}.`,
  }
}

/**
 * Fetch bars for a symbol across TIMEFRAMES (largest first) and return the
 * first timeframe that produces a valid signal, or null.
 */
export async function scanSymbolFib(creds, symbol, symbolId) {
  const { host, clientId, clientSecret, accessToken, accountId } = creds

  let digits = 5
  try {
    const symData = await wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, [symbolId])
    const meta = (symData.symbol || [])[0]
    if (meta && meta.digits != null) digits = meta.digits
  } catch (err) {
    return { symbol, signal: null, error: `symbol metadata failed: ${err.message}` }
  }

  for (const timeframe of TIMEFRAMES) {
    try {
      const payload = await wsGetTrendbars(host, clientId, clientSecret, accessToken, accountId, symbolId, timeframe, BAR_COUNT)
      const bars = convertTrendbars(payload, digits)
      const signal = computeFibSignal(bars, timeframe)
      if (signal) return { symbol, signal }
    } catch {
      continue // one timeframe failing shouldn't kill the whole symbol scan
    }
  }
  return { symbol, signal: null }
}

/**
 * Deterministic replacement for scanner.js's runScan — no LLM. Runs the
 * 61.8% Fib fade check across every symbol and shapes the output like the
 * old LLM scan result so the rest of loop.js doesn't need to change.
 */
export async function runFibScan(creds, symbolMap, symbols, options = {}) {
  const hotThreshold = Number(options.hotThreshold) || 6
  const batch = symbols.slice(0, 15)

  const results = await Promise.all(batch.map(async (w) => {
    const symbol = w.symbol
    const symbolId = symbolMap[symbol.toUpperCase()]
    if (!symbolId) return { symbol, signal: null, error: 'symbolId unknown — call POST /actions/symbol-map' }
    return scanSymbolFib(creds, symbol, symbolId)
  }))

  const scans = results.map(r => {
    const sig = r.signal
    return {
      symbol: r.symbol,
      bias: sig ? sig.bias : 'skip',
      confidence: sig ? sig.conviction : 0,
      thesis: sig ? sig.thesis : (r.error || 'No 61.8% reaction zone found'),
      timeframe: sig ? sig.timeframe : null,
      session_fit: 'n/a',
      trade_at: 'now',
      price: sig ? sig.entry : null,
      trade_grade: sig ? (sig.conviction >= hotThreshold ? 'potential' : 'weak') : 'none',
    }
  })

  const signals = {}
  for (const r of results) if (r.signal) signals[r.symbol] = r.signal

  const hot = scans.filter(s => s.confidence >= hotThreshold && s.bias !== 'skip').map(s => s.symbol)
  const warm = scans.filter(s => s.confidence >= 4 && s.confidence < hotThreshold && s.bias !== 'skip').map(s => s.symbol)

  return {
    scans,
    hot,
    warm,
    desk_note: `Deterministic 61.8% Fibonacci fade scan — ${scans.length} symbols, ${hot.length} hot, ${warm.length} warm.`,
    usage: { output_tokens: 0 },
    signals,
  }
}

/**
 * Deterministic replacement for analyzer.js's runAnalysis — reuses the
 * signal already computed during the scan phase (no second network round
 * trip) and shapes a "synthesis" object matching the old LLM output so
 * autoTrade() and DB persistence in loop.js are unchanged.
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
    dispatched: ['fib_618_fade'],
    reports: [{
      minionId: 'fib_618_fade',
      name: 'Fibonacci Fade',
      role: 'Deterministic 61.8% retracement fade',
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
      time_cap_minutes: null,
    },
    ms: 0,
    usage: { output_tokens: 0 },
  }
}
