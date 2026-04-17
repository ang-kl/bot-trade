// Scanner service — extracted from api/scan.js
// Standalone business logic, no HTTP handler.

import { getSessionContext, categoriseSymbol } from '../../api/_lib/sessions.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 4096

function buildScanPrompt(symbols, sessionContext, userTz) {
  const symbolList = symbols.map(w => {
    const cat = categoriseSymbol(w.symbol)
    const status = w.tradingNow ? 'OPEN' : 'CLOSED'
    const nextOpen = w.nextOpen || ''
    return `- ${w.symbol}${w.label ? ` (${w.label})` : ''} [${cat}] [${status}]${!w.tradingNow && nextOpen ? ` opens ${nextOpen}` : ''}`
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

Be honest. Not everything is a trade.

IMPORTANT: Even if a market is CLOSED, still analyse the setup. If the thesis is good, say so and include WHEN to trade it (e.g. "juicy setup, queue for London open 08:00 UTC"). Don't skip a symbol just because its market is closed — queue it for the next session.

Return ONLY valid JSON:
{
  "scans": [
    {
      "symbol": "EURUSD",
      "bias": "long" | "short" | "neutral" | "skip",
      "confidence": <1-10>,
      "thesis": "<15-30 words, trading lingo>",
      "timeframe": "<e.g. '1-4h scalp', 'session play'>",
      "session_fit": "<good|ok|poor> - <5-10 words>",
      "trade_at": "<when to trade if closed, e.g. '14:00 UTC NYSE open', or 'now' if open>",
      "price": <current approximate price as number or null if unknown>,
      "trade_grade": "potential" | "weak" | "none"
    }
  ],
  "desk_note": "<4-6 sentences covering: (1) overall risk appetite today, (2) which sessions are active and what to expect, (3) macro/geopolitical drivers in play, (4) hours until next Japan open and what to position for. 80-150 words, trading desk tone.>"
}

Rules:
- confidence < 4 = bias "skip" or "neutral"
- Asian hours: JPY pairs, AUD, JPN225, CN50. European: EUR, GBP, GER40. US stocks: NYSE hours.
- Crypto 24/7 but flag thin liquidity hours.
- Closed markets: still score the setup, suggest trade_at time. confidence can be high even if closed.
- JSON only, no markdown fences.`
}

/**
 * Run a scout scan across a batch of symbols.
 *
 * @param {import('@anthropic-ai/sdk').default} client - Anthropic client instance
 * @param {Array<{symbol: string, label?: string, tradingNow?: boolean, nextOpen?: string}>} symbols
 * @param {{ timezone?: string, hotThreshold?: number }} options
 * @returns {Promise<{ scans: Array, hot: string[], warm: string[], desk_note: string, usage: object|null }>}
 */
export async function runScan(client, symbols, options = {}) {
  const batch = symbols.slice(0, 15)
  const sessionContext = getSessionContext()
  const userTz = options.timezone || 'Asia/Singapore'
  const hotThreshold = Number(options.hotThreshold) || 6

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
    return {
      scans: [],
      hot: [],
      warm: [],
      desk_note: text.slice(0, 200),
      raw: text,
      error: 'Failed to parse scan results as JSON',
      usage: resp.usage || null,
    }
  }

  const scans = parsed.scans || []
  const hot = scans.filter(s => (s.confidence || 0) >= hotThreshold && s.bias !== 'skip')
  const warm = scans.filter(s => {
    const c = s.confidence || 0
    return c >= 4 && c < hotThreshold && s.bias !== 'skip'
  })

  return {
    scans,
    hot: hot.map(s => s.symbol),
    warm: warm.map(s => s.symbol),
    desk_note: parsed.desk_note || '',
    usage: resp.usage || null,
  }
}
