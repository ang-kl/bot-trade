// Scout scanner — cheap, fast, single Claude call for ALL symbols.
// Finds candidates for deep analysis. The pit boss does a quick read.
// Hot candidates (confidence >= hotThreshold) get kicked to /api/analyze.

import Anthropic from '@anthropic-ai/sdk'
import { getSessionContext, categoriseSymbol } from './_lib/sessions.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 4096

function buildScanPrompt(symbols, sessionContext, userTz) {
  const symbolList = symbols.map(w => {
    const cat = categoriseSymbol(w.symbol)
    return `- ${w.symbol}${w.label ? ` (${w.label})` : ''} [${cat}]`
  }).join('\n')

  return `You are the Scout — the pit boss who does the first pass on every symbol. Quick-fire, no fluff, trading desk lingo. You scan fast and flag what's hot.

You are trading from Singapore (SGT, UTC+8). Markets: Asia (Tokyo, Sydney, Singapore), Europe (London, Frankfurt), US (NYSE), crypto 24/7.

## Current session
${sessionContext}
User timezone: ${userTz || 'Asia/Singapore'}
UTC: ${new Date().toISOString()}

## Symbols to scan
${symbolList}

Quick-fire each symbol. 15-30 words max per thesis. Use real desk talk:
- "catching a bid", "offered hard", "knife catch", "gap fill play"
- "liquidity grab", "vol expansion incoming", "riding the tape"
- "skip it", "not touching this", "juicy setup", "textbook entry"

Be honest. Not everything is a trade. Wrong session = skip.

Return ONLY valid JSON:
{
  "scans": [
    {
      "symbol": "EURUSD",
      "bias": "long" | "short" | "neutral" | "skip",
      "confidence": <1-10>,
      "thesis": "<15-30 words, trading lingo>",
      "timeframe": "<e.g. '1-4h scalp', 'session play'>",
      "session_fit": "<good|ok|poor> - <5-10 words>"
    }
  ],
  "desk_note": "<1-2 sentences, overall market vibe, 20-40 words>"
}

Rules:
- confidence < 4 = bias "skip" or "neutral"
- Asian hours: JPY pairs, AUD, JPN225, CN50. European: EUR, GBP, GER40. US stocks need NYSE.
- Crypto 24/7 but flag thin liquidity hours.
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

  const batch = symbols.slice(0, 15)
  const sessionContext = getSessionContext()
  const userTz = body.timezone || 'Asia/Singapore'
  const hotThreshold = Number(body.hotThreshold) || 6

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

    let parsed
    try {
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
      parsed = JSON.parse(clean)
    } catch {
      return res.status(200).json({
        scans: [], desk_note: text.slice(0, 200),
        raw: text, error: 'Failed to parse scan results as JSON',
      })
    }

    const scans = parsed.scans || []
    const hot = scans.filter(s => (s.confidence || 0) >= hotThreshold && s.bias !== 'skip')
    const warm = scans.filter(s => {
      const c = s.confidence || 0
      return c >= 4 && c < hotThreshold && s.bias !== 'skip'
    })

    return res.status(200).json({
      scans,
      hot: hot.map(s => s.symbol),
      warm: warm.map(s => s.symbol),
      desk_note: parsed.desk_note || '',
      session: sessionContext,
      at: new Date().toISOString(),
      usage: resp.usage || null,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'scan failed' })
  }
}
