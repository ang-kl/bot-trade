// ---------------------------------------------------------------------------
// agent/lib/llm-provider.js — provider-agnostic LLM client.
//
// The LLM is used ONLY as a fallback for the position monitor and weekend
// watch (entries + risk gate are deterministic). Owner set OPENAI_API_KEY as
// the primary key, so this factory picks the provider by which key is present:
//
//   OPENAI_API_KEY set  → OpenAI  (model from the tier router, see below)
//   else                → Anthropic (CLAUDE_API_KEY, default claude-sonnet-4-5
//                                    or ANTHROPIC_MODEL)
//
// Both expose the SAME `messages.create({ model, max_tokens, system, messages })`
// shape and return `{ content: [{ type:'text', text }], usage, model }`, so the
// callers (monitor-svc.js, weekend-watch.js) don't care which provider ran.
// The OpenAI path is a thin fetch wrapper — no new dependency.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import { chooseModel } from './model-router.js'

// The OpenAI model id now comes from the TIER ROUTER (lib/model-router.js),
// which implements llm_ai_doc/AI_Model_Router_Instruction.md:
//
//   OPENAI_MODEL_DEFAULT    cheapest — the great majority of calls
//   OPENAI_MODEL_PREMIUM    moderate reasoning / better writing
//   OPENAI_MODEL_REASONING  rare, high-value, genuinely hard
//
// OPENAI_MODEL_DEFAULT renamed FROM OPENAI_DEFAULT_MODEL (owner, 2026-07-30).
// The old name and the older OPENAI_MODEL are still read as fallbacks — see the
// header of model-router.js for why a silent fall-through to a built-in would
// be worse than a fallback chain on a live trading agent.
//
// A caller that knows its task passes it (`{ task: { type: 'risk_reassess' } }`)
// and gets that task's tier. A caller that does not gets the DEFAULT tier,
// which is principle 1: cheapest unless there is a reason.
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5'

/**
 * Which provider/model will be used, given the current env. Pure.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{type?: string}} [task] optional task; omitted ⇒ the DEFAULT tier
 */
export function llmProviderInfo(env = process.env, task = undefined) {
  if (env.OPENAI_API_KEY) {
    const r = chooseModel(task || {}, env)
    return { provider: 'openai', model: r.model, tier: r.tier, modelSource: r.source }
  }
  // Anthropic ids are NOT tiered here: the three vars name OpenAI models, and
  // pointing an Anthropic request at "gpt-5-nano" would just 404.
  return { provider: 'anthropic', model: env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL }
}

/**
 * Translate an Anthropic-style messages.create payload into an OpenAI
 * chat.completions body. `system` becomes a system message; string or
 * block-array message content is flattened to text. The claude model id the
 * caller passes is ignored — OpenAI uses its own configured model. Pure.
 *
 * Newer OpenAI models (gpt-5.x, incl. gpt-5.6-luna) REJECT `max_tokens` with a
 * 400 ("Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens'
 * instead"), which was silently killing every monitor check. We emit
 * `max_completion_tokens` — the parameter these models require.
 *
 * REASONING HEADROOM, and it is not a nicety. On a reasoning model
 * `max_completion_tokens` bounds REASONING TOKENS PLUS VISIBLE OUTPUT, not just
 * the output. An Anthropic caller asking for 768 output tokens is asking for 768
 * tokens of ANSWER; handed straight through, the model can spend all 768
 * thinking and return `content: ''` with `finish_reason: 'length'`. The caller
 * then sees an empty string, and monitor-svc's JSON.parse('') throws
 * "Unexpected end of JSON input" — which is what happened on staging on
 * 2026-07-30: the LLM position monitor died 21 checks in a row, starting right
 * when the model router moved position_monitor onto an OpenAI reasoning model.
 * The failure was invisible in the reason string: nothing said "budget".
 *
 * So the caller's number is treated as an OUTPUT budget and the reasoning gets
 * its own allowance on top. The multiplier is deliberately generous — output
 * tokens are cheap next to a position going unmonitored — and the floor keeps
 * a small ask (a 200-token classification) from starving.
 */
export const REASONING_HEADROOM = 6
export const MIN_COMPLETION_TOKENS = 4096

export function toOpenAIBody({ max_tokens, system, messages }, model) {
  const oai = []
  if (system) oai.push({ role: 'system', content: system })
  for (const m of messages || []) {
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c?.text || '').join('') : '')
    oai.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content })
  }
  const asked = Number(max_tokens)
  const budget = Number.isFinite(asked) && asked > 0
    ? Math.max(MIN_COMPLETION_TOKENS, Math.ceil(asked * REASONING_HEADROOM))
    : MIN_COMPLETION_TOKENS
  return { model, max_completion_tokens: budget, messages: oai }
}

