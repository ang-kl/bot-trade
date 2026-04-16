// Market Calendar API — generates a structured calendar of key events
// from today up to one month out. Sources: ForexFactory economic calendar,
// market holidays, macroeconomic releases, political key dates, earnings.
//
// Actions:
//   - generate: Asks Claude to produce a JSON calendar of events
//   - symbol-events: Returns events relevant to a specific symbol
//
// POST with JSON body. Returns structured JSON for the Feed calendar card.

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 4096

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

function calendarPrompt(symbols = []) {
  const today = new Date().toISOString().slice(0, 10)
  const endDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  const symbolList = symbols.length > 0 ? symbols.join(', ') : 'major forex pairs, indices, commodities, and crypto'

  return `You are a market calendar analyst. Generate a comprehensive calendar of key market events from ${today} to ${endDate}.

Include events from these categories:
1. **Economic Calendar** (ForexFactory-style): Central bank rate decisions, NFP, CPI, PPI, GDP, PMI, employment data, retail sales, trade balance, consumer confidence — for US, EU, UK, Japan, China, Australia, Canada, Switzerland
2. **Market Holidays**: NYSE, LSE, TSE, HKEX, ASX closures or early closes
3. **Earnings**: Major company reporting dates relevant to the watchlist
4. **Political**: G7/G20 summits, trade negotiations, elections, tariff deadlines, sanctions reviews
5. **Central Bank**: FOMC meetings, ECB/BOJ/BOE/RBA/RBNZ rate decisions, minutes releases
6. **Sector Events**: OPEC meetings, crop reports, tech conferences, pharma FDA dates

Watchlist symbols to consider for relevance: ${symbolList}

Return a JSON array (no code fences, no commentary) where each entry has:
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM" (UTC, or "all-day"),
  "event": "Short event name",
  "category": "economic|holiday|earnings|political|central-bank|sector",
  "impact": "high|medium|low",
  "currency": "USD|EUR|GBP|JPY|..." (if applicable, else null),
  "symbols": ["EURUSD", "US500"] (affected symbols from watchlist, max 5),
  "details": "One-sentence description"
}

Sort by date ascending, then by impact (high first). Include 30-60 events covering the full date range. Return ONLY the JSON array.`
}

function symbolEventsPrompt(symbol, events) {
  return `Given the following market calendar events and the symbol ${symbol}, select the ONE most relevant upcoming event and write a single concise line (max 80 chars) about it.

Events:
${JSON.stringify(events.slice(0, 20))}

Format: "[DATE] EVENT_NAME - brief impact note"
Example: "17/04 FOMC Minutes - hawkish tone may pressure gold"

Return ONLY the one-line string, no quotes, no commentary.`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' })
  }

  const body = readBody(req)
  const { action } = body

  try {
    const client = new Anthropic({ apiKey })

    if (action === 'generate') {
      const { symbols = [] } = body
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: calendarPrompt(symbols) }],
      })
      const text = (resp.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
      let events = []
      try {
        events = JSON.parse(text)
      } catch {
        // Try to extract JSON array from response
        const match = text.match(/\[[\s\S]*\]/)
        if (match) events = JSON.parse(match[0])
      }
      return res.status(200).json({
        events,
        generatedAt: new Date().toISOString(),
        usage: resp.usage || null,
      })
    }

    if (action === 'symbol-events') {
      const { symbol, events = [] } = body
      if (!symbol) return res.status(400).json({ error: 'symbol required' })
      if (events.length === 0) return res.status(200).json({ line: null })

      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 128,
        messages: [{ role: 'user', content: symbolEventsPrompt(symbol, events) }],
      })
      const line = (resp.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
      return res.status(200).json({ symbol, line, usage: resp.usage || null })
    }

    return res.status(400).json({ error: `unknown action: ${action || '(none)'}` })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'calendar failed' })
  }
}
