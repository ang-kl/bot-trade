// Monitor service — extracted from api/monitor.js
// Standalone business logic, no HTTP handler.

import { getSessionContext } from '../lib/sessions.js'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'
const MAX_TOKENS = 768

// A long whose SL sits ABOVE entry (short: below) is a PROFIT-LOCKED stop —
// breakeven/trailing already moved it. The LLM once read that as "malformed
// protection" and closed a guaranteed-profit USDJPY runner; spell it out.
function slNote(position) {
  const { side, entry, sl } = position
  if (!(Number.isFinite(Number(entry)) && Number.isFinite(Number(sl)))) return ''
  const long = /^(buy|long)$/i.test(String(side || ''))
  const locked = long ? Number(sl) > Number(entry) : Number(sl) < Number(entry)
  return locked
    ? '\nNOTE: The stop is on the PROFIT side of entry — breakeven/trailing already locked in gains. This is intentional and healthy, NOT malformed protection.'
    : ''
}

function buildMonitorPrompt(position, sessionContext) {
  return `You are the Monitor Agent on a prop trading desk. You manage open positions.
Your job: decide if the original thesis still holds, and recommend action.

## Open position
Symbol: ${position.symbol}
Side: ${position.side}
Entry: ${position.entry}
Current price: ${position.currentPrice || 'unknown'}
Stop loss: ${position.sl}${slNote(position)}
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

/**
 * Run a monitor check on an open position.
 *
 * @param {import('@anthropic-ai/sdk').default} client - Anthropic client instance
 * @param {{ symbol: string, side: string, entry: number, currentPrice?: number, sl: number, tp1: number, pnl?: string, thesis?: string, holdTime?: string }} position
 * @returns {Promise<{ action: string, new_sl: number|null, scale_pct: number|null, reasoning: string, thesis_status: string, urgency: string }>}
 */
export async function runMonitorCheck(client, position) {
  const sessionContext = getSessionContext()
  const prompt = buildMonitorPrompt(position, sessionContext)

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

  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  const parsed = JSON.parse(clean)

  // HARD GUARD — never act blind. Without a live price the model cannot know
  // where the position stands, yet it once closed a profit-locked USDJPY with
  // "current price unavailable" in its own reasoning. Deterministic rule: no
  // price → destructive actions (EXIT / SCALE_OUT) downgrade to HOLD; the
  // broker-side SL keeps protecting the position in the meantime.
  const noPrice = position.currentPrice == null || !Number.isFinite(Number(position.currentPrice))
  if (noPrice && (parsed.action === 'EXIT' || parsed.action === 'SCALE_OUT')) {
    parsed.reasoning = `guard: ${parsed.action} suppressed — no live price available; broker SL remains in force. LLM said: ${parsed.reasoning}`
    parsed.action = 'HOLD'
    parsed.scale_pct = null
  }

  return {
    symbol: position.symbol,
    action: parsed.action,
    new_sl: parsed.new_sl ?? null,
    scale_pct: parsed.scale_pct ?? null,
    add_price: parsed.add_price ?? null,
    reasoning: parsed.reasoning,
    thesis_status: parsed.thesis_status,
    urgency: parsed.urgency,
    usage: resp.usage || null,
    model: MODEL,
  }
}
