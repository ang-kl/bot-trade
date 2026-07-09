// ---------------------------------------------------------------------------
// agent/services/weekend-watch.js — weekend thesis review for open positions
// ---------------------------------------------------------------------------
// When FX/equity markets are closed but we hold non-crypto positions, weekend
// catalysts (Fed speak, OPEC, geopolitics, weekend data) can blow up our
// thesis overnight. This service runs an Opus pass with Anthropic's hosted
// web_search tool on each held position asking "given live weekend headlines,
// is this thesis still intact? Monday gap risk?"
// ---------------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const MAX_TOKENS = 2048
const WEB_SEARCH_MAX_USES = 3

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  return JSON.parse(clean)
}

function buildPrompt(pos) {
  const heldFor = pos.created_at
    ? `${Math.round((Date.now() - new Date(pos.created_at).getTime()) / 3_600_000)}h`
    : 'unknown'
  const weekday = new Date().toUTCString()
  return `You are a weekend thesis reviewer for an FX/commodity/index trading desk. Major markets (FX, equities, commodities) are closed for the weekend. An open position needs review for Monday-open gap risk.

CURRENT TIME (UTC): ${weekday}

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

TASK: Use the web_search tool (up to ${WEB_SEARCH_MAX_USES} queries) to pull LIVE weekend headlines for catalysts that could move ${pos.symbol} at Sydney open (Monday UTC 22:00). Prioritise queries that maximise signal per search — examples:
- "${pos.symbol} weekend news"
- Fed / ECB / BoJ / central bank commentary this weekend
- OPEC+ statements (if oil-linked)
- Geopolitical events (war, elections, sanctions)
- Major earnings or economic data scheduled for the week ahead

Then reason:
- Does the thesis still hold given the live news you found?
- What's the probability-weighted Monday gap risk (low/medium/high)?
- Should we act at open, or let the deterministic engine / SL do its job?

Be conservative — default to HOLD unless you have a CONCRETE, CITED reason to flag. Do not hallucinate events.

Return STRICT JSON only in your FINAL text block (no markdown, no prose before or after):
{
  "thesis_status": "intact" | "shaky" | "broken",
  "gap_risk": "low" | "medium" | "high",
  "action": "HOLD" | "REDUCE_AT_OPEN" | "EXIT_AT_OPEN" | "TIGHTEN_SL_AT_OPEN",
  "reasoning": "2-3 sentence explanation referencing specific headlines",
  "watch_events": ["specific event/headline 1", "specific event 2"],
  "suggested_sl": <number or null>,
  "confidence": <1-10>
}`
}

/**
 * Extract final-text + citations from a streamed Anthropic response that used
 * server-side web_search. We ignore server_tool_use and web_search_tool_result
 * blocks, join consecutive text blocks, and collect their citations for audit.
 */
function extractTextAndCitations(content) {
  const textParts = []
  const citations = []
  for (const block of content || []) {
    if (block?.type !== 'text') continue
    if (block.text) textParts.push(block.text)
    if (Array.isArray(block.citations)) {
      for (const c of block.citations) {
        citations.push({
          url: c.url || null,
          title: c.title || null,
          cited_text: c.cited_text || null,
        })
      }
    }
  }
  return { text: textParts.join('').trim(), citations }
}

/**
 * Run a weekend thesis review on one open position, with live web_search.
 *
 * @param {import('@anthropic-ai/sdk').default} client
 * @param {object} position - row from monitored_positions
 * @returns {Promise<object>}
 */
export async function runWeekendPositionCheck(client, position) {
  const startedAt = Date.now()
  const prompt = buildPrompt(position)

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: WEB_SEARCH_MAX_USES,
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    })
    const resp = await stream.finalMessage()
    const { text, citations } = extractTextAndCitations(resp?.content)
    const parsed = parseJSON(text)

    // Count how many searches actually ran — useful for cost auditing
    const searchesUsed = (resp?.content || []).filter(
      b => b?.type === 'server_tool_use' && b?.name === 'web_search'
    ).length

    return {
      thesis_status: parsed.thesis_status || 'intact',
      gap_risk: parsed.gap_risk || 'low',
      action: parsed.action || 'HOLD',
      reasoning: parsed.reasoning || '',
      watch_events: Array.isArray(parsed.watch_events) ? parsed.watch_events : [],
      suggested_sl: parsed.suggested_sl ?? null,
      confidence: parsed.confidence ?? 0,
      citations,
      searches_used: searchesUsed,
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
      citations: [],
      searches_used: 0,
      tokens: 0,
      ms: Date.now() - startedAt,
    }
  }
}
