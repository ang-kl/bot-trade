// Yahoo Finance backtest engine
// Fetches OHLCV data, computes indicators, evaluates abot conditions, simulates trades
// No API keys needed — uses Yahoo Finance public endpoints

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search'

// Map abot timeframes to Yahoo Finance intervals + human-readable range
const TF_MAP = {
  '1m': { interval: '1m', range: '7d', label: '7 days' },
  '5m': { interval: '5m', range: '1mo', label: '1 month' },
  '10m': { interval: '15m', range: '1mo', label: '1 month (15m bars)' },
  '15m': { interval: '15m', range: '2mo', label: '2 months' },
  '30m': { interval: '30m', range: '6mo', label: '6 months' },
  '1h': { interval: '1h', range: '2y', label: '2 years' },
  '4h': { interval: '1h', range: '2y', label: '2 years (4h aggregated)' },
  '1d': { interval: '1d', range: '10y', label: '10 years' },
  '1w': { interval: '1wk', range: '10y', label: '10 years' },
}

// Common broker symbol → Yahoo Finance symbol mapping
// Covers Pepperstone, IC Markets, and other popular CFD brokers
const BROKER_SYMBOL_MAP = {
  // Commodities
  'NATGAS': { yahoo: 'NG=F', name: 'Natural Gas Futures', broker: 'Pepperstone/CFD' },
  'NGAS': { yahoo: 'NG=F', name: 'Natural Gas Futures', broker: 'Pepperstone/CFD' },
  'XAUUSD': { yahoo: 'GC=F', name: 'Gold Futures', broker: 'Pepperstone/CFD' },
  'GOLD': { yahoo: 'GC=F', name: 'Gold Futures', broker: 'Pepperstone/CFD' },
  'XAGUSD': { yahoo: 'SI=F', name: 'Silver Futures', broker: 'Pepperstone/CFD' },
  'SILVER': { yahoo: 'SI=F', name: 'Silver Futures', broker: 'Pepperstone/CFD' },
  'XTIUSD': { yahoo: 'CL=F', name: 'WTI Crude Oil Futures', broker: 'Pepperstone/CFD' },
  'USOIL': { yahoo: 'CL=F', name: 'WTI Crude Oil Futures', broker: 'Pepperstone/CFD' },
  'XBRUSD': { yahoo: 'BZ=F', name: 'Brent Crude Oil Futures', broker: 'Pepperstone/CFD' },
  'UKOIL': { yahoo: 'BZ=F', name: 'Brent Crude Oil Futures', broker: 'Pepperstone/CFD' },
  'XPTUSD': { yahoo: 'PL=F', name: 'Platinum Futures', broker: 'Pepperstone/CFD' },
  'COPPER': { yahoo: 'HG=F', name: 'Copper Futures', broker: 'Pepperstone/CFD' },
  'XCUUSD': { yahoo: 'HG=F', name: 'Copper Futures', broker: 'Pepperstone/CFD' },
  // Indices
  'US500': { yahoo: 'ES=F', name: 'S&P 500 E-mini Futures', broker: 'Pepperstone/CFD' },
  'SPX500': { yahoo: 'ES=F', name: 'S&P 500 E-mini Futures', broker: 'Pepperstone/CFD' },
  'US30': { yahoo: 'YM=F', name: 'Dow Jones E-mini Futures', broker: 'Pepperstone/CFD' },
  'DJ30': { yahoo: 'YM=F', name: 'Dow Jones E-mini Futures', broker: 'Pepperstone/CFD' },
  'US100': { yahoo: 'NQ=F', name: 'Nasdaq 100 E-mini Futures', broker: 'Pepperstone/CFD' },
  'NAS100': { yahoo: 'NQ=F', name: 'Nasdaq 100 E-mini Futures', broker: 'Pepperstone/CFD' },
  'USTEC': { yahoo: 'NQ=F', name: 'Nasdaq 100 E-mini Futures', broker: 'Pepperstone/CFD' },
  'UK100': { yahoo: '^FTSE', name: 'FTSE 100', broker: 'Pepperstone/CFD' },
  'GER40': { yahoo: '^GDAXI', name: 'DAX 40', broker: 'Pepperstone/CFD' },
  'DE40': { yahoo: '^GDAXI', name: 'DAX 40', broker: 'Pepperstone/CFD' },
  'JP225': { yahoo: '^N225', name: 'Nikkei 225', broker: 'Pepperstone/CFD' },
  'AUS200': { yahoo: '^AXJO', name: 'ASX 200', broker: 'Pepperstone/CFD' },
  'HK50': { yahoo: '^HSI', name: 'Hang Seng Index', broker: 'Pepperstone/CFD' },
  'FRA40': { yahoo: '^FCHI', name: 'CAC 40', broker: 'Pepperstone/CFD' },
  'EU50': { yahoo: '^STOXX50E', name: 'Euro Stoxx 50', broker: 'Pepperstone/CFD' },
  'VIX': { yahoo: '^VIX', name: 'CBOE Volatility Index', broker: 'Index' },
  'DXY': { yahoo: 'DX=F', name: 'US Dollar Index Futures', broker: 'Index' },
  'USDX': { yahoo: 'DX=F', name: 'US Dollar Index Futures', broker: 'Index' },
  // Crypto
  'BTCUSD': { yahoo: 'BTC-USD', name: 'Bitcoin', broker: 'Crypto' },
  'ETHUSD': { yahoo: 'ETH-USD', name: 'Ethereum', broker: 'Crypto' },
  'XRPUSD': { yahoo: 'XRP-USD', name: 'Ripple', broker: 'Crypto' },
  'SOLUSD': { yahoo: 'SOL-USD', name: 'Solana', broker: 'Crypto' },
  'DOGEUSD': { yahoo: 'DOGE-USD', name: 'Dogecoin', broker: 'Crypto' },
  'ADAUSD': { yahoo: 'ADA-USD', name: 'Cardano', broker: 'Crypto' },
}

