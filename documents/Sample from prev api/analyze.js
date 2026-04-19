// Claude-powered market analysis for the AI Advisor strategy.
//
// Takes market data + symbol info, sends a structured prompt to Claude,
// parses Claude's JSON response, and returns a trade recommendation.
//
// Request body:
//   {
//     symbol: 'BTCUSD',
//     currentPrice: 71535.24,
//     h1Candles: [{t, o, h, l, c, v}, ...], // last 50 H1 bars
//     m1Candles: [{t, o, h, l, c, v}, ...], // last 60 M1 bars
//     accountBalance: 1779.03,
//     brokerMinVolume: 1,
//     brokerMaxVolume: 100,
//   }
//
// Response:
//   {
//     direction: 'BUY' | 'SELL' | 'NO_TRADE',
//     confidence: 1..10,
//     reasoning: [string],
//     timeHorizon: 'minutes' | 'hours' | 'days',
//     invalidationLevel: number | null,
//     expectedMagnitude: { min, max } | null,
//     suggestedParams: {
//       lotSize: int,
//       numTrades: int,
//       periodPerTrade: '30s'|'1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'1d'|'1w'|'1M',
//       riskTolerance: number
//     },
//     rawText: string   // fallback if JSON parse fails
//   }
//
// Falls back to a deterministic mock response if ANTHROPIC_API_KEY is not
// set (so the UI can be tested without burning API credits).

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-5'

// Compact indicator calculations so we can include them in the prompt
// without forcing Claude to derive them from raw bars.
function sma(values, period) {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function ema(values, period) {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gains += d
    else losses -= d
  }
  let avgG = gains / period, avgL = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgL === 0) return 100
  const rs = avgG / avgL
  return 100 - 100 / (1 + rs)
}

// ── Volume profile ──
// Bins candle volume into N price buckets and identifies:
//   POC (Point of Control) — bucket with the highest volume
//   HVN (High Volume Nodes) — buckets with top-30% volume
//   LVN (Low Volume Nodes) — buckets with bottom-20% volume
// Takes candle OHLCV data; volume is spread uniformly across the candle's range.
function volumeProfile(candles, numBuckets = 20) {
  if (!candles || candles.length === 0) return null
  const high = Math.max(...candles.map(c => c.h))
  const low = Math.min(...candles.map(c => c.l))
  if (high <= low) return null
  const bucketSize = (high - low) / numBuckets
  const buckets = new Array(numBuckets).fill(0)
  for (const c of candles) {
    const vol = c.v || 0
    if (vol === 0) continue
    // Spread this candle's volume across all buckets the candle intersects
    const lowIdx = Math.max(0, Math.floor((c.l - low) / bucketSize))
    const highIdx = Math.min(numBuckets - 1, Math.floor((c.h - low) / bucketSize))
    const numTouched = highIdx - lowIdx + 1
    const perBucket = vol / numTouched
    for (let i = lowIdx; i <= highIdx; i++) buckets[i] += perBucket
  }
  // Find POC
  let pocIdx = 0
  for (let i = 1; i < numBuckets; i++) if (buckets[i] > buckets[pocIdx]) pocIdx = i
  const poc = low + (pocIdx + 0.5) * bucketSize
  const totalVol = buckets.reduce((a, b) => a + b, 0)
  if (totalVol === 0) return { poc, hvn: [], lvn: [] }
  // HVN = top 30% by volume; LVN = bottom 20%
  const sorted = buckets.map((v, i) => ({ v, price: low + (i + 0.5) * bucketSize })).sort((a, b) => b.v - a.v)
  const hvnCount = Math.max(1, Math.floor(numBuckets * 0.3))
  const lvnCount = Math.max(1, Math.floor(numBuckets * 0.2))
  const hvn = sorted.slice(0, hvnCount).map(b => b.price).sort((a, b) => a - b)
  const lvn = sorted.slice(-lvnCount).map(b => b.price).sort((a, b) => a - b)
  return { poc, hvn, lvn }
}

// ── VWAP (session-based) ──
// Cumulative (typical price × volume) / cumulative volume.
// Typical price = (H + L + C) / 3
function vwap(candles) {
  if (!candles || candles.length === 0) return null
  let pv = 0, v = 0
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3
    const vol = c.v || 0
    pv += tp * vol
    v += vol
  }
  if (v === 0) return null
  return pv / v
}

