// News analyst sub-agent prompt.
// Ported verbatim from v1 api/advisor.js L231-311.
// Every LLM call = its own file per HANDOVER-V2.md.

export default function newsPrompt({ watchlist, newsFeed, globalSlice, sentimentBySymbol }) {
  const symbols = (watchlist || []).map(w => w.symbol).join(', ')
  // If a real news feed was fetched server-side, inline the headlines into
  // the prompt so Claude summarises actual articles per window rather than
  // hallucinating from training data. Cap each window at 6 lines so the
  // prompt stays under budget.
  let feedBlock = ''
  if (newsFeed && newsFeed.windows) {
    const nonEmpty = Object.entries(newsFeed.windows).filter(([, arr]) => Array.isArray(arr) && arr.length > 0)
    if (nonEmpty.length > 0) {
      const lines = []
      lines.push(`\nReal headlines from ${newsFeed.source} (fetched ${newsFeed.fetchedAt}):`)
      for (const [window, items] of nonEmpty) {
        lines.push(`  ${window}:`)
        for (const it of items.slice(0, 6)) {
          lines.push(`    - ${it.title} (${it.source}, ${it.publishedAt})`)
        }
      }
      feedBlock = lines.join('\n') + '\n'
    }
  }
  // GDELT political themes - one line per theme with average tone and
  // article count per window, plus the top headline. Compact enough to
  // sit inside the news prompt without ballooning token count.
  let politicalBlock = ''
  if (globalSlice?.political?.themes?.length) {
    const lines = ['\nPolitical event feed (GDELT, by theme and window):']
    for (const t of globalSlice.political.themes) {
      const d1 = t.windows?.['1d'] || {}
      const d7 = t.windows?.['7d'] || {}
      const d30 = t.windows?.['30d'] || {}
      const tone1d = d1.avgTone != null ? d1.avgTone.toFixed(2) : '-'
      lines.push(`  ${t.label}: 1d ${d1.count || 0} articles tone ${tone1d}, 7d ${d7.count || 0}, 30d ${d30.count || 0}`)
      const top = (d1.topHeadlines || [])[0]
      if (top?.title) lines.push(`    top 1d: ${top.title}`)
    }
    politicalBlock = lines.join('\n') + '\n'
  }
  // Per-stock AV sentiment aggregate - one line per ticker that has
  // a non-null avgScore. Lets the news analyst reason about directional
  // sentiment even when the raw headlines miss a catalyst.
  let sentimentBlock = ''
  if (sentimentBySymbol && Object.keys(sentimentBySymbol).length > 0) {
    const lines = ['\nTicker sentiment (AlphaVantage aggregated):']
    for (const [sym, s] of Object.entries(sentimentBySymbol)) {
      if (s?.avgScore == null) continue
      lines.push(`  ${sym}: ${s.label} (${s.avgScore.toFixed(2)}) from ${s.articleCount} articles`)
    }
    if (lines.length > 1) sentimentBlock = lines.join('\n') + '\n'
  }
  return `You are a news analyst sub-agent in a wealth advisor team. Produce a multi-window macro + sector readout for the symbols below, segmented by lookback horizon.${feedBlock}${politicalBlock}${sentimentBlock}

Focus universe: ${symbols || '(broad US large-caps + FX + commodities)'}
Current UTC: ${new Date().toISOString()}

Return ONLY valid JSON in this exact shape:
{
  "bias": "risk-on" | "risk-off" | "mixed",
  "windows": {
    "1d":   [<0-4 headline strings, each <=14 words>],
    "3d":   [...],
    "7d":   [...],
    "14d":  [...],
    "21d":  [...],
    "30d":  [...],
    "45d":  [...],
    "60d":  [...],
    "90d":  [...],
    "120d": [...],
    "200d": [...]
  },
  "summary": "<1 sentence, <=30 words, cross-window takeaway for swing traders>"
}

Rules:
- Each window must be an array (possibly empty) of concise macro / sector / single-name headlines dominant over that lookback.
- When real headlines are inlined above, prefer to summarise and prioritise them. Do not invent headlines that contradict the feed.
- Do not fabricate breaking news you cannot verify. Generic macro is acceptable.
- Where a symbol in the universe has a specific catalyst in a window, name it.
- No "as an AI", no markdown fences, no hyperlinks. JSON only.`
}
