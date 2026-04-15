// Market Rundown — Prompt 2: generate today's briefing against the
// structure produced by prompt 1. The window (morning/noon/adhoc) maps
// to the research cutoff so we're not re-summarising stale emails.

const WINDOW_LABEL = {
  morning: 'between Tokyo open and London open',
  noon: 'between London open and New York open',
  adhoc: 'in the most recent hours before the upcoming US session',
}

export default function rundownDailyPrompt({ window = 'morning', structure = null, sources = [] } = {}) {
  const winLabel = WINDOW_LABEL[window] || WINDOW_LABEL.morning
  const srcList = Array.isArray(sources) && sources.length > 0
    ? sources.join(', ')
    : 'reputable market research providers'
  const structureBlock = structure && typeof structure === 'string'
    ? structure
    : '(no cached structure — infer a trader-grade outline matching the requested sections)'

  return `Deep research today's market research that arrived ${winLabel}. Only use information from reputable providers (${srcList}) as the source material. Do not reference previous rundowns, unreliable sources, or previously generated summaries.

Use the following structure and generate today's market rundown as a markdown briefing:

${structureBlock}

Requirements:
- Summarize the information rather than quoting emails directly.
- Extract the most important macro developments.
- Identify key economic events for the day.
- Highlight notable earnings reports.
- Identify the most important stocks in play.

For stocks in play:
- Focus on names with clear catalysts.
- Briefly explain why the stock can move today.
- Prioritize stocks likely to see meaningful intraday volatility.

Also include broader market themes, secondary names with fresh news, and key events later in the week. The output should be a clean markdown briefing that a trader could quickly scan before the open.

Return ONLY the markdown briefing — no preface, no commentary, no code fences.`
}
