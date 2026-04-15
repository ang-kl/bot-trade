// Client-side indicator calculation engine.
// Computes indicator values from OHLCV candle arrays.
// Every function takes raw arrays and returns arrays of the same length
// (null-padded for warmup periods).
//
// Candle shape: { t, o, h, l, c, v } (millis, open, high, low, close, volume)

// ── Moving Averages ──

export function sma(values, period) {
  const out = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    out.push(sum / period)
  }
  return out
}

export function ema(values, period) {
  const k = 2 / (period + 1)
  const out = [values[0]]
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k))
  }
  return out
}

export function wma(values, period) {
  const out = []
  const denom = (period * (period + 1)) / 2
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue }
    let sum = 0
    for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1)
    out.push(sum / denom)
  }
  return out
}

export function hma(values, period) {
  // Hull MA = WMA(2×WMA(n/2) - WMA(n), sqrt(n))
  const half = Math.max(1, Math.floor(period / 2))
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)))
  const wmaHalf = wma(values, half)
  const wmaFull = wma(values, period)
  const diff = wmaHalf.map((v, i) => v != null && wmaFull[i] != null ? 2 * v - wmaFull[i] : values[i])
  return wma(diff, sqrtP)
}

export function dema(values, period) {
  const e1 = ema(values, period)
  const e2 = ema(e1, period)
  return e1.map((v, i) => 2 * v - e2[i])
}

export function tema(values, period) {
  const e1 = ema(values, period)
  const e2 = ema(e1, period)
  const e3 = ema(e2, period)
  return e1.map((v, i) => 3 * e1[i] - 3 * e2[i] + e3[i])
}

// ── Volatility ──

export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l
    const prev = candles[i - 1].c
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev))
  })
}

export function atr(candles, period) {
  return sma(trueRange(candles), period)
}

export function bollingerBands(candles, period, deviation) {
  const closes = candles.map(c => c.c)
  const middle = sma(closes, period)
  const upper = [], lower = []
  for (let i = 0; i < closes.length; i++) {
    if (middle[i] == null) { upper.push(null); lower.push(null); continue }
    let sumSq = 0
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - middle[i]) ** 2
    const std = Math.sqrt(sumSq / period)
    upper.push(middle[i] + std * deviation)
    lower.push(middle[i] - std * deviation)
  }
  return { middle, upper, lower }
}

export function keltnerChannel(candles, period, atrPeriod, multiplier) {
  const closes = candles.map(c => c.c)
  const middle = ema(closes, period)
  const atrVals = atr(candles, atrPeriod)
  const upper = middle.map((m, i) => m != null && atrVals[i] != null ? m + multiplier * atrVals[i] : null)
  const lower = middle.map((m, i) => m != null && atrVals[i] != null ? m - multiplier * atrVals[i] : null)
  return { middle, upper, lower }
}

export function donchianChannel(candles, period) {
  const upper = [], lower = [], middle = []
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); middle.push(null); continue }
    let hi = -Infinity, lo = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].h > hi) hi = candles[j].h
      if (candles[j].l < lo) lo = candles[j].l
    }
    upper.push(hi)
    lower.push(lo)
    middle.push((hi + lo) / 2)
  }
  return { middle, upper, lower }
}

// ── Momentum / Oscillators ──

export function rsi(candles, period) {
  const closes = candles.map(c => c.c)
  const out = Array(closes.length).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d)
  }
  avgGain /= period; avgLoss /= period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export function macd(candles, fast, slow, signal) {
  const closes = candles.map(c => c.c)
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const line = emaFast.map((v, i) => v - emaSlow[i])
  const sig = ema(line, signal)
  const hist = line.map((v, i) => v - sig[i])
  return { line, signal: sig, histogram: hist }
}

export function stochastic(candles, kPeriod, dPeriod) {
  const k = []
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) { k.push(null); continue }
    let hi = -Infinity, lo = Infinity
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].h > hi) hi = candles[j].h
      if (candles[j].l < lo) lo = candles[j].l
    }
    k.push(hi === lo ? 50 : ((candles[i].c - lo) / (hi - lo)) * 100)
  }
  const d = sma(k.map(v => v ?? 50), dPeriod)
  return { k, d }
}

