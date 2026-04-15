// Ask Dock streaming chat endpoint — Phase 5 wires this up.
// SSE stream backed by Claude, reusing the current position + story
// context so the user can ask "why did we buy AAPL?" and get a reply.
export default async function handler(req, res) {
  res.status(501).json({ error: 'chat not implemented yet — see HANDOVER-V2.md Phase 5' })
}
