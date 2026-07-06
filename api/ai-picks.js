// AI Picks — uses Massive to fetch index constituents, then Claude to pick
// the best setups. Called from the Watchlist tab.
//
// Actions:
//   - constituents: Fetch tickers from an index (US30, US500)
//   - pick:         Use Claude to select top N from a list with price data

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-5'

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

async function massiveGet(path, apiKey, params = {}) {
  const url = new URL(path, 'https://api.polygon.io')
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `Massive API ${res.status}`)
  return data
}

// Known index compositions — Massive doesn't have a direct "index constituents"
// endpoint, but we can search for tickers or use reference data.
// For US30 (Dow 30), we have a known list. For US500, we search top tickers.
const DOW30 = [
  'AAPL', 'AMGN', 'AMZN', 'AXP', 'BA', 'CAT', 'CRM', 'CSCO', 'CVX', 'DIS',
  'GS', 'HD', 'HON', 'IBM', 'INTC', 'JNJ', 'JPM', 'KO', 'MCD', 'MMM',
  'MRK', 'MSFT', 'NKE', 'NVDA', 'PG', 'SHW', 'TRV', 'UNH', 'V', 'WMT',
]

async function getConstituents(index, apiKey) {
  const idx = index.toUpperCase().replace(/[^A-Z0-9]/g, '')

  if (idx === 'US30' || idx === 'DOW' || idx === 'DOW30' || idx === 'DJIA') {
    return DOW30
  }

  if (idx === 'US500' || idx === 'SP500' || idx === 'SPX') {
    // Fetch top active tickers from Massive — sorted by volume/activity
    const data = await massiveGet('/v3/reference/tickers', apiKey, {
      market: 'stocks',
      active: true,
      limit: 100,
      sort: 'ticker',
      order: 'asc',
      type: 'CS', // common stock
    })
    return (data.results || []).map(t => t.ticker).filter(Boolean)
  }

  // Generic — try to search for tickers matching the index name
  const data = await massiveGet('/v3/reference/tickers', apiKey, {
    market: 'stocks',
    active: true,
    limit: 50,
    search: index,
    type: 'CS',
  })
  return (data.results || []).map(t => t.ticker).filter(Boolean)
}

async function getSnapshots(tickers, apiKey) {
  const results = []
  // Batch in groups of 20 to avoid rate limits
  for (let i = 0; i < tickers.length; i += 20) {
    const batch = tickers.slice(i, i + 20)
    const promises = batch.map(async (ticker) => {
      try {
        const data = await massiveGet(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`, apiKey)
        const r = data.results?.[0]
        if (!r) return null
        return {
          ticker,
          close: r.c,
          open: r.o,
          high: r.h,
          low: r.l,
          volume: r.v,
          vwap: r.vw,
          change: r.c && r.o ? ((r.c - r.o) / r.o * 100).toFixed(2) : null,
        }
      } catch {
        return null
      }
    })
    const batchResults = await Promise.all(promises)
    results.push(...batchResults.filter(Boolean))
  }
  return results
}

function buildPickPrompt(snapshots, count, userPrompt) {
  const symbolList = snapshots.map(s =>
    `${s.ticker}: close=${s.close} open=${s.open} high=${s.high} low=${s.low} vol=${s.volume} vwap=${s.vwap} chg=${s.change}%`
  ).join('\n')

  return `You are a trading desk scanner. From the following stocks, pick the top ${count} best setups right now.

## User request
${userPrompt}

## Available stocks with yesterday's data
${symbolList}

## Rules
- Pick exactly ${count} stocks with the best potential setups.
- Consider: momentum (change%), volume strength, gap plays, technical levels.
- Higher volume = more liquidity = better for trading.
- Large % movers in either direction are interesting.
- Stocks near VWAP might offer mean reversion plays.
- Stocks far from VWAP with high volume might be trending.

Return ONLY valid JSON:
{
  "picks": [
    {
      "ticker": "AAPL",
      "bias": "long" | "short" | "neutral",
      "confidence": <1-10>,
      "thesis": "<15-25 words, trading desk talk>",
      "category": "Stocks"
    }
  ],
  "rationale": "<2-3 sentences on why these were picked over the rest>"
}

JSON only, no markdown fences.`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const massiveApiKey = body.massiveApiKey // MASSIVE_API_KEY env fallback disabled — no longer in use
  const anthropicKey = process.env.ANTHROPIC_MAP_KEY_API

  if (!massiveApiKey) return res.status(400).json({ error: 'Massive API key required' })

  const action = body.action

  // ── Get constituents ──
  if (action === 'constituents') {
    const index = body.index || 'US30'
    try {
      const tickers = await getConstituents(index, massiveApiKey)
      return res.status(200).json({ index, count: tickers.length, tickers })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // ── AI Pick — fetch data + Claude picks ──
  if (action === 'pick') {
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_MAP_KEY_API missing' })

    const index = body.index || 'US30'
    const count = Math.min(Math.max(Number(body.count) || 5, 1), 15)
    const userPrompt = body.prompt || `Pick ${count} best stock setups from ${index}`

    try {
      // 1. Get constituents
      const tickers = await getConstituents(index, massiveApiKey)
      if (tickers.length === 0) {
        return res.status(200).json({ picks: [], rationale: 'No tickers found for this index.' })
      }

      // 2. Get price data
      const snapshots = await getSnapshots(tickers, massiveApiKey)
      if (snapshots.length === 0) {
        return res.status(200).json({ picks: [], rationale: 'Could not fetch price data.' })
      }

      // 3. Claude picks
      const client = new Anthropic({ apiKey: anthropicKey })
      const prompt = buildPickPrompt(snapshots, count, userPrompt)
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = (resp?.content || [])
        .filter(p => p?.type === 'text')
        .map(p => p.text)
        .join('')
        .trim()

      let parsed
      try {
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
        parsed = JSON.parse(clean)
      } catch {
        return res.status(200).json({
          picks: [],
          rationale: text.slice(0, 300),
          error: 'Failed to parse AI response',
        })
      }

      // Enrich picks with price data
      const picks = (parsed.picks || []).map(p => {
        const snap = snapshots.find(s => s.ticker === p.ticker)
        return {
          ...p,
          price: snap?.close ?? null,
          change: snap?.change ?? null,
          volume: snap?.volume ?? null,
        }
      })

      return res.status(200).json({
        picks,
        rationale: parsed.rationale || '',
        index,
        scanned: snapshots.length,
        usage: resp.usage || null,
      })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(400).json({ error: `unknown action: ${action}` })
}
