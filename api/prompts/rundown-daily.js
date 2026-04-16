// Market Rundown — Prompt 2: generate today's briefing against the
// structure produced by prompt 1. Sources now include Telegram channels,
// X.com, RSS feeds, and ForexFactory alongside traditional wires.

export default function rundownDailyPrompt({ structure = null, sources = [], telegramMessages = '' } = {}) {
  const srcList = Array.isArray(sources) && sources.length > 0
    ? sources.join(', ')
    : 'reputable market research providers'
  const structureBlock = structure && typeof structure === 'string'
    ? structure
    : '(no cached structure — infer a trader-grade outline matching the requested sections)'

  const telegramBlock = telegramMessages
    ? `\n\nThe following are recent messages from curated Telegram market news channels. Treat these as primary source material alongside the wire services:\n\n${telegramMessages}\n`
    : ''

  return `Deep research today's market developments using all available intelligence. Use information from reputable providers (${srcList}) as the source material. Do not reference previous rundowns, unreliable sources, or previously generated summaries.${telegramBlock}

Use the following structure and generate today's market rundown as a markdown briefing:

${structureBlock}

Requirements:
- Summarize the information rather than quoting sources directly.
- Extract the most important macro developments.
- Identify key economic events for today and the coming days.
- Highlight notable earnings reports and corporate actions.
- Identify the most important instruments in play across all asset classes.
- Include ForexFactory calendar events if available.

For instruments in play:
- Focus on names with clear catalysts.
- Briefly explain why the instrument can move today.
- Prioritise instruments likely to see meaningful intraday volatility.

Also include broader market themes, secondary names with fresh news, and key events later in the week. The output should be a clean markdown briefing that a trader could quickly scan.

Return ONLY the markdown briefing — no preface, no commentary, no code fences.`
}
