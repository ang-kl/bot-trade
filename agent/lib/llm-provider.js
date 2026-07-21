// ---------------------------------------------------------------------------
// agent/lib/llm-provider.js — provider-agnostic LLM client.
//
// The LLM is used ONLY as a fallback for the position monitor and weekend
// watch (entries + risk gate are deterministic). Owner set OPENAI_API_KEY as
// the primary key, so this factory picks the provider by which key is present:
//
//   OPENAI_API_KEY set  → OpenAI  (default model gpt-5.6-luna, or OPENAI_MODEL)
//   else                → Anthropic (CLAUDE_API_KEY, default claude-sonnet-4-5
//                                    or ANTHROPIC_MODEL)
//
// Both expose the SAME `messages.create({ model, max_tokens, system, messages })`
// shape and return `{ content: [{ type:'text', text }], usage, model }`, so the
// callers (monitor-svc.js, weekend-watch.js) don't care which provider ran.
// The OpenAI path is a thin fetch wrapper — no new dependency.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'

// Owner-chosen default (2026-07-21). The OPENAI_MODEL env var still overrides
// this per-deploy. If the API rejects this id (400 invalid model), set
// OPENAI_MODEL to a known-good id on the Railway service without a redeploy.
const OPENAI_DEFAULT_MODEL = 'gpt-5.6-luna'
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5'

/** Which provider/model will be used, given the current env. Pure. */
export function llmProviderInfo(env = process.env) {
  if (env.OPENAI_API_KEY) {
    // Accept BOTH env names: OPENAI_MODEL (canonical) and OPENAI_DEFAULT_MODEL
    // (owner set this one on Railway). Either overrides the built-in default.
    return { provider: 'openai', model: env.OPENAI_MODEL || env.OPENAI_DEFAULT_MODEL || OPENAI_DEFAULT_MODEL }
  }
  return { provider: 'anthropic', model: env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL }
}

/**
 * Translate an Anthropic-style messages.create payload into an OpenAI
 * chat.completions body. `system` becomes a system message; string or
 * block-array message content is flattened to text. The claude model id the
 * caller passes is ignored — OpenAI uses its own configured model. Pure.
 */
export function toOpenAIBody({ max_tokens, system, messages }, model) {
  const oai = []
  if (system) oai.push({ role: 'system', content: system })
  for (const m of messages || []) {
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c?.text || '').join('') : '')
    oai.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content })
  }
  return { model, max_tokens, messages: oai }
}

/** Map an OpenAI chat.completions response to the Anthropic response shape. Pure. */
export function fromOpenAIResponse(data, fallbackModel) {
  const text = data?.choices?.[0]?.message?.content || ''
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? null,
      output_tokens: data?.usage?.completion_tokens ?? null,
    },
    model: data?.model || fallbackModel,
  }
}

function openaiClient(apiKey, model, fetchImpl = fetch) {
  return {
    provider: 'openai',
    model,
    messages: {
      async create(params) {
        const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toOpenAIBody(params, model)),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`OpenAI ${res.status}: ${String(body).slice(0, 200)}`)
        }
        return fromOpenAIResponse(await res.json(), model)
      },
    },
  }
}

/**
 * Build the LLM client for the active provider. OpenAI is primary when
 * OPENAI_API_KEY is present; otherwise the Anthropic SDK client.
 */
export function createLLMClient(env = process.env, deps = {}) {
  const info = llmProviderInfo(env)
  if (info.provider === 'openai') {
    return openaiClient(env.OPENAI_API_KEY, info.model, deps.fetch)
  }
  const client = new Anthropic({ apiKey: env.CLAUDE_API_KEY })
  client.provider = 'anthropic'
  client.model = info.model
  return client
}
