// ---------------------------------------------------------------------------
// src/lib/llm-ui.js — one reading of "is the AI layer on?", for every card.
//
// The agent's kill switch (agent/lib/llm-switch.js) makes disabled a
// FIRST-CLASS STATE: calls are never attempted, so there are no failures to
// display. The UI half of that contract is here. Without it the webapp kept
// offering Re-Risk runs, screener searches and an LLM-spend dashboard whose
// buttons could only produce refusals — an interface politely inviting the
// owner to press switches that go nowhere (owner, 24-08-2026: collapse the
// LLM cards behind the checkbox).
//
// TWO DIFFERENT KINDS OF OFF, and the checkbox must not blur them:
//   · state key `llm_disabled`  — the checkbox's own doing; it may re-enable.
//   · env `LLM_DISABLED`        — the durable brake. Nothing in the app can
//     release it (agent/routes/actions.js refuses by design), so rendering an
//     ENABLED, ticked-off checkbox against it would be a control that lies.
//     It renders locked instead, saying who holds it.
// ---------------------------------------------------------------------------

/**
 * Pure reading of /state/health's llmDisabled + llmDisabledBy — NOT the
 * public top-level /health, which is a different handler that has never
 * carried these fields; fetching that one is exactly how the gates shipped
 * unreachable the first time.
 *
 * `disabled` only on an explicit true — a missing field (old agent build,
 * failed fetch) must render the cards, not blank them: hiding working
 * features on absent evidence is the wrong direction to fail.
 */
export function llmUiState(health) {
  const disabled = health?.llmDisabled === true
  const by = health?.llmDisabledBy || null
  const envHeld = disabled && /env/i.test(String(by || ''))
  return { disabled, by, envHeld, canToggle: !envHeld }
}

/** The one-line body of a collapsed AI card. */
export function llmOffNote(state) {
  if (!state?.disabled) return null
  return state.envHeld
    ? 'AI features are switched off by the LLM_DISABLED env variable — no calls are attempted. Trading is deterministic and unaffected. Releasing it needs the variable removed and a redeploy.'
    : 'AI features are switched off — no calls are attempted. Trading is deterministic and unaffected. Re-enable with the AI features checkbox on the Desk.'
}
