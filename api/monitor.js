// Position monitor endpoint — checks if the original thesis still holds,
// recommends SL adjustments, scaling, or early exit.
// Called periodically per open position when the system is armed.

import Anthropic from '@anthropic-ai/sdk'
import { getSessionContext } from './_lib/sessions.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 768

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

function buildMonitorPrompt(position, sessionContext) {
  return `You are the Monitor Agent on a prop trading desk. You manage open positions.
Your job: decide if the original thesis still holds, and recommend action.

## Open position
Symbol: ${position.symbol}
Side: ${position.side}
Entry: ${position.entry}
Current price: ${position.currentPrice || 'unknown'}
Stop loss: ${position.sl}
Take profit: ${position.tp1}
P&L: ${position.pnl || 'unknown'}
Original thesis: ${position.thesis || 'not recorded'}
Time in trade: ${position.holdTime || 'unknown'}

## Market context
${sessionContext}
UTC: ${new Date().toISOString()}

## Your options
1. HOLD — thesis intact, let it ride
2. TIGHTEN_SL — move stop loss to lock in profit (specify new SL price)
3. SCALE_OUT — take partial profit (specify %)
4. EXIT — thesis broken or risk event, close at market
5. ADD — thesis strengthened, scale in (specify price)

Be honest. If the trade is working, say HOLD. Don't over-manage.
If price is moving against the thesis, consider EXIT early rather than waiting for SL.

Return ONLY valid JSON:
{
  "action": "HOLD" | "TIGHTEN_SL" | "SCALE_OUT" | "EXIT" | "ADD",
  "new_sl": <price or null>,
  "scale_pct": <percent to close or null>,
  "add_price": <price or null>,
  "reasoning": "<20-40 words, what you see and why this action>",
  "thesis_status": "intact" | "weakening" | "broken",
  "urgency": "low" | "medium" | "high"
}`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_MAP_KEY_API
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_MAP_KEY_API missing' })

  const body = readBody(req)
  if (!body.symbol) return res.status(400).json({ error: 'symbol required' })

  const sessionContext = getSessionContext()
  const client = new Anthropic({ apiKey })
  const prompt = buildMonitorPrompt(body, sessionContext)

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (resp?.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
    const parsed = JSON.parse(clean)

    return res.status(200).json({
      symbol: body.symbol,
      ...parsed,
      at: new Date().toISOString(),
      usage: resp.usage || null,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'monitor failed' })
  }
}
