// ---------------------------------------------------------------------------
// agent/services/screener-search.js — LLM-interpreted free-text screener
// search ("AI stock", "network layer stocks", "P.E. > 3"...).
//
// Owner: "the search is an LLM search that if I type 'AI stock' or Network
// layer stocks or P.E. >3, you can interpret" — and, when asked how to keep
// this honest: "Read LLM Call, server-side if cannot interpret as
// non-inventive symbol in the list or company name or in the table." That is
// the one hard rule this module enforces: the LLM proposes, but the returned
// symbol list is ALWAYS filtered down to what the broker actually offers
// (the caller's `universe`) — a plausible-sounding ticker the LLM invents
// that isn't in universe is dropped, not surfaced as if it were real.
//
// Multi-turn: `history` (prior {role, content} turns) lets the popup chatbot
// narrow down ("broaden to mid-caps too") without re-explaining the universe
// each time.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You help a trader search a fixed universe of broker-offered symbols.
You will be given the FULL list of symbols/instruments actually offered by their broker, and a
free-text query (a sector/theme like "AI stocks" or "network layer stocks", a metric filter like
"P/E > 30", a company name, or a follow-up narrowing an earlier answer).

Rules:
- Only return symbols that are ALREADY in the given universe list, verbatim. Never invent a ticker
  that isn't in the list, even if you believe it exists at the broker under a different name.
- If the query names a company, map it to its symbol IN THE UNIVERSE if present; if it isn't
  offered, say so in your reasoning and omit it.
- If you cannot confidently match anything in the universe to the query, return an empty symbols
  array and explain why in reasoning — do not guess just to return something.
- Numeric/fundamental filters (P/E, market cap, etc.) are not values you can compute from a symbol
  list alone — use your general knowledge of the named companies, and say in reasoning that this is
  a knowledge-based estimate, not live fundamentals data (the broker feed has no fundamentals).

Respond with ONLY a JSON object, no prose outside it:
{"symbols": ["EXACT.SYMBOL", ...], "reasoning": "one or two sentences"}`

function parseResponse(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (!match) return { symbols: [], reasoning: 'Could not parse a response.' }
  try {
    const parsed = JSON.parse(match[0])
    return {
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols.filter(s => typeof s === 'string') : [],
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  } catch {
    return { symbols: [], reasoning: 'Could not parse a response.' }
  }
}

/**
 * @param {object} llmClient - from createLLMClient()
 * @param {string} query - the user's free-text search / follow-up turn
 * @param {string[]} universe - every symbol the broker actually offers
 * @param {Array<{role:'user'|'assistant', content:string}>} history - prior turns, oldest first
 * @returns {Promise<{ symbols: string[], reasoning: string, dropped: string[] }>}
 */
export async function searchScreenerSymbols(llmClient, query, universe, { history = [] } = {}) {
  const universeSet = new Set((universe || []).map(s => String(s).toUpperCase()))
  const messages = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '') })),
    { role: 'user', content: `Universe (${universe?.length ?? 0} symbols): ${(universe || []).join(', ')}\n\nQuery: ${query}` },
  ]
  const resp = await llmClient.messages.create({
    model: llmClient.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  })
  const text = resp?.content?.find(c => c.type === 'text')?.text || resp?.content?.[0]?.text || ''
  const { symbols: raw, reasoning } = parseResponse(text)
  const symbols = []
  const dropped = []
  for (const s of raw) {
    const up = String(s).toUpperCase()
    if (universeSet.has(up)) symbols.push(up)
    else dropped.push(s) // the LLM proposed something not in the broker's universe — honest, not silently kept
  }
  return { symbols, reasoning, dropped }
}
