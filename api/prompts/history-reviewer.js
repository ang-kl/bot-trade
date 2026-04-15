// History reviewer sub-agent prompt.
// Ported verbatim from v1 api/advisor.js L489-509.
// Every LLM call = its own file per HANDOVER-V2.md.

export default function historyPrompt({ recentTrades }) {
  const tradeLines = (recentTrades || []).slice(-20).map(t =>
    `${t.symbol} ${t.side} P&L ${t.pnl >= 0 ? '+' : ''}${t.pnl} @ ${t.closedAt || t.openedAt}${t.notes ? ' — ' + t.notes : ''}`
  ).join('\n') || '(no recent trades provided)'
  return `You are a trade-history analyst sub-agent in a wealth advisor team. Review the account's recent trades and extract 2-4 concrete lessons the lead advisor should apply to today's plan.

Recent trades:
${tradeLines}

Return ONLY valid JSON:
{
  "winRate": <number 0-1 or null>,
  "lessons": [<2-4 strings, each ≤18 words — actionable, not generic>],
  "summary": "<1 sentence ≤25 words>"
}

Rules:
- If no trades provided, set winRate null, lessons empty, and summary explain it.
- Lessons must be concrete ("cut losers at 1R, not 2R") not motivational.
- Respond with JSON only.`
}
