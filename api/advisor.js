// Wealth Advisor orchestration endpoint — Phase 2+ wires this up.
//
// Responsibility: in parallel, call the 4 sub-agents (news / technical /
// history / macro), then feed their JSON outputs into lead-agent, and
// return the synthesised plan.
//
// Each prompt is a function imported from its own file in api/prompts/,
// honouring HANDOVER-V2.md "every LLM call = its own file".

import newsPrompt from './prompts/news-analyst.js'
import technicalPrompt from './prompts/technical-analyst.js'
import macroPrompt from './prompts/macro-analyst.js'
import historyPrompt from './prompts/history-reviewer.js'
import leadPrompt from './prompts/lead-agent.js'

export default async function handler(req, res) {
  // Phase 2+ implements: data collection, parallel sub-agent dispatch,
  // JSON extraction, lead synthesis, cTrader order suggestion wiring.
  // For now this is a scaffolding stub so the prompts have a consumer.
  void newsPrompt; void technicalPrompt; void macroPrompt
  void historyPrompt; void leadPrompt
  res.status(501).json({ error: 'advisor not implemented yet — see HANDOVER-V2.md Phase 2+' })
}
