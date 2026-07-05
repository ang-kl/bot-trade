// Polygon.io market data + metrics service — extracted from api/massive-compute.js
// Standalone business logic, no HTTP handler.
// Uses env var MASSIVE_API_KEY.

const BASE = 'https://api.polygon.io'

function getApiKey() {
  // const key = process.env.MASSIVE_API_KEY — disabled, no longer in use
  throw new Error('MASSIVE_API_KEY env var not set')
}

async function massiveGet(path, apiKey, params = {}) {
  const url = new URL(path, BASE)
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `Massive API ${res.status}`)
  return data
}

// -- Helpers --

function formatDate(d) {
  return d.toISOString().slice(0, 10)
}

function round(n, d) {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}

/**
 * Fetch OHLCV bars from Polygon.io for a ticker.
 *
 * @param {string} ticker
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate - YYYY-MM-DD
 * @returns {Promise<object>} Polygon API response with .results array
 */
export async function fetchBars(ticker, fromDate, toDate) {
  const apiKey = getApiKey()
  const path = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fromDate}/${toDate}`
  return massiveGet(path, apiKey, { adjusted: true, sort: 'asc', limit: 50000 })
}

// -- Volume Profile --

/**
 * Compute volume profile from OHLCV bars.
 * Returns Point of Control (POC), High Volume Node (HVN), Low Volume Node (LVN).
 *
 * @param {Array<{h: number, l: number, v: number}>} bars
 * @returns {{ poc: number|null, hvn: number|null, lvn: number|null }}
 */
export function computeVolumeProfile(bars) {
  if (bars.length === 0) return { poc: null, hvn: null, lvn: null }

  let minPrice = Infinity
  let maxPrice = -Infinity
  for (const b of bars) {
    if (b.l < minPrice) minPrice = b.l
    if (b.h > maxPrice) maxPrice = b.h
  }

  const numBins = 50
  const range = maxPrice - minPrice
  if (range === 0) {
    return { poc: minPrice, hvn: minPrice, lvn: minPrice }
  }
  const binSize = range / numBins
  const bins = new Array(numBins).fill(0)

  for (const b of bars) {
    // Distribute volume across bins that the bar's high-low range touches
    const lo = Math.max(0, Math.floor((b.l - minPrice) / binSize))
    const hi = Math.min(numBins - 1, Math.floor((b.h - minPrice) / binSize))
    if (hi < 0 || lo >= numBins) continue
    const loC = Math.max(0, lo)
    const hiC = Math.min(numBins - 1, hi)
    const span = hiC - loC + 1
    const volPerBin = b.v / span
    for (let i = loC; i <= hiC; i++) {
      bins[i] += volPerBin
    }
  }

  // POC: bin with highest volume
  let pocIdx = 0
  for (let i = 1; i < numBins; i++) {
    if (bins[i] > bins[pocIdx]) pocIdx = i
  }
  const poc = minPrice + (pocIdx + 0.5) * binSize

  // HVN: second highest volume bin (or first bin above POC if tied)
  let hvnIdx = pocIdx === 0 ? 1 : 0
  for (let i = 0; i < numBins; i++) {
    if (i === pocIdx) continue
    if (bins[i] > bins[hvnIdx] || (bins[i] === bins[hvnIdx] && i > pocIdx && hvnIdx <= pocIdx)) {
      hvnIdx = i
    }
  }
  const hvn = minPrice + (hvnIdx + 0.5) * binSize

  // LVN: lowest volume bin in middle 80% of range
  const loEdge = Math.floor(numBins * 0.1)
  const hiEdge = Math.ceil(numBins * 0.9) - 1
  let lvnIdx = loEdge
  for (let i = loEdge + 1; i <= hiEdge; i++) {
    if (bins[i] < bins[lvnIdx]) lvnIdx = i
  }
  const lvn = minPrice + (lvnIdx + 0.5) * binSize

  return {
    poc: round(poc, 2),
    hvn: round(hvn, 2),
    lvn: round(lvn, 2),
  }
}

// -- VWAP --

/**
 * Compute VWAP over the last N bars.
 *
 * @param {Array<{h: number, l: number, c: number, v: number}>} bars
 * @param {number} periodDays - number of trailing bars to use
 * @returns {number|null}
 */
export function computeVwap(bars, periodDays) {
  if (bars.length === 0) return null
  const slice = bars.slice(-periodDays)
  let cumTpv = 0
  let cumVol = 0
  for (const b of slice) {
    const tp = (b.h + b.l + b.c) / 3
    cumTpv += tp * b.v
    cumVol += b.v
  }
  return cumVol > 0 ? round(cumTpv / cumVol, 4) : null
}

/**
 * Get dynamic VWAP period map (includes year-to-date and quarter-to-date).
 *
 * @param {Array<{t: number}>} bars
 * @returns {Record<string, number>}
 */
export function getVwapPeriods(bars) {
  const now = new Date()
  const year = now.getFullYear()

  const jan2Str = `${year}-01-02`
  const jan2Time = new Date(jan2Str).getTime()

  const qMonth = Math.floor(now.getMonth() / 3) * 3
  const qtrStart = new Date(year, qMonth, 1)
  const qtrStartTime = qtrStart.getTime()

  let barsSinceJan2 = 0
  let barsSinceQtr = 0
  for (const b of bars) {
    if (b.t >= jan2Time) barsSinceJan2++
    if (b.t >= qtrStartTime) barsSinceQtr++
  }

  return {
    'vwap_today': 1,
    'vwap_3d': 3,
    'vwap_5d': 5,
    'vwap_1w': 5,
    'vwap_14d': 14,
    'vwap_21d': 21,
    'vwap_1m': 21,
    'vwap_3m': 63,
    'vwap_6m': 126,
    'vwap_1y': 252,
    'vwap_2jan': Math.max(1, barsSinceJan2),
    'vwap_qtr': Math.max(1, barsSinceQtr),
  }
}

// -- Risk Metrics --

function dailyReturns(bars) {
  const returns = []
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c !== 0) {
      returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c)
    }
  }
  return returns
}

function mean(arr) {
  if (arr.length === 0) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

function std(arr) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let s = 0
  for (const v of arr) s += (v - m) * (v - m)
  return Math.sqrt(s / (arr.length - 1))
}

/**
 * Compute annualised Sharpe ratio from daily returns.
 *
 * @param {number[]} returns
 * @returns {number}
 */
export function computeSharpe(returns) {
  const m = mean(returns)
  const s = std(returns)
  if (s === 0) return 0
  return round((m / s) * Math.sqrt(252), 4)
}

/**
 * Compute 95% Value-at-Risk from daily returns (as percentage).
 *
 * @param {number[]} returns
 * @returns {number}
 */
export function computeVar95(returns) {
  if (returns.length === 0) return 0
  const sorted = [...returns].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.05)
  return round(sorted[idx] * 100, 4)
}

/**
 * Compute maximum drawdown from OHLCV bars (as percentage).
 *
 * @param {Array<{c: number}>} bars
 * @returns {number}
 */
export function computeMaxDrawdown(bars) {
  if (bars.length === 0) return 0
  let peak = bars[0].c
  let maxDd = 0
  for (const b of bars) {
    if (b.c > peak) peak = b.c
    const dd = (b.c - peak) / peak
    if (dd < maxDd) maxDd = dd
  }
  return round(maxDd * 100, 4)
}

/**
 * Compute beta relative to SPY returns.
 *
 * @param {number[]} tickerReturns
 * @param {number[]} spyReturns
 * @returns {number}
 */
export function computeBeta(tickerReturns, spyReturns) {
  const n = Math.min(tickerReturns.length, spyReturns.length)
  if (n < 2) return 1.0
  const tr = tickerReturns.slice(-n)
  const sr = spyReturns.slice(-n)

  const mTr = mean(tr)
  const mSr = mean(sr)

  let cov = 0
  let varSpy = 0
  for (let i = 0; i < n; i++) {
    const dt = tr[i] - mTr
    const ds = sr[i] - mSr
    cov += dt * ds
    varSpy += ds * ds
  }
  if (varSpy === 0) return 1.0
  return round(cov / varSpy, 4)
}

// -- EMA Stack --

/**
 * Compute EMA for a given period.
 *
 * @param {Array<{c: number}>} bars
 * @param {number} period
 * @returns {number|null}
 */
export function computeEMA(bars, period) {
  if (bars.length === 0) return null
  const k = 2 / (period + 1)
  let ema = bars[0].c
  for (let i = 1; i < bars.length; i++) {
    ema = bars[i].c * k + ema * (1 - k)
  }
  return round(ema, 4)
}

/**
 * Compute EMA stack (9/21/50) and trend classification.
 *
 * @param {Array<{c: number}>} bars
 * @returns {{ ema9: number|null, ema21: number|null, ema50: number|null, stack: string|null }}
 */
export function computeEmaStack(bars) {
  if (bars.length < 50) return { ema9: null, ema21: null, ema50: null, stack: null }
  const ema9 = computeEMA(bars, 9)
  const ema21 = computeEMA(bars, 21)
  const ema50 = computeEMA(bars, 50)
  let stack = 'Mixed'
  if (ema9 > ema21 && ema21 > ema50) stack = 'Bull 9>21>50'
  else if (ema50 > ema21 && ema21 > ema9) stack = 'Bear 50>21>9'
  return { ema9, ema21, ema50, stack }
}

// -- Main compute for a single ticker --

/**
 * Full metrics computation for a single ticker.
 * Fetches 5 years of daily bars and computes volume profile, multi-period VWAP,
 * risk metrics (Sharpe, VaR, max drawdown, beta), and EMA stack.
 *
 * @param {string} ticker
 * @param {string[]|null} periods - VWAP periods to include, e.g. ['3d','1m','1y']. null = all.
 * @returns {Promise<object>} Full metrics result
 */
export async function computeForTicker(ticker, periods) {
  const apiKey = getApiKey()

  const now = new Date()
  const toDate = formatDate(now)
  const fiveYearsAgo = new Date(now)
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5)
  const fromDate = formatDate(fiveYearsAgo)

  // Fetch ticker bars (and SPY bars for beta)
  const isSpy = ticker.toUpperCase() === 'SPY'
  let tickerData, spyData

  if (isSpy) {
    tickerData = await fetchBars(ticker, fromDate, toDate)
    spyData = tickerData
  } else {
    ;[tickerData, spyData] = await Promise.all([
      fetchBars(ticker, fromDate, toDate),
      fetchBars('SPY', fromDate, toDate),
    ])
  }

  const allBars = tickerData.results || []
  const spyBars = spyData.results || spyData

  if (allBars.length === 0) {
    throw new Error(`No bars returned for ${ticker}`)
  }

  // Last 252 trading days for risk/volume calculations
  const last252 = allBars.slice(-252)
  const spyLast252 = Array.isArray(spyBars) ? spyBars.slice(-252) : []

  // Latest data
  const lastBar = allBars[allBars.length - 1]
  const prevBar = allBars.length >= 2 ? allBars[allBars.length - 2] : null
  const price = lastBar.c
  const change_pct = prevBar ? round(((lastBar.c - prevBar.c) / prevBar.c) * 100, 4) : 0

  // Volume profile from last 252 days
  const volume_profile = computeVolumeProfile(last252)

  // VWAP -- multiple periods
  const allPeriods = getVwapPeriods(allBars)
  const vwap = {}
  for (const [key, days] of Object.entries(allPeriods)) {
    if (periods && periods.length > 0) {
      const shortKey = key.replace('vwap_', '')
      if (!periods.includes(key) && !periods.includes(shortKey)) {
        continue
      }
    }
    vwap[key] = computeVwap(allBars, days)
  }

  // Risk metrics from last 252 days
  const returns252 = dailyReturns(last252)
  const spyReturns252 = dailyReturns(spyLast252)

  const risk_metrics = {
    sharpe: computeSharpe(returns252),
    var_95: computeVar95(returns252),
    max_drawdown: computeMaxDrawdown(last252),
    beta: isSpy ? 1.0 : computeBeta(returns252, spyReturns252),
  }

  // EMA stack from last 252 bars
  const ema_stack = computeEmaStack(last252)

  return {
    ticker: ticker.toUpperCase(),
    computed_at: new Date().toISOString(),
    bars_used: allBars.length,
    price,
    change_pct,
    volume_profile,
    vwap,
    risk_metrics,
    ema_stack,
  }
}