// Resolve symbol: broker map → Yahoo search → forex pair fallback
async function resolveSymbol(input) {
  const key = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

  // 1. Check broker symbol map
  if (BROKER_SYMBOL_MAP[key]) {
    const mapped = BROKER_SYMBOL_MAP[key]
    return {
      yahoo: mapped.yahoo,
      input: input.toUpperCase(),
      name: mapped.name,
      broker: mapped.broker,
      resolved: true,
      message: `"${input.toUpperCase()}" is a ${mapped.broker} symbol. Using Yahoo Finance ticker: ${mapped.yahoo} (${mapped.name})`,
    }
  }

  // 2. If it looks like a 6-char forex pair, try XXXYYY=X
  if (key.length === 6 && /^[A-Z]+$/.test(key)) {
    const yahooSym = key + '=X'
    try {
      const testUrl = `${YAHOO_CHART}/${yahooSym}?interval=1d&range=5d`
      const testRes = await fetch(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      const testData = await testRes.json()
      if (testData.chart?.result?.[0]?.timestamp) {
        return {
          yahoo: yahooSym,
          input: input.toUpperCase(),
          name: `${key.slice(0, 3)}/${key.slice(3)} Forex`,
          broker: 'Forex',
          resolved: true,
          message: null,
        }
      }
    } catch {}
  }

  // 3. Try Yahoo Finance search API
  try {
    const searchUrl = `${YAHOO_SEARCH}?q=${encodeURIComponent(input)}&quotesCount=5&newsCount=0`
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const searchData = await searchRes.json()
    const quotes = searchData.quotes || []
    if (quotes.length > 0) {
      const best = quotes[0]
      return {
        yahoo: best.symbol,
        input: input.toUpperCase(),
        name: best.shortname || best.longname || best.symbol,
        broker: best.quoteType || 'Unknown',
        resolved: true,
        message: `"${input.toUpperCase()}" not recognized as a broker symbol. Found on Yahoo Finance: ${best.symbol} (${best.shortname || best.longname || ''})`,
      }
    }
  } catch {}

  // 4. Last resort: use as-is
  return {
    yahoo: input.toUpperCase(),
    input: input.toUpperCase(),
    name: input.toUpperCase(),
    broker: 'Unknown',
    resolved: false,
    message: `Could not resolve "${input.toUpperCase()}" — trying as-is on Yahoo Finance`,
  }
}

// Map forex pairs to Yahoo Finance format (simple fallback)
function toYahooSymbol(symbol) {
  const s = symbol.replace(/[^A-Za-z0-9=^-]/g, '').toUpperCase()
  if (s.includes('=') || s.includes('^') || s.includes('-')) return s
  if (s.length === 6 && /^[A-Z]+$/.test(s)) return s + '=X'
  return symbol
}

async function fetchOHLCV(symbol, timeframe) {
  const tf = TF_MAP[timeframe] || TF_MAP['1h']
  const ySymbol = toYahooSymbol(symbol)
  const url = `${YAHOO_CHART}/${encodeURIComponent(ySymbol)}?interval=${tf.interval}&range=${tf.range}`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`)
  const data = await res.json()

  const result = data.chart?.result?.[0]
  if (!result?.timestamp) throw new Error('No data returned from Yahoo Finance')

  const quotes = result.indicators.quote[0]
  const bars = result.timestamp.map((ts, i) => ({
    time: new Date(ts * 1000).toISOString(),
    open: quotes.open[i],
    high: quotes.high[i],
    low: quotes.low[i],
    close: quotes.close[i],
    volume: quotes.volume[i] || 0,
  })).filter(b => b.open != null && b.close != null)

  // Aggregate to 4H if needed
  if (timeframe === '4h') return aggregateBars(bars, 4)
  return bars
}

function aggregateBars(bars, factor) {
  const result = []
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor)
    if (chunk.length === 0) continue
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    })
  }
  return result
}

// ─── Indicator computation ───

function computeEMA(closes, period) {
  const k = 2 / (period + 1)
  const result = [closes[0]]
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

function computeSMA(values, period) {
  const result = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    const slice = values.slice(i - period + 1, i + 1)
    result.push(slice.reduce((a, b) => a + b, 0) / period)
  }
  return result
}

function computeRSI(closes, period) {
  const result = Array(closes.length).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff)
  }
  avgGain /= period; avgLoss /= period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function computeMACD(closes, fast, slow, signal) {
  const emaFast = computeEMA(closes, fast)
  const emaSlow = computeEMA(closes, slow)
  const macdLine = emaFast.map((v, i) => v - emaSlow[i])
  const signalLine = computeEMA(macdLine, signal)
  const histogram = macdLine.map((v, i) => v - signalLine[i])
  return { macd: macdLine, signal: signalLine, histogram }
}

function computeBBands(closes, period, deviation) {
  const sma = computeSMA(closes, period)
  const upper = [], lower = []
  for (let i = 0; i < closes.length; i++) {
    if (sma[i] == null) { upper.push(null); lower.push(null); continue }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1)
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - sma[i]) ** 2, 0) / slice.length)
    upper.push(sma[i] + std * deviation)
    lower.push(sma[i] - std * deviation)
  }
  return { middle: sma, upper, lower }
}

function computeATR(bars, period) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low
    const prev = bars[i - 1].close
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev))
  })
  return computeSMA(tr, period)
}

function computeStochastic(bars, kPeriod, dPeriod) {
  const k = []
  for (let i = 0; i < bars.length; i++) {
    if (i < kPeriod - 1) { k.push(null); continue }
    const slice = bars.slice(i - kPeriod + 1, i + 1)
    const high = Math.max(...slice.map(b => b.high))
    const low = Math.min(...slice.map(b => b.low))
    k.push(high === low ? 50 : ((bars[i].close - low) / (high - low)) * 100)
  }
  const d = computeSMA(k.map(v => v ?? 50), dPeriod)
  return { k, d }
}

function computeSupertrend(bars, period, multiplier) {
  const atr = computeATR(bars, period)
  const result = Array(bars.length).fill(null)
  const direction = Array(bars.length).fill(1)
  let upperBand = 0, lowerBand = 0

  for (let i = period; i < bars.length; i++) {
    if (atr[i] == null) continue
    const hl2 = (bars[i].high + bars[i].low) / 2
    const up = hl2 + multiplier * atr[i]
    const dn = hl2 - multiplier * atr[i]

    upperBand = (i > period && dn > lowerBand) ? dn : dn
    lowerBand = (i > period && up < upperBand) ? up : up
    upperBand = dn; lowerBand = up

    if (bars[i].close > lowerBand) {
      direction[i] = 1
      result[i] = upperBand
    } else {
      direction[i] = -1
      result[i] = lowerBand
    }
  }
  return { value: result, direction }
}

// Compute an indicator's values for the given bars
function computeIndicator(indicatorId, params, bars) {
  const closes = bars.map(b => b.close)
  switch (indicatorId) {
    case 'ema': return computeEMA(closes, params.period || 9)
    case 'sma': return computeSMA(closes, params.period || 20)
    case 'dema': { const ema1 = computeEMA(closes, params.period || 20); return computeEMA(ema1, params.period || 20).map((v, i) => 2 * ema1[i] - v) }
    case 'rsi': return computeRSI(closes, params.period || 14)
    case 'macd': return computeMACD(closes, params.fastPeriod || 12, params.slowPeriod || 26, params.signalPeriod || 9)
    case 'bbands': return computeBBands(closes, params.period || 20, params.deviation || 2)
    case 'atr': return computeATR(bars, params.period || 14)
    case 'stochastic': return computeStochastic(bars, params.kPeriod || 14, params.dPeriod || 3)
    case 'supertrend': return computeSupertrend(bars, params.period || 10, params.multiplier || 3)
    case 'adx': {
      const period = params.period || 14
      const atr = computeATR(bars, period)
      const pdm = bars.map((b, i) => i === 0 ? 0 : Math.max(b.high - bars[i-1].high, 0))
      const ndm = bars.map((b, i) => i === 0 ? 0 : Math.max(bars[i-1].low - b.low, 0))
      const pdi = computeSMA(pdm, period).map((v, i) => atr[i] ? (v / atr[i]) * 100 : 0)
      const ndi = computeSMA(ndm, period).map((v, i) => atr[i] ? (v / atr[i]) * 100 : 0)
      const dx = pdi.map((v, i) => (v + ndi[i]) === 0 ? 0 : Math.abs(v - ndi[i]) / (v + ndi[i]) * 100)
      return computeSMA(dx, period)
    }
    case 'price_close': return closes
    case 'price_open': return bars.map(b => b.open)
    case 'price_high': return bars.map(b => b.high)
    case 'price_low': return bars.map(b => b.low)
    case 'price_hl2': return bars.map(b => (b.high + b.low) / 2)
    case 'volume': return bars.map(b => b.volume)
    case 'obv': {
      let obv = 0
      return closes.map((c, i) => {
        if (i === 0) return 0
        obv += c > closes[i-1] ? bars[i].volume : c < closes[i-1] ? -bars[i].volume : 0
        return obv
      })
    }
    default: return closes // fallback
  }
}

// Get scalar value from indicator at index i
function getIndicatorValue(computed, i) {
  if (Array.isArray(computed)) return computed[i]
  // MACD returns object
  if (computed?.macd) return computed.macd[i]
  // BBands returns object
  if (computed?.middle) return computed.middle[i]
  // Stochastic
  if (computed?.k) return computed.k[i]
  // Supertrend
  if (computed?.value) return computed.value[i]
  return null
}

// ─── Condition evaluation ───

function evaluateCondition(op, leftVal, rightVal, prevLeft, prevRight) {
  if (leftVal == null || rightVal == null) return false
  switch (op) {
    case 'crosses_above': return prevLeft != null && prevRight != null && prevLeft <= prevRight && leftVal > rightVal
    case 'crosses_below': return prevLeft != null && prevRight != null && prevLeft >= prevRight && leftVal < rightVal
    case 'is_above': return leftVal > rightVal
    case 'is_below': return leftVal < rightVal
    case 'greater_than': return leftVal > rightVal
    case 'less_than': return leftVal < rightVal
    case 'equals': return Math.abs(leftVal - rightVal) < 0.0001
    case 'is_rising': return prevLeft != null && leftVal > prevLeft
    case 'is_falling': return prevLeft != null && leftVal < prevLeft
    default: return false
  }
}

// ─── Main backtest engine ───

function runBacktest(bars, indicators, conditions, risk) {
  // Compute all indicator values upfront
  const computed = {}
  for (const ind of indicators) {
    computed[ind.instanceId] = computeIndicator(ind.id, ind.paramValues || {}, bars)
  }

  const trades = []
  let inPosition = false
  let entryBar = null
  let entryPrice = 0
  let direction = 'BUY'
  const slMultiplier = risk?.stopLoss?.value || 1.5
  const tpMultiplier = risk?.takeProfit?.value || 2
  const atr = computeATR(bars, 14)

  // Walk through bars
  for (let i = 50; i < bars.length; i++) {
    if (inPosition) {
      // Check exit: SL/TP based on ATR
      const atrVal = atr[i] || (bars[i].high - bars[i].low)
      const sl = slMultiplier * atrVal
      const tp = tpMultiplier * sl

      let exitPrice = null
      let exitReason = ''

      if (direction === 'BUY') {
        if (bars[i].low <= entryPrice - sl) { exitPrice = entryPrice - sl; exitReason = 'SL' }
        else if (bars[i].high >= entryPrice + tp) { exitPrice = entryPrice + tp; exitReason = 'TP' }
      } else {
        if (bars[i].high >= entryPrice + sl) { exitPrice = entryPrice + sl; exitReason = 'SL' }
        else if (bars[i].low <= entryPrice - tp) { exitPrice = entryPrice - tp; exitReason = 'TP' }
      }

      if (exitPrice) {
        const pnl = direction === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice
        const pips = Math.round(pnl * (bars[i].close > 10 ? 100 : 10000) * 10) / 10
        trades.push({
          id: trades.length + 1,
          symbol: 'BACKTEST',
          direction,
          entryTime: entryBar.time,
          exitTime: bars[i].time,
          entryPrice: Math.round(entryPrice * 100000) / 100000,
          exitPrice: Math.round(exitPrice * 100000) / 100000,
          pips,
          netProfit: Math.round(pnl * 10000 * (risk?.positionSize?.value || 1)) / 100,
          exitReason,
        })
        inPosition = false
      }
      continue
    }

    // Check entry conditions
    if (conditions.length === 0) continue

    let entrySignal = true
    for (const cond of conditions) {
      const leftComputed = computed[cond.leftIndicator]
      if (!leftComputed) { entrySignal = false; break }

      const leftVal = getIndicatorValue(leftComputed, i)
      const prevLeft = getIndicatorValue(leftComputed, i - 1)

      let rightVal, prevRight
      if (cond.rightType === 'indicator') {
        const rightComputed = computed[cond.rightIndicator]
        if (!rightComputed) { entrySignal = false; break }
        rightVal = getIndicatorValue(rightComputed, i)
        prevRight = getIndicatorValue(rightComputed, i - 1)
      } else {
        rightVal = cond.rightValue
        prevRight = cond.rightValue
      }

      const result = evaluateCondition(cond.operator, leftVal, rightVal, prevLeft, prevRight)

      if (cond.logic === 'OR') {
        if (result) { entrySignal = true; break }
      } else {
        if (!result) { entrySignal = false; break }
      }
    }

    if (entrySignal) {
      inPosition = true
      entryBar = bars[i]
      entryPrice = bars[i].close
      // Determine direction from first condition
      const firstCond = conditions[0]
      direction = (firstCond.operator === 'crosses_above' || firstCond.operator === 'is_above' || firstCond.operator === 'is_rising') ? 'BUY' : 'SELL'
    }
  }

  return trades
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { symbol, timeframe, indicators: strategyIndicators, conditions, risk } = req.body

  if (!symbol) return res.status(400).json({ error: 'Symbol is required (e.g. EURUSD, BTCUSD, NATGAS, AAPL)' })
  if (!conditions?.length) return res.status(400).json({ error: 'At least one entry condition is required' })

  try {
    const tf = timeframe || '1h'
    const tfInfo = TF_MAP[tf] || TF_MAP['1h']

    // Resolve broker symbol to Yahoo Finance symbol
    const symbolInfo = await resolveSymbol(symbol)
    const bars = await fetchOHLCV(symbolInfo.yahoo, tf)

    if (bars.length < 100) {
      return res.status(400).json({ error: `Only ${bars.length} bars returned — need at least 100 for meaningful backtest` })
    }

    const trades = runBacktest(bars, strategyIndicators || [], conditions, risk)

    // Calculate stats using same format as backtest-import.js
    let balance = 0
    for (const t of trades) {
      balance += t.netProfit
      t.runningBalance = Math.round(balance * 100) / 100
    }

    const wins = trades.filter(t => t.netProfit > 0)
    const losses = trades.filter(t => t.netProfit <= 0)
    const totalProfit = wins.reduce((s, t) => s + t.netProfit, 0)
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netProfit, 0))

    // Max drawdown
    let peak = 0, maxDD = 0
    balance = 0
    for (const t of trades) {
      balance += t.netProfit
      if (balance > peak) peak = balance
      const dd = peak - balance
      if (dd > maxDD) maxDD = dd
    }

    // Streaks
    let winStreak = 0, loseStreak = 0, maxWinStreak = 0, maxLoseStreak = 0
    for (const t of trades) {
      if (t.netProfit > 0) { winStreak++; loseStreak = 0; if (winStreak > maxWinStreak) maxWinStreak = winStreak }
      else { loseStreak++; winStreak = 0; if (loseStreak > maxLoseStreak) maxLoseStreak = loseStreak }
    }

    const avgWin = wins.length > 0 ? totalProfit / wins.length : 0
    const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0
    const netPnl = totalProfit - totalLoss
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0

    // Sharpe
    const returns = trades.map(t => t.netProfit)
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
    const variance = returns.length > 0 ? returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length : 0
    const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0

    const expectancy = trades.length > 0 ? (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss : 0

    const stats = {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(profitFactor * 100) / 100,
      netProfit: Math.round(netPnl * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      maxDrawdownPct: peak > 0 ? Math.round((maxDD / peak) * 1000) / 10 : 0,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      avgRR: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : 0,
      longestWinStreak: maxWinStreak,
      longestLoseStreak: maxLoseStreak,
      expectancy: Math.round(expectancy * 100) / 100,
    }

    // Equity curve
    balance = 0
    const equity = [{ trade: 0, balance: 0 }, ...trades.map((t, i) => {
      balance += t.netProfit
      return { trade: i + 1, balance: Math.round(balance * 100) / 100 }
    })]

    // Compute actual date range from bars
    const firstBar = bars[0]?.time || ''
    const lastBar = bars[bars.length - 1]?.time || ''

    res.status(200).json({
      symbol: symbolInfo.yahoo,
      inputSymbol: symbolInfo.input,
      symbolName: symbolInfo.name,
      symbolBroker: symbolInfo.broker,
      symbolMessage: symbolInfo.message,
      timeframe: tf,
      dataRange: tfInfo.label,
      dateFrom: firstBar,
      dateTo: lastBar,
      bars: bars.length,
      trades,
      stats,
      equity,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
