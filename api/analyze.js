// Deep analysis endpoint — dispatches parallel minion agents for a single symbol,
// then runs a Conviction Agent to synthesise their reports into an actionable decision.
// Called by the frontend when Scout finds a high-confidence candidate.

import Anthropic from '@anthropic-ai/sdk'
import { getSessionContext } from './_lib/sessions.js'
import { MINIONS, dispatch, buildMinionPrompt, buildSynthesisPrompt } from './_lib/minions.js'

const MODEL = 'claude-sonnet-4-5'
const MINION_MAX_TOKENS = 512
const SYNTH_MAX_TOKENS = 1024

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  return JSON.parse(clean)
}

async function runMinion(client, minionId, symbol, sessionContext) {
  const prompt = buildMinionPrompt(minionId, symbol, sessionContext)
  if (!prompt) return null
  const m = MINIONS[minionId]
  const startedAt = Date.now()

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MINION_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (resp?.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
    const parsed = parseJSON(text)
    return {
      minionId,
      name: m.name,
      role: m.role,
      icon: m.icon,
      bias: parsed.bias || 'neutral',
      conviction: parsed.conviction || 0,
      report: parsed.report || '',
      entry: parsed.entry || null,
      sl: parsed.sl || null,
      tp1: parsed.tp1 || null,
      tp2: parsed.tp2 || null,
      tokens: resp.usage?.output_tokens || 0,
      ms: Date.now() - startedAt,
    }
  } catch (e) {
    return {
      minionId, name: m.name, role: m.role, icon: m.icon,
      bias: 'skip', conviction: 0,
      report: `Error: ${e.message}`,
      entry: null, sl: null, tp1: null, tp2: null,
      tokens: 0, ms: Date.now() - startedAt,
    }
  }
}

async function runSynthesis(client, symbol, reports, threshold) {
  const prompt = buildSynthesisPrompt(symbol, reports, threshold)
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: SYNTH_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (resp?.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
    const parsed = parseJSON(text)
    return {
      ...parsed,
      tokens: resp.usage?.output_tokens || 0,
    }
  } catch (e) {
    return {
      symbol,
      consensus_bias: 'skip',
      overall_conviction: 0,
      synthesis: `Synthesis failed: ${e.message}`,
      auto_trade: false,
      tokens: 0,
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' })

  const body = readBody(req)
  const symbol = (body.symbol || '').toUpperCase().trim()
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const threshold = Number(body.autoTradeThreshold) || 8
  const sessionContext = getSessionContext()
  const client = new Anthropic({ apiKey })

  // 1. Dispatch minions for this symbol
  const minionIds = dispatch(symbol)
  const startedAt = Date.now()

  // 2. Run all minions in parallel
  const minionResults = await Promise.all(
    minionIds.map(id => runMinion(client, id, symbol, sessionContext))
  )
  const reports = minionResults.filter(Boolean)

  // 3. Synthesise
  const synthesis = await runSynthesis(client, symbol, reports, threshold)

  const totalTokens = reports.reduce((sum, r) => sum + (r.tokens || 0), 0) + (synthesis.tokens || 0)

  return res.status(200).json({
    symbol,
    dispatched: minionIds,
    reports,
    synthesis,
    session: sessionContext,
    at: new Date().toISOString(),
    ms: Date.now() - startedAt,
    usage: { output_tokens: totalTokens },
  })
}
