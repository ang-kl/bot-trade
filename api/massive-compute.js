// Massive (Polygon.io) compute endpoint.
// Fetches historical OHLCV data and computes trading metrics:
// volume profile, multi-period VWAP, risk metrics (Sharpe, VaR, max drawdown, beta).

const BASE = 'https://api.polygon.io'

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
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

// ── Helpers ──

function formatDate(d) {
  return d.toISOString().slice(0, 10)
}

function fetchBars(ticker, fromDate, toDate, apiKey) {
  const path = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fromDate}/${toDate}`
  return massiveGet(path, apiKey, { adjusted: true, sort: 'asc', limit: 50000 })
}

// ── Volume Profile ──

function computeVolumeProfile(bars) {
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

// ── VWAP ──

function computeVwap(bars, periodDays) {
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

function getVwapPeriods(bars) {
  // Determine dynamic periods: 2jan = days since Jan 2 of current year, qtr = days since quarter start
  const now = new Date()
  const year = now.getFullYear()

  // Find Jan 2 of this year in bars
  const jan2Str = `${year}-01-02`
  const jan2Time = new Date(jan2Str).getTime()

  // Quarter start
  const qMonth = Math.floor(now.getMonth() / 3) * 3 // 0, 3, 6, 9
  const qtrStart = new Date(year, qMonth, 1)
  const qtrStartTime = qtrStart.getTime()

  // Count bars since jan2 and quarter start
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

// ── Risk Metrics ──

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

function computeSharpe(returns) {
  const m = mean(returns)
  const s = std(returns)
  if (s === 0) return 0
  return round((m / s) * Math.sqrt(252), 4)
}

function computeVar95(returns) {
  if (returns.length === 0) return 0
  const sorted = [...returns].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.05)
  return round(sorted[idx] * 100, 4)
}

function computeMaxDrawdown(bars) {
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

function computeBeta(tickerReturns, spyReturns) {
  // Align lengths (use the shorter)
  const n = Math.min(tickerReturns.length, spyReturns.length)
  if (n < 2) return 1.0
  // Use the last n returns from each
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

// ── EMA Stack ──

function computeEMA(bars, period) {
  if (bars.length === 0) return null
  const k = 2 / (period + 1)
  let ema = bars[0].c
  for (let i = 1; i < bars.length; i++) {
    ema = bars[i].c * k + ema * (1 - k)
  }
  return round(ema, 4)
}

function computeEmaStack(bars) {
  if (bars.length < 50) return { ema9: null, ema21: null, ema50: null, stack: null }
  const ema9 = computeEMA(bars, 9)
  const ema21 = computeEMA(bars, 21)
  const ema50 = computeEMA(bars, 50)
  let stack = 'Mixed'
  if (ema9 > ema21 && ema21 > ema50) stack = 'Bull 9>21>50'
  else if (ema50 > ema21 && ema21 > ema9) stack = 'Bear 50>21>9'
  return { ema9, ema21, ema50, stack }
}

function round(n, d) {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}

// ── Main compute for a single ticker ──

async function computeForTicker(ticker, apiKey, requestedPeriods, spyBarsCache) {
  const now = new Date()
  const toDate = formatDate(now)
  const fiveYearsAgo = new Date(now)
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5)
  const fromDate = formatDate(fiveYearsAgo)

  // Fetch ticker bars (and SPY bars if needed)
  const isSpy = ticker.toUpperCase() === 'SPY'
  let tickerData, spyData

  if (isSpy) {
    tickerData = await fetchBars(ticker, fromDate, toDate, apiKey)
    spyData = tickerData
  } else if (spyBarsCache) {
    tickerData = await fetchBars(ticker, fromDate, toDate, apiKey)
    spyData = spyBarsCache
  } else {
    ;[tickerData, spyData] = await Promise.all([
      fetchBars(ticker, fromDate, toDate, apiKey),
      fetchBars('SPY', fromDate, toDate, apiKey),
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

  // VWAP — multiple periods
  const allPeriods = getVwapPeriods(allBars)
  const vwap = {}
  for (const [key, days] of Object.entries(allPeriods)) {
    if (requestedPeriods && requestedPeriods.length > 0) {
      // Check if this period was requested
      // Accept both 'vwap_3d' and '3d' forms
      const shortKey = key.replace('vwap_', '')
      if (!requestedPeriods.includes(key) && !requestedPeriods.includes(shortKey)) {
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
    _spyBarsCache: spyData, // internal: for batch reuse
  }
}

// ── Handler ──

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const apiKey = body.apiKey // MASSIVE_API_KEY env fallback disabled — no longer in use
  if (!apiKey) return res.status(400).json({ error: 'Massive API key required' })

  const action = body.action
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    // ── Single ticker compute ──
    if (action === 'compute') {
      const { ticker, periods } = body
      if (!ticker) return res.status(400).json({ error: 'ticker required' })

      const result = await computeForTicker(ticker, apiKey, periods, null)
      // Remove internal cache key
      delete result._spyBarsCache
      return res.status(200).json(result)
    }

    // ── Batch compute ──
    if (action === 'batch-compute') {
      const { tickers, periods } = body
      if (!tickers || !Array.isArray(tickers) || tickers.length === 0) {
        return res.status(400).json({ error: 'tickers array required' })
      }

      // Pre-fetch SPY bars once for all tickers
      const now = new Date()
      const toDate = formatDate(now)
      const fiveYearsAgo = new Date(now)
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5)
      const fromDate = formatDate(fiveYearsAgo)

      const spyData = await fetchBars('SPY', fromDate, toDate, apiKey)
      const spyBarsCache = spyData

      const results = {}
      const batchSize = 5

      for (let i = 0; i < tickers.length; i += batchSize) {
        const batch = tickers.slice(i, i + batchSize)
        const batchResults = await Promise.all(
          batch.map(async (t) => {
            try {
              const r = await computeForTicker(t, apiKey, periods, spyBarsCache)
              delete r._spyBarsCache
              return { ticker: t.toUpperCase(), result: r, error: null }
            } catch (e) {
              return { ticker: t.toUpperCase(), result: null, error: e.message }
            }
          })
        )
        for (const br of batchResults) {
          results[br.ticker] = br.error ? { error: br.error } : br.result
        }
      }

      return res.status(200).json({ results })
    }

    return res.status(400).json({ error: `unknown action: ${action}` })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'compute failed' })
  }
}