// ── Anchored VWAP ──
// Same as VWAP but from a specific anchor candle index.
// Anchor defaults to the candle with the highest volume in the series (the
// most significant "origin point" the market is pricing from).
function anchoredVwap(candles) {
  if (!candles || candles.length === 0) return null
  // Find the anchor — highest-volume candle in the series
  let anchorIdx = 0
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i].v || 0) > (candles[anchorIdx].v || 0)) anchorIdx = i
  }
  const fromAnchor = candles.slice(anchorIdx)
  const anchorPrice = candles[anchorIdx].c
  const anchorTime = candles[anchorIdx].t
  return {
    anchorPrice,
    anchorTime,
    anchorIdx,
    value: vwap(fromAnchor),
  }
}

// Build the prompt Claude will see. Structured for reliable JSON output.
function buildPrompt({ symbol, currentPrice, h1Candles, m1Candles, accountBalance, brokerMinVolume, brokerMaxVolume }) {
  const h1Closes = h1Candles.map(c => c.c)
  const m1Closes = m1Candles.map(c => c.c)

  // Indicators — classic
  const stats = {
    currentPrice,
    h1: {
      ema20: ema(h1Closes, 20),
      ema50: ema(h1Closes, 50),
      sma200: sma(h1Closes, 200),
      atr14: atr(h1Candles, 14),
      rsi14: rsi(h1Closes, 14),
      sessionHigh: Math.max(...h1Candles.slice(-24).map(c => c.h)),
      sessionLow: Math.min(...h1Candles.slice(-24).map(c => c.l)),
    },
    m1: {
      ema9: ema(m1Closes, 9),
      ema21: ema(m1Closes, 21),
      atr14: atr(m1Candles, 14),
      rsi14: rsi(m1Closes, 14),
      last5minMove: m1Candles.length >= 5 ? currentPrice - m1Candles[m1Candles.length - 5].c : 0,
      last15minMove: m1Candles.length >= 15 ? currentPrice - m1Candles[m1Candles.length - 15].c : 0,
    },
  }

  // Volume profile + VWAP + Anchored VWAP (computed from H1 for more stable profile)
  const vp = volumeProfile(h1Candles, 20)
  const sessionVwap = vwap(h1Candles.slice(-24))  // last 24 hours
  const fullVwap = vwap(h1Candles)                // full window
  const anchored = anchoredVwap(h1Candles)

  const recentH1 = h1Candles.slice(-10).map(c =>
    `${new Date(c.t).toISOString().slice(0, 16)}  O:${c.o.toFixed(2)}  H:${c.h.toFixed(2)}  L:${c.l.toFixed(2)}  C:${c.c.toFixed(2)}`
  ).join('\n')

  const vpSection = vp ? `
### Volume Profile (H1, last ${h1Candles.length} bars)
- POC (Point of Control): $${vp.poc.toFixed(2)} ${currentPrice > vp.poc ? '(price ABOVE POC)' : '(price BELOW POC)'}
- HVN (High Volume Nodes, top 30%): ${vp.hvn.slice(0, 5).map(p => '$' + p.toFixed(2)).join(', ')}
- LVN (Low Volume Nodes, bottom 20%): ${vp.lvn.slice(0, 5).map(p => '$' + p.toFixed(2)).join(', ')}` : '\n### Volume Profile: n/a (insufficient volume data)'

  const vwapSection = `
### VWAP
- Session VWAP (last 24h): ${sessionVwap != null ? '$' + sessionVwap.toFixed(2) + (currentPrice > sessionVwap ? ' (price ABOVE VWAP)' : ' (price BELOW VWAP)') : 'n/a'}
- Full-window VWAP: ${fullVwap != null ? '$' + fullVwap.toFixed(2) : 'n/a'}
- Anchored VWAP: ${anchored?.value != null ? '$' + anchored.value.toFixed(2) + ' (anchored at ' + new Date(anchored.anchorTime).toISOString().slice(0, 16) + ', price $' + anchored.anchorPrice.toFixed(2) + ' — highest volume candle in window)' : 'n/a'}`

  return `You are a professional crypto futures analyst. Analyze the following live ${symbol} market data and produce a trade recommendation.

## Current state
- Symbol: ${symbol}
- Current price: $${currentPrice.toFixed(2)}
- Account balance: $${accountBalance.toFixed(2)}
- Broker volume range: ${brokerMinVolume} to ${brokerMaxVolume} units
- UTC time: ${new Date().toISOString()}

## Computed indicators

### H1 (1-hour)
- EMA(20): $${stats.h1.ema20?.toFixed(2) ?? 'n/a'}
- EMA(50): $${stats.h1.ema50?.toFixed(2) ?? 'n/a'}
- SMA(200): $${stats.h1.sma200?.toFixed(2) ?? 'n/a'}
- ATR(14): $${stats.h1.atr14?.toFixed(2) ?? 'n/a'}
- RSI(14): ${stats.h1.rsi14?.toFixed(1) ?? 'n/a'}
- Last 24h high: $${stats.h1.sessionHigh.toFixed(2)}
- Last 24h low: $${stats.h1.sessionLow.toFixed(2)}

### M1 (1-minute)
- EMA(9): $${stats.m1.ema9?.toFixed(2) ?? 'n/a'}
- EMA(21): $${stats.m1.ema21?.toFixed(2) ?? 'n/a'}
- ATR(14): $${stats.m1.atr14?.toFixed(2) ?? 'n/a'}
- RSI(14): ${stats.m1.rsi14?.toFixed(1) ?? 'n/a'}
- Last 5-min move: ${stats.m1.last5minMove >= 0 ? '+' : ''}$${stats.m1.last5minMove.toFixed(2)}
- Last 15-min move: ${stats.m1.last15minMove >= 0 ? '+' : ''}$${stats.m1.last15minMove.toFixed(2)}

${vpSection}
${vwapSection}

## Recent H1 bars (last 10)
${recentH1}

## Your task

Based on the data above, recommend a trade. You must respond with ONLY valid JSON in this exact schema (no markdown fences, no prose outside the JSON):

{
  "direction": "BUY" | "SELL" | "NO_TRADE",
  "confidence": <integer 1-10>,
  "reasoning": [<3-5 short bullet-point strings>],
  "timeHorizon": "minutes" | "hours" | "days",
  "invalidationLevel": <price where the thesis is wrong, or null>,
  "expectedMagnitude": { "min": <dollars>, "max": <dollars> },
  "suggestedParams": {
    "lotSize": <integer between ${brokerMinVolume} and ${brokerMaxVolume}>,
    "numTrades": <integer 1-30>,
    "periodPerTrade": "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w" | "1M",
    "riskTolerance": <percentage 0.01 to 20>
  }
}

## Rules
- Return NO_TRADE if signals are genuinely mixed or you have low confidence (<4/10).
- USE the Volume Profile and VWAP indicators in your reasoning when relevant:
  • POC is the fair-value magnet — price tends to revisit it
  • HVN levels are where institutions accumulated — expect strong reactions
  • LVN levels are where price moved fast — expect continuations through them
  • Price above session VWAP is bullish context; below is bearish
  • Anchored VWAP from the highest-volume candle shows the true "reference price" institutions are defending
- At least ONE reasoning bullet should reference VP/VWAP if meaningful data is available.
- suggestedParams should match the timeHorizon: short horizons → small numTrades + short periods; long horizons → fewer larger trades.
- riskTolerance should reflect your confidence: low confidence → low risk (0.5% or less).
- invalidationLevel must be a price BEYOND entry in the direction opposite to your trade (for BUY: below current; for SELL: above current).
- Do NOT include explanations outside the JSON. The response must parse as JSON.`
}