// ── Volume ──

export function vwap(candles) {
  // Session VWAP — cumulative (resets not implemented, full series).
  let cumPV = 0, cumV = 0
  return candles.map(c => {
    const typical = (c.h + c.l + c.c) / 3
    cumPV += typical * (c.v || 0)
    cumV += c.v || 0
    return cumV > 0 ? cumPV / cumV : typical
  })
}

export function obv(candles) {
  let val = 0
  return candles.map((c, i) => {
    if (i === 0) return 0
    if (c.c > candles[i - 1].c) val += c.v || 0
    else if (c.c < candles[i - 1].c) val -= c.v || 0
    return val
  })
}

// ── Master dispatcher ──
// Returns { type: 'line'|'band'|'histogram'|'bar', data: ... }
// so the chart knows how to render each indicator.

export function computeIndicator(indicatorId, params, candles) {
  const closes = candles.map(c => c.c)
  const p = params || {}

  switch (indicatorId) {
    // Trend — rendered as overlay lines on price chart
    case 'ema':   return { type: 'line', render: 'overlay', data: ema(closes, p.period || 9) }
    case 'sma':   return { type: 'line', render: 'overlay', data: sma(closes, p.period || 20) }
    case 'wma':   return { type: 'line', render: 'overlay', data: wma(closes, p.period || 20) }
    case 'hma':   return { type: 'line', render: 'overlay', data: hma(closes, p.period || 9) }
    case 'dema':  return { type: 'line', render: 'overlay', data: dema(closes, p.period || 20) }
    case 'tema':  return { type: 'line', render: 'overlay', data: tema(closes, p.period || 20) }

    // Volatility bands — rendered as overlay bands
    case 'bbands': {
      const bb = bollingerBands(candles, p.period || 20, p.deviation || 2)
      return { type: 'band', render: 'overlay', data: bb }
    }
    case 'keltner': {
      const kc = keltnerChannel(candles, p.period || 20, p.atrPeriod || 10, p.atrMultiplier || 1.5)
      return { type: 'band', render: 'overlay', data: kc }
    }
    case 'donchian': {
      const dc = donchianChannel(candles, p.period || 20)
      return { type: 'band', render: 'overlay', data: dc }
    }

    // Volume overlay
    case 'vwap':   return { type: 'line', render: 'overlay', data: vwap(candles) }

    // Momentum oscillators — rendered in separate panels
    case 'rsi':    return { type: 'line', render: 'panel', data: rsi(candles, p.period || 14), yRange: [0, 100], refLines: [30, 70] }
    case 'macd': {
      const m = macd(candles, p.fastPeriod || 12, p.slowPeriod || 26, p.signalPeriod || 9)
      return { type: 'macd', render: 'panel', data: m }
    }
    case 'stochastic': {
      const s = stochastic(candles, p.kPeriod || 14, p.dPeriod || 3)
      return { type: 'stochastic', render: 'panel', data: s, yRange: [0, 100], refLines: [20, 80] }
    }

    // Volatility — separate panel
    case 'atr':    return { type: 'line', render: 'panel', data: atr(candles, p.period || 14) }

    // Volume — bar panel
    case 'volume': return { type: 'bar', render: 'panel', data: candles.map(c => c.v || 0) }
    case 'obv':    return { type: 'line', render: 'panel', data: obv(candles) }

    default:       return null
  }
}

// Given an indicator ID, return where it should render.
export function getIndicatorRenderType(indicatorId) {
  const overlays = new Set([
    'ema', 'sma', 'wma', 'hma', 'dema', 'tema', 'vwma', 'ichimoku',
    'psar', 'psar_dev', 'supertrend', 'bbands', 'keltner', 'donchian', 'vwap',
  ])
  const panels = new Set([
    'rsi', 'macd', 'stochastic', 'cci', 'willr', 'mfi', 'roc', 'momentum',
    'tsi', 'ao', 'pvo', 'adx', 'aroon', 'atr', 'atrpct', 'stddev',
    'volume', 'obv', 'cvd', 'ad', 'cmf', 'fi',
  ])
  if (overlays.has(indicatorId)) return 'overlay'
  if (panels.has(indicatorId)) return 'panel'
  return 'none'
}
