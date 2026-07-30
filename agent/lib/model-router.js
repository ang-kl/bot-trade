// ---------------------------------------------------------------------------
// agent/lib/model-router.js — pick the CHEAPEST OpenAI model that can do the
// job, and escalate only when the job actually needs it.
//
// Implements llm_ai_doc/AI_Model_Router_Instruction.md. Its principles, kept
// verbatim because they are the whole point:
//   1. Default to the cheapest model.
//   2. Escalate only when the task genuinely requires stronger reasoning.
//   3. Never use the most expensive model as the default.
//   4. Keep model names configurable through environment variables.
//   5. The routing logic belongs in application code, not in env vars.
//
// Three tiers, three env vars (owner, 2026-07-30):
//   OPENAI_MODEL_DEFAULT    — cheapest; the overwhelming majority of calls
//   OPENAI_MODEL_PREMIUM    — moderate reasoning / better writing
//   OPENAI_MODEL_REASONING  — rare, high-value, genuinely hard
//
// OPENAI_MODEL_DEFAULT replaces OPENAI_DEFAULT_MODEL. The old name (and the
// older OPENAI_MODEL) are still read as fallbacks, deliberately: this agent
// runs live on Railway, and a rename that silently fell back to a hardcoded
// built-in the moment the new var was missing would change which model trades
// are reviewed with, without saying so. Precedence is new → old → legacy →
// built-in, and `modelSource()` reports which one answered so the choice is
// never a guess.
//
// WHERE THE TIERS ARE NOT USED: the Anthropic path. Claude model ids come from
// ANTHROPIC_MODEL / the caller, because these three vars name OpenAI models and
// pointing an Anthropic request at "gpt-5-nano" would simply 404.
// ---------------------------------------------------------------------------

/** Cheapest tier's built-in, used only when no env var names one. */
const BUILTIN_DEFAULT = 'gpt-5-nano'

/**
 * Tier → the env vars that may name it, in precedence order.
 *
 * PREMIUM and REASONING fall back to the DEFAULT tier rather than to a
 * hardcoded expensive id. Principle 3: an unset var must never silently
 * escalate spend. A missing OPENAI_MODEL_REASONING means "we have no reasoning
 * tier configured, so use what we do have" — cheaper and honest, not pricier
 * and invisible.
 */
const TIER_VARS = {
  DEFAULT: ['OPENAI_MODEL_DEFAULT', 'OPENAI_DEFAULT_MODEL', 'OPENAI_MODEL'],
  PREMIUM: ['OPENAI_MODEL_PREMIUM'],
  REASONING: ['OPENAI_MODEL_REASONING'],
}

export const TIERS = ['DEFAULT', 'PREMIUM', 'REASONING']

/**
 * Resolve one tier to a model id, plus which env var supplied it.
 *
 * @param {'DEFAULT'|'PREMIUM'|'REASONING'} tier
 * @param {Record<string,string|undefined>} [env]
 * @returns {{tier: string, model: string, source: string}}
 *   `source` is the env var name, `'default-tier'` when an unconfigured
 *   PREMIUM/REASONING fell back, or `'builtin'` when nothing was set at all.
 */
export function resolveTier(tier, env = process.env) {
  const wanted = TIERS.includes(tier) ? tier : 'DEFAULT'
  for (const name of TIER_VARS[wanted]) {
    const v = env[name]
    if (typeof v === 'string' && v.trim()) return { tier: wanted, model: v.trim(), source: name }
  }
  if (wanted === 'DEFAULT') return { tier: 'DEFAULT', model: BUILTIN_DEFAULT, source: 'builtin' }
  // Unconfigured higher tier → fall DOWN to default, never up to a guess.
  const base = resolveTier('DEFAULT', env)
  return { tier: wanted, model: base.model, source: 'default-tier' }
}

/** Every tier at once, for a status route. No secrets — model ids only. */
export function tierTable(env = process.env) {
  return Object.fromEntries(TIERS.map(t => [t, resolveTier(t, env)]))
}

/**
 * Task type → tier. Straight from the doc's routing table, with this app's own
 * task names folded into it.
 *
 * The two judgement calls I made, stated rather than buried:
 *
 * · `position_monitor` → DEFAULT. It runs on EVERY open position EVERY monitor
 *   tick, which is the highest-volume LLM call in the system, and it is a
 *   fallback opinion: entries and the risk gate are deterministic, the stop and
 *   target already sit at the broker, and a no-price answer is downgraded to
 *   HOLD regardless of what the model says. The doc's "target ~98% of requests
 *   to the cheapest model" is unachievable if this call is not on it.
 *
 * · `risk_reassess` → REASONING. The doc puts `financial_analysis` on the
 *   reasoning tier, and this is exactly that: re-deriving the account's money
 *   limits from its balance and its record. It runs when the owner presses a
 *   button — rare and high-value, which is what the reasoning tier is for.
 */
export const TASK_TIERS = {
  // --- cheapest: classification, extraction, structured output -------------
  chat: 'DEFAULT',
  faq: 'DEFAULT',
  search: 'DEFAULT',
  telegram: 'DEFAULT',
  json: 'DEFAULT',
  classification: 'DEFAULT',
  extraction: 'DEFAULT',
  screener_search: 'DEFAULT',      // symbol-name matching against a known list
  position_monitor: 'DEFAULT',     // see note above
  weekend_watch: 'DEFAULT',        // same shape as position_monitor

  // --- moderate reasoning / better writing ---------------------------------
  summarise: 'PREMIUM',
  rewrite: 'PREMIUM',
  translation: 'PREMIUM',
  email: 'PREMIUM',
  trade_lesson: 'PREMIUM',         // post-mortem prose the owner actually reads

  // --- rare, high-value, genuinely hard ------------------------------------
  coding: 'REASONING',
  architecture: 'REASONING',
  deep_reasoning: 'REASONING',
  financial_analysis: 'REASONING',
  risk_reassess: 'REASONING',      // see note above
}

/**
 * Does this task need the reasoning tier regardless of its type?
 *
 * The doc's automatic-escalation hooks. All four are opt-IN flags a caller sets
 * deliberately; nothing here infers "this looks hard" on its own, because a
 * heuristic that quietly escalates spend is the failure principle 3 warns about.
 */
export function requiresReasoning(task = {}) {
  return !!(
    task.requiresMultipleSteps ||
    task.hasLargeCodebase ||
    task.hasManyDocuments ||
    task.userRequestedExpertMode
  )
}

/**
 * The router. Give it a task, get the model to call and why.
 *
 * @param {{type?: string} & Record<string, unknown>} task
 * @param {Record<string,string|undefined>} [env]
 * @returns {{model: string, tier: string, source: string, escalated: boolean, taskType: string}}
 */
export function chooseModel(task = {}, env = process.env) {
  const type = String(task.type || 'chat')
  const escalated = requiresReasoning(task)
  // An explicit escalation flag can only move a task UP, never down — a
  // REASONING-tier task with no flags stays on REASONING.
  const tier = escalated ? 'REASONING' : (TASK_TIERS[type] || 'DEFAULT')
  const r = resolveTier(tier, env)
  return { ...r, escalated, taskType: type }
}
