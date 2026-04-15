// Market Rundown API — replaces the Phase 6 X-API endpoint.
//
// Two actions:
//   - structure: asks Claude to produce the reusable markdown outline.
//   - generate:  asks Claude to produce today's briefing against an
//                existing structure (or infers one if the client didn't
//                cache one yet).
//
// Both actions are POST with JSON bodies. Network errors surface as 5xx.

import Anthropic from '@anthropic-ai/sdk'
import rundownStructurePrompt from './prompts/rundown-structure.js'
import rundownDailyPrompt from './prompts/rundown-daily.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 4096

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

async function runClaude(client, prompt) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  const parts = Array.isArray(resp?.content) ? resp.content : []
  const text = parts.filter(p => p?.type === 'text').map(p => p.text).join('').trim()
  if (!text) throw new Error('empty response from Claude')
  return text
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
  const action = body.action

  try {
    const client = new Anthropic({ apiKey })
    if (action === 'structure') {
      const markdown = await runClaude(client, rundownStructurePrompt())
      return res.status(200).json({ action, markdown })
    }
    if (action === 'generate') {
      const { window, sources, structure } = body
      const markdown = await runClaude(
        client,
        rundownDailyPrompt({ window, sources, structure }),
      )
      return res.status(200).json({ action, markdown, generatedAt: new Date().toISOString() })
    }
    return res.status(400).json({ error: `unknown action: ${action || '(none)'}` })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'rundown failed' })
  }
}
