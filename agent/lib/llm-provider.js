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

// Built-in fallback if no env var is set (2026-07-21, owner-chosen). The
// canonical env var to override it is OPENAI_DEFAULT_MODEL (standardised name);
// legacy OPENAI_MODEL is still accepted. If the API rejects the id (400 invalid
// model), fix it on Railway by setting OPENAI_DEFAULT_MODEL — no redeploy.
const OPENAI_FALLBACK_MODEL = 'gpt-5.6-luna'
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5'

/** Which provider/model will be used, given the current env. Pure. */
export function llmProviderInfo(env = process.env) {
  if (env.OPENAI_API_KEY) {
    // OPENAI_DEFAULT_MODEL is the standardised env var (owner set this on
    // Railway); legacy OPENAI_MODEL kept as a fallback; then the built-in.
    return { provider: 'openai', model: env.OPENAI_DEFAULT_MODEL || env.OPENAI_MODEL || OPENAI_FALLBACK_MODEL }
  }
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
  return { model, max_completion_tokens: max_tokens, messages: oai }
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
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let res
        try {
          res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(toOpenAIBody(params, model)),
            signal: controller.signal,
          })
        } catch (err) {
          if (err.name === 'AbortError') throw new Error(`OpenAI request timed out after ${timeoutMs}ms`)
          throw err
        } finally {
          clearTimeout(timer)
        }
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
    return openaiClient(env.OPENAI_API_KEY, info.model, deps.fetch, deps.timeoutMs)
  }
  // Explicit bound (the SDK's own default is 10 minutes) — same reasoning as
  // the OpenAI path's AbortController above: this call sits inside D4's
  // Promise.all batch, so it must fail fast rather than hang the loop.
  const client = new Anthropic({ apiKey: env.CLAUDE_API_KEY, timeout: LLM_TIMEOUT_MS })
  client.provider = 'anthropic'
  client.model = info.model
  return client
}
