// Ask Dock chat endpoint — routes questions to Claude with the current
// feed + watchlist as grounding context. Non-streaming for now (the dock
// renders the full reply once); upgrade to SSE when we teach AskDock to
// render tokens as they arrive.

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 1024

const SYSTEM_PROMPT = [
  'You are the bot-trade co-pilot — a concise, candid trading assistant.',
  'Answer the user\'s question using the context provided (watchlist, latest',
  'market rundown, current stories). If the context does not cover the',
  'question, say so rather than inventing a position or price. Keep replies',
  'under ~150 words unless the user explicitly asks for more. No emojis.',
].join(' ')

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

// Flattens the context the client forwards from the strategy store into a
// short markdown block. Kept deterministic so prompt caching stays happy.
function formatContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return ''
  const lines = []
  if (Array.isArray(ctx.watchlist) && ctx.watchlist.length > 0) {
    const enabled = ctx.watchlist.filter((w) => w && w.enabled)
    if (enabled.length > 0) {
      lines.push('## Enabled watchlist')
      for (const w of enabled) {
        lines.push(`- ${w.symbol}${w.label ? ` — ${w.label}` : ''}${w.category ? ` (${w.category})` : ''}`)
      }
    }
  }
  if (Array.isArray(ctx.stories) && ctx.stories.length > 0) {
    lines.push('## Active stories')
    for (const s of ctx.stories) {
      if (!s || typeof s !== 'object') continue
      lines.push(`- ${s.symbol || '?'} · ${s.state || '?'}${s.side ? ` ${s.side}` : ''}`)
    }
  }
  if (typeof ctx.rundown === 'string' && ctx.rundown.trim()) {
    lines.push('## Latest market rundown')
    lines.push(ctx.rundown.trim())
  }
  return lines.join('\n')
}

function buildUserMessage(question, contextBlock) {
  if (!contextBlock) return question
  return `${contextBlock}\n\n---\n\nQuestion: ${question}`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' })
  }

  const body = readBody(req)
  const question = typeof body.q === 'string' ? body.q.trim() : ''
  if (!question) {
    return res.status(400).json({ error: 'question required' })
  }

  try {
    const client = new Anthropic({ apiKey })
    const contextBlock = formatContext(body.context)
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(question, contextBlock) }],
    })
    const parts = Array.isArray(resp?.content) ? resp.content : []
    const answer = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('').trim()
    if (!answer) throw new Error('empty response from Claude')
    return res.status(200).json({ answer, at: new Date().toISOString() })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'chat failed' })
  }
}
