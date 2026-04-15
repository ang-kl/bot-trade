// X (Twitter) API v2 Basic client — Phase 6 wires this up.
// 5-min LRU cache, monthly counter, keyword sentiment scoring
// (no LLM per tweet — results injected into the news-analyst prompt).
//
// Env: X_API_BEARER_TOKEN
export default async function handler(req, res) {
  res.status(501).json({ error: 'news-x not implemented yet — see HANDOVER-V2.md Phase 6' })
}