/**
 * Map an OpenAI chat.completions response to the Anthropic response shape. Pure.
 *
 * `finishReason` and `reasoningTokens` ride along because an empty `text` is
 * ambiguous without them — "the model had nothing to say" and "the model was cut
 * off mid-thought" need different fixes, and the caller cannot tell them apart
 * from `''`. See monitor-svc.js, which now names both in its error.
 */
export function fromOpenAIResponse(data, fallbackModel) {
  const text = data?.choices?.[0]?.message?.content || ''
  return {
    content: [{ type: 'text', text }],
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? null,
      output_tokens: data?.usage?.completion_tokens ?? null,
      reasoning_tokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    },
    model: data?.model || fallbackModel,
  }
}

// A stalled fetch (no server response, dropped connection) never resolves OR
// rejects on its own — Node's fetch has no built-in timeout. Without this,
// one hung monitor check sits inside D4's Promise.all batch forever and
// freezes the whole main loop (production incident 2026-07-27: loopCount
// stuck for 80+ minutes, 28 positions unmonitored, no error ever logged
// because nothing ever threw). AbortController turns "never" into "throws
// after LLM_TIMEOUT_MS", which the existing per-position try/catch already
// handles correctly.
const LLM_TIMEOUT_MS = 30_000

function openaiClient(apiKey, model, fetchImpl = fetch, timeoutMs = LLM_TIMEOUT_MS) {
  return {
    provider: 'openai',
    model,
    messages: {
      async create(params) {
        // Codex review (PR #421): fetch() resolves once HEADERS arrive, not
        // once the body is fully read — a response that stalls mid-body
        // would previously hang on res.json()/res.text() with the timer
        // already cleared. The controller/timer must stay armed across the
        // body reads too, and an abort during those reads must surface as
        // the same timeout error, not a raw AbortError.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(toOpenAIBody(params, model)),
            signal: controller.signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`OpenAI ${res.status}: ${String(body).slice(0, 200)}`)
          }
          return fromOpenAIResponse(await res.json(), model)
        } catch (err) {
          if (err.name === 'AbortError') throw new Error(`OpenAI request timed out after ${timeoutMs}ms`)
          throw err
        } finally {
          clearTimeout(timer)
        }
      },
    },
  }
}

/**
 * Build a client for an EXPLICITLY chosen provider + model, ignoring which
 * key happens to be primary.
 *
 * createLLMClient below picks the provider from the environment, which is
 * right for the automatic paths (position monitor, weekend watch) — nobody is
 * there to choose. The Risk page's Re-Risk buttons are the opposite case: the
 * owner picks the provider and types the model name, so the choice must
 * override the env precedence rather than be second-guessed by it.
 *
 * Throws when the chosen provider has no API key configured, because the
 * honest answer to "assess with Claude" on a box that has no Claude key is an
 * error, not a silent substitution with the other provider's model.
 *
 * @param {'openai'|'anthropic'} provider
 * @param {string} model  the model id, as typed
 */
export function createLLMClientFor(provider, model, env = process.env, deps = {}) {
  const id = String(model || '').trim()
  if (!id) throw new Error('a model name is required')
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the agent — cannot use OpenAI')
    return openaiClient(env.OPENAI_API_KEY, id, deps.fetch, deps.timeoutMs)
  }
  if (provider === 'anthropic') {
    const key = env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY
    if (!key) throw new Error('CLAUDE_API_KEY is not set on the agent — cannot use Claude')
    const client = new Anthropic({ apiKey: key, timeout: deps.timeoutMs ?? LLM_TIMEOUT_MS })
    client.provider = 'anthropic'
    client.model = id
    return client
  }
  throw new Error(`unknown provider '${provider}' — expected 'openai' or 'anthropic'`)
}

/** Which providers this agent actually has a key for. Pure; no secrets leak. */
export function availableProviders(env = process.env) {
  return {
    openai: !!env.OPENAI_API_KEY,
    anthropic: !!(env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY),
  }
}

/**
 * Build the LLM client for the active provider. OpenAI is primary when
 * OPENAI_API_KEY is present; otherwise the Anthropic SDK client.
 */
export function createLLMClient(env = process.env, deps = {}) {
  // deps.task lets a call site declare what it is doing, so the router can
  // price it. Omitted ⇒ DEFAULT tier.
  const info = llmProviderInfo(env, deps.task)
  if (info.provider === 'openai') {
    const c = openaiClient(env.OPENAI_API_KEY, info.model, deps.fetch, deps.timeoutMs)
    c.tier = info.tier
    c.modelSource = info.modelSource
    return c
  }
  // Explicit bound (the SDK's own default is 10 minutes) — same reasoning as
  // the OpenAI path's AbortController above: this call sits inside D4's
  // Promise.all batch, so it must fail fast rather than hang the loop.
  const client = new Anthropic({ apiKey: env.CLAUDE_API_KEY, timeout: LLM_TIMEOUT_MS })
  client.provider = 'anthropic'
  client.model = info.model
  return client
}
