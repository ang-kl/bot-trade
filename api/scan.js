// Scanner endpoint - batch-analyses enabled watchlist symbols using Claude.
// Returns a thesis, direction bias, confidence, and session context for each.
// Uses trading slang/lingo persona across Asian, European, and US sessions.

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 4096

// Market sessions by UTC offset from midnight UTC
const SESSIONS = [
  { id: 'tokyo',   label: 'Tokyo',     open: 0,  close: 6,  tz: 'Asia/Tokyo' },
  { id: 'sydney',  label: 'Sydney',    open: 22, close: 5,  tz: 'Australia/Sydney' },
  { id: 'singapore', label: 'Singapore', open: 1, close: 9, tz: 'Asia/Singapore' },
  { id: 'london',  label: 'London',    open: 8,  close: 16, tz: 'Europe/London' },
  { id: 'frankfurt', label: 'Frankfurt', open: 7, close: 15, tz: 'Europe/Berlin' },
  { id: 'nyse',    label: 'New York',  open: 14, close: 21, tz: 'America/New_York' },
]

function getActiveSessions() {
  const utcHour = new Date().getUTCHours()
  return SESSIONS.filter(s => {
    if (s.open < s.close) return utcHour >= s.open && utcHour < s.close
    // Wraps midnight (e.g. Sydney 22-05)
    return utcHour >= s.open || utcHour < s.close
  })
}

function getSessionContext() {
  const active = getActiveSessions()
  if (active.length === 0) return 'Off-hours - thin liquidity, wide spreads. Careful with entries.'
  const names = active.map(s => s.label)
  const overlaps = []
  if (names.includes('Tokyo') && names.includes('London')) overlaps.push('Tokyo-London overlap')
  if (names.includes('London') && names.includes('New York')) overlaps.push('London-NY overlap - peak liquidity')
  if (names.includes('Sydney') && names.includes('Tokyo')) overlaps.push('Asia session - Sydney/Tokyo overlap')

  let note = `Active sessions: ${names.join(', ')}.`
  if (overlaps.length > 0) note += ` ${overlaps.join('. ')}.`
  return note
}

function categoriseSymbol(symbol) {
  const s = symbol.toUpperCase()
  const fx = ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'AUDJPY', 'EURJPY', 'GBPJPY']
  const crypto = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD']
  const indices = ['US500', 'US30', 'NAS100', 'GER40', 'JPN225', 'VIX', 'CN50', 'SDY']
  const metals = ['XAUUSD', 'XAGUSD', 'XPTUSD', 'USDX']
  const commodities = ['NATGAS', 'COCOA', 'COFFEE', 'COPPER', 'ALUMINIUM', 'SOYBEANS', 'SPOTCRUDE']

  if (fx.includes(s)) return 'fx'
  if (crypto.includes(s)) return 'crypto'
  if (indices.includes(s)) return 'index'
  if (metals.includes(s)) return 'metal'
  if (commodities.includes(s)) return 'commodity'
  return 'stock'
}

function buildScanPrompt(symbols, sessionContext, userTz) {
  const symbolList = symbols.map(w => {
    const cat = categoriseSymbol(w.symbol)
    return `- ${w.symbol}${w.label ? ` (${w.label})` : ''} [${cat}]`
  }).join('\n')

  return `You are the pit boss - a seasoned algo trader who talks like a real desk trader. You use trading slang, market lingo, and have strong opinions. You are scanning symbols for the next 1-8 hours looking for setups.

You are trading from Singapore (SGT, UTC+8). Your markets span Asia (Tokyo, Sydney, Singapore), Europe (London, Frankfurt), and crypto runs 24/7.

## Current session
${sessionContext}
User timezone: ${userTz || 'Asia/Singapore'}
UTC: ${new Date().toISOString()}

## Symbols to scan
${symbolList}

For each symbol, produce a quick-fire thesis. Use trading slang naturally:
- "catching a bid", "offered hard", "grinding higher", "knife catch setup"
- "gap fill play", "liquidity grab below", "vol expansion incoming"
- "riding the tape", "fading the move", "mean reversion setup"
- "bid side stacking", "offers getting lifted", "order flow divergence"
- "session open flush", "London open squeeze potential"
- Be direct: "skip it", "not touching this", "juicy setup", "textbook entry"

Assess each symbol honestly. Not everything is a trade. If the session is wrong for a symbol (e.g. US stock during Asia hours), say so.

Return ONLY valid JSON:
{
  "scans": [
    {
      "symbol": "EURUSD",
      "bias": "long" | "short" | "neutral" | "skip",
      "confidence": <1-10>,
      "thesis": "<15-40 words, use trading lingo, be specific about the setup>",
      "timeframe": "<e.g. '1-4h scalp', 'overnight swing', 'session play'>",
      "session_fit": "<good|ok|poor> - <why, 5-10 words>",
      "key_levels": "<entry zone, SL zone, TP zone if applicable, or 'watching' if no setup>"
    }
  ],
  "desk_note": "<1-2 sentences, overall market read in trading slang, 20-40 words>"
}

Rules:
- Be honest. If confidence < 4, set bias to "skip" or "neutral".
- Session matters: Asian hours favour JPY pairs, AUD, and indices like JPN225/CN50. European hours favour EUR, GBP, GER40. US stocks need NYSE hours.
- Crypto scans 24/7 but watch for thin Asian hour liquidity.
- Commodities: energy and metals move on London/NY overlap. Soft commodities (coffee, cocoa) need NY session.
- Give concrete levels where possible, not just "bullish".
- JSON only, no markdown fences.`
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' })

  const body = readBody(req)
  const symbols = Array.isArray(body.symbols) ? body.symbols : []
  if (symbols.length === 0) return res.status(400).json({ error: 'symbols array required' })

  // Cap at 15 symbols per scan to keep token budget reasonable
  const batch = symbols.slice(0, 15)
  const sessionContext = getSessionContext()
  const userTz = body.timezone || 'Asia/Singapore'

  try {
    const client = new Anthropic({ apiKey })
    const prompt = buildScanPrompt(batch, sessionContext, userTz)
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = (resp?.content || [])
      .filter(p => p?.type === 'text')
      .map(p => p.text)
      .join('')
      .trim()

    // Try to parse JSON from the response
    let parsed
    try {
      // Strip markdown fences if model wraps them despite instructions
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
      parsed = JSON.parse(clean)
    } catch {
      return res.status(200).json({
        scans: [],
        desk_note: text.slice(0, 200),
        raw: text,
        error: 'Failed to parse scan results as JSON',
      })
    }

    return res.status(200).json({
      scans: parsed.scans || [],
      desk_note: parsed.desk_note || '',
      session: sessionContext,
      at: new Date().toISOString(),
      usage: resp.usage || null,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'scan failed' })
  }
}
