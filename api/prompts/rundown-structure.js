// Market Rundown — Prompt 1: define the daily structure.
// One LLM call, cached client-side in the strategy store and reused by
// prompt 2. Every LLM call = its own file per HANDOVER-V2.md.

export default function rundownStructurePrompt() {
  return `I want to build a Market Rundown workflow for traders. The workflow should:
- Read morning market research from OSINet and other reputable providers
- Extract the most important information
- Organize it into a structured daily trading briefing

The briefing should prioritize the information traders care about most, including:
- Macro context
- Economic calendar
- Earnings reports
- Top movers (with catalysts)
- Broader market themes
- Secondary names with fresh news
- Week ahead events

Start by defining the ideal structure for this rundown as a clean markdown outline that can be used every day. Return ONLY the markdown outline — no preface, no commentary, no code fences.`
}