// Safely extract JSON from Claude's response (handles stray whitespace,
// ``` fences, or leading/trailing text).
function extractJson(text) {
  if (!text) return null
  // Strip ``` code fences if present
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()
  // Find the outermost JSON object
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

// Mock fallback when ANTHROPIC_API_KEY is missing — returns a deterministic
// response so the UI works for development.
function mockResponse(body) {
  const price = body.currentPrice || 70000
  const last5 = body.m1Candles?.length >= 5
    ? price - body.m1Candles[body.m1Candles.length - 5].c
    : 0
  const dir = last5 > 20 ? 'BUY' : last5 < -20 ? 'SELL' : 'NO_TRADE'
  return {
    direction: dir,
    confidence: dir === 'NO_TRADE' ? 3 : 5,
    reasoning: [
      '(MOCK) ANTHROPIC_API_KEY not set on the server',
      `(MOCK) Fell back to a simple 5-min delta check: ${last5.toFixed(2)}`,
      '(MOCK) Set the API key in Vercel env vars to get real AI analysis',
    ],
    timeHorizon: 'minutes',
    invalidationLevel: dir === 'BUY' ? price - 500 : dir === 'SELL' ? price + 500 : null,
    expectedMagnitude: { min: 100, max: 500 },
    suggestedParams: {
      lotSize: body.brokerMinVolume || 1,
      numTrades: 2,
      periodPerTrade: '5m',
      riskTolerance: 1.0,
    },
    mock: true,
  }
}

// ── Feasibility check mode ──
// User provides: symbol, direction, intent (free text), selected indicators
// with their current values. Claude returns: verdict + reasoning + market
// state summary + suggestions.

function buildFeasibilityPrompt({ symbol, currentPrice, direction, lotSize, period, slPrice, tpPrice, intent, indicators, marketState }) {
  const indicatorLines = (indicators || []).map((ind, i) => {
    const params = ind.params ? JSON.stringify(ind.params) : '{}'
    const valueStr = ind.displayValue || JSON.stringify(ind.value) || 'n/a'
    return `${i + 1}. ${ind.name} ${params} → ${valueStr}`
  }).join('\n')

  return `You are a professional trading strategy validator. A user has described a trade idea and picked indicators. Check if the idea is FEASIBLE given current market conditions.

## Proposed trade
- Symbol: ${symbol}
- Current price: $${currentPrice.toFixed(2)}
- Direction: ${direction}
- Lot size: ${lotSize}
- Hold period: ${period}
- Stop loss: ${slPrice != null ? '$' + slPrice.toFixed(2) : '(not set)'}
- Take profit: ${tpPrice != null ? '$' + tpPrice.toFixed(2) : '(not set)'}

## User's strategy intent (free text)
${intent || '(not provided)'}

## Indicators the user selected (with current values)
${indicatorLines || '(none selected)'}

## Current market state snapshot
${marketState || '(none)'}

## Your task

Validate this trade idea. Produce a feasibility verdict considering BOTH:
  (1) Is the strategy theoretically sound? (sanity check)
  (2) Does the CURRENT market state support entering this trade RIGHT NOW?

Respond with ONLY valid JSON in this exact schema (no markdown fences, no prose outside the JSON):

{
  "verdict": "FEASIBLE" | "PARTIAL" | "NOT_FEASIBLE",
  "confidence": <integer 1-10>,
  "sanityCheck": "<1-2 sentence assessment of whether the strategy makes sense in general>",
  "currentStateCheck": "<1-2 sentence assessment of whether CURRENT market conditions support entry>",
  "reasoning": [<3-5 short bullet-point strings citing specific indicator values and market observations>],
  "concerns": [<0-3 short bullet-point strings describing risks or contradictions>],
  "suggestions": [<0-3 short bullet-point strings with adjustments if verdict is PARTIAL or NOT_FEASIBLE>],
  "riskRewardRatio": <number or null — computed from user's SL/TP if both provided, e.g. (TP-entry)/(entry-SL) for BUY>
}

## Rules
- FEASIBLE: strategy is sound AND current state supports entry. User should proceed.
- PARTIAL: strategy is sound BUT current state is ambiguous or weak — flag it, user should wait or adjust.
- NOT_FEASIBLE: strategy is flawed OR current state directly contradicts the trade direction.
- Reference specific indicator values in reasoning (e.g. "RSI at 78 is overbought, contradicts BUY direction").
- If the user provided an intent, check it against the indicators. If indicators don't match the intent, call it out.
- If riskRewardRatio is < 1.0 and both SL/TP provided, flag as a concern regardless of other factors.
- Do NOT include explanations outside the JSON. The response must parse as JSON.`
}

function mockFeasibilityResponse(body) {
  return {
    verdict: 'PARTIAL',
    confidence: 5,
    sanityCheck: '(MOCK) ANTHROPIC_API_KEY not set on the server — this is a placeholder response.',
    currentStateCheck: '(MOCK) Cannot verify current state without Claude API.',
    reasoning: [
      '(MOCK) Set ANTHROPIC_API_KEY in Vercel env vars for real feasibility checks',
      `(MOCK) You proposed ${body.direction || '?'} ${body.symbol || '?'} at $${body.currentPrice?.toFixed(2) || '?'}`,
      `(MOCK) ${(body.indicators || []).length} indicators selected`,
    ],
    concerns: ['(MOCK) No real validation performed'],
    suggestions: ['Configure ANTHROPIC_API_KEY in Vercel and redeploy'],
    riskRewardRatio: null,
    mock: true,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' })
  }

  const body = req.body || {}
  if (!body.symbol || typeof body.currentPrice !== 'number') {
    return res.status(400).json({ error: 'symbol and currentPrice are required' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY

  // ── Feasibility mode ── (Manual strategy's multi-conditions check)
  // Triggered by body.mode === 'feasibility'. Different prompt, different schema.
  if (body.mode === 'feasibility') {
    if (!apiKey) {
      return res.status(200).json(mockFeasibilityResponse(body))
    }
    try {
      const client = new Anthropic({ apiKey })
      const prompt = buildFeasibilityPrompt(body)

      // Same retry loop as the main analyze flow
      let response
      const maxRetries = 3
      const baseDelay = 2000
      let lastError = null
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          response = await client.messages.create({
            model: MODEL,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          })
          break
        } catch (err) {
          lastError = err
          const msg = err?.message || ''
          const status = err?.status || err?.statusCode || 0
          const isOverloaded = status === 529 || status === 503 || status === 429
            || msg.includes('overloaded') || msg.includes('Overloaded') || msg.includes('rate_limit')
          if (!isOverloaded || attempt === maxRetries) throw err
          const delay = baseDelay * Math.pow(2, attempt)
          await new Promise(r => setTimeout(r, delay))
        }
      }
      if (!response) throw lastError || new Error('Feasibility check failed after retries')

      const text = response.content?.[0]?.text || ''
      const parsed = extractJson(text)
      if (!parsed || !parsed.verdict) {
        return res.status(200).json({
          verdict: 'NOT_FEASIBLE',
          confidence: 0,
          sanityCheck: 'Claude returned a response but it did not parse as the expected schema.',
          currentStateCheck: '',
          reasoning: ['Parse error — check server logs'],
          concerns: [],
          suggestions: ['Retry or adjust your strategy description'],
          riskRewardRatio: null,
          rawText: text.slice(0, 500),
          parseError: true,
        })
      }
      return res.status(200).json(parsed)
    } catch (err) {
      return res.status(500).json({ error: `Feasibility check failed: ${err.message}` })
    }
  }

  if (!apiKey) {
    return res.status(200).json(mockResponse(body))
  }

  try {
    const client = new Anthropic({ apiKey })
    const prompt = buildPrompt(body)

    // Retry loop for transient overload errors (529) with exponential backoff.
    // Anthropic returns 529 "Overloaded" during traffic spikes — the fix is
    // to wait and retry, not fail the user's request.
    let response
    const maxRetries = 3
    const baseDelay = 2000
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        })
        break // success
      } catch (err) {
        lastError = err
        // Check if it's a retryable overload / rate limit
        const msg = err?.message || ''
        const status = err?.status || err?.statusCode || 0
        const isOverloaded = status === 529 || status === 503 || status === 429
          || msg.includes('overloaded') || msg.includes('Overloaded') || msg.includes('rate_limit')
        if (!isOverloaded || attempt === maxRetries) throw err
        // Exponential backoff: 2s, 4s, 8s
        const delay = baseDelay * Math.pow(2, attempt)
        console.warn(`Anthropic overloaded (attempt ${attempt + 1}/${maxRetries + 1}) — waiting ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
    if (!response) throw lastError || new Error('Analysis failed after retries')

    const text = response.content?.[0]?.text || ''
    const parsed = extractJson(text)

    if (!parsed || !parsed.direction) {
      return res.status(200).json({
        direction: 'NO_TRADE',
        confidence: 0,
        reasoning: ['Claude returned a response but it did not parse as the expected JSON schema.'],
        timeHorizon: 'minutes',
        invalidationLevel: null,
        expectedMagnitude: null,
        suggestedParams: {
          lotSize: body.brokerMinVolume || 1,
          numTrades: 1,
          periodPerTrade: '5m',
          riskTolerance: 0.5,
        },
        rawText: text.slice(0, 500),
        parseError: true,
      })
    }

    return res.status(200).json(parsed)
  } catch (err) {
    return res.status(500).json({ error: `Analysis failed: ${err.message}` })
  }
}
