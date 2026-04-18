// ---------------------------------------------------------------------------
// agent/services/weekend-watch.js — weekend thesis review for open positions
// ---------------------------------------------------------------------------
// When FX/equity markets are closed but we hold non-crypto positions, weekend
// catalysts (Fed speak, OPEC, geopolitics, weekend data) can blow up our
// thesis overnight. This service runs a lightweight Opus pass on each held
// position asking "what could move this at Monday open, and is the thesis
// still intact?" It does NOT have live news access today — it reasons from
// known calendar items and general market conditions. Adding web_search is
// a follow-up.
// ---------------------------------------------------------------------------

const MODEL = 'claude-opus-4-7'
const MAX_TOKENS = 1024

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  return JSON.parse(clean)
}

function buildPrompt(pos) {
  const heldFor = pos.created_at
    ? `${Math.round((Date.now() - new Date(pos.created_at).getTime()) / 3_600_000)}h`
    : 'unknown'
  return `You are a weekend thesis reviewer for an FX/commodity/index trading desk. Major markets (FX, equities, commodities) are closed for the weekend. An open position needs review for Monday-open gap risk.

POSITION:
- Symbol: ${pos.symbol}
- Side: ${pos.side}
- Entry: ${pos.entry_price}
- Current SL: ${pos.current_sl}
- Current TP: ${pos.current_tp}
- Initial risk: ${pos.initial_risk}
- MFE so far: ${pos.mfe_r ?? 0}R
- MAE so far: ${pos.mae_r ?? 0}R
- Original thesis: ${pos.thesis || '(empty)'}
- Invalidation trigger: ${pos.invalidation_trigger || '—'}
- Held for: ${heldFor}
- Time cap: ${pos.time_cap_at || '—'}
- Strategy: ${pos.strategy || '—'}

TASK: Think about typical weekend catalysts that could move this symbol at Sydney open (Monday UTC 22:00 / Asia session). Consider:
- Central bank speak / Fed minutes leaks
- G20 / geopolitical developments
- OPEC+ commentary (for oil-linked)
- Weekend economic data releases (China, rare)
- Known event calendar (earnings, elections, CPI/NFP week)
- Crypto weekend moves as risk-on/off proxy
- Risk-off safe haven flows (USD, JPY, CHF, gold)

You do NOT have live news. Reason from general market structure and what's on the known calendar for the upcoming week.

Return STRICT JSON only (no markdown, no prose):
{
  "thesis_status": "intact" | "shaky" | "broken",
  "gap_risk": "low" | "medium" | "high",
  "action": "HOLD" | "REDUCE_AT_OPEN" | "EXIT_AT_OPEN" | "TIGHTEN_SL_AT_OPEN",
  "reasoning": "2-3 sentence explanation",
  "watch_events": ["specific event 1", "specific event 2"],
  "suggested_sl": <number or null>,
  "confidence": <1-10>
}

Be conservative — default to HOLD unless you have a concrete reason to flag.`
}

/**
 * Run a weekend thesis review on one open position.
 *
 * @param {import('@anthropic-ai/sdk').default} client
 * @param {object} position - row from monitored_positions
 * @returns {Promise<{thesis_status: string, gap_risk: string, action: string, reasoning: string, watch_events: string[], suggested_sl: number|null, confidence: number, tokens: number, ms: number}>}
 */
export async function runWeekendPositionCheck(client, position) {
  const startedAt = Date.now()
  const prompt = buildPrompt(position)

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    const resp = await stream.finalMessage()
    const text = (resp?.content || [])
      .filter(p => p?.type === 'text')
      .map(p => p.text)
      .join('')
      .trim()
    const parsed = parseJSON(text)
    return {
      thesis_status: parsed.thesis_status || 'intact',
      gap_risk: parsed.gap_risk || 'low',
      action: parsed.action || 'HOLD',
      reasoning: parsed.reasoning || '',
      watch_events: Array.isArray(parsed.watch_events) ? parsed.watch_events : [],
      suggested_sl: parsed.suggested_sl ?? null,
      confidence: parsed.confidence ?? 0,
      tokens: resp.usage?.output_tokens || 0,
      ms: Date.now() - startedAt,
    }
  } catch (e) {
    return {
      thesis_status: 'intact',
      gap_risk: 'low',
      action: 'HOLD',
      reasoning: `Weekend check failed: ${e.message}`,
      watch_events: [],
      suggested_sl: null,
      confidence: 0,
      tokens: 0,
      ms: Date.now() - startedAt,
    }
  }
}
