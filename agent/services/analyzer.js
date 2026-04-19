// Analyzer service — extracted from api/analyze.js
// Standalone business logic, no HTTP handler.

import { getSessionContext } from '../lib/sessions.js'
import { MINIONS, dispatch, buildMinionPrompt, buildSynthesisPrompt } from '../lib/minions.js'

// Minions: Sonnet 4.6 — fast parallel calls, each returning a short report
const MINION_MODEL = 'claude-sonnet-4-6'
// Synthesis: Sonnet 4.6 with adaptive thinking — good reasoning at 5x lower cost than Opus
const SYNTH_MODEL = 'claude-sonnet-4-6'
const MINION_MAX_TOKENS = 512
const SYNTH_MAX_TOKENS = 2048

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
      model: MINION_MODEL,
      max_tokens: MINION_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (resp?.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
    const parsed = parseJSON(text)
    const validBiases = ['long', 'short', 'neutral', 'skip']
    const bias = validBiases.includes(parsed.bias) ? parsed.bias : 'skip'
    const conviction = Math.max(0, Math.min(10, Number(parsed.conviction) || 0))
    const entry = Number(parsed.entry) || null
    const sl = Number(parsed.sl) || null
    const tp1 = Number(parsed.tp1) || null
    if (entry && sl && ((bias === 'long' && sl >= entry) || (bias === 'short' && sl <= entry))) {
      return {
        minionId, name: m.name, role: m.role, icon: m.icon,
        bias: 'skip', conviction: 0,
        report: `Rejected: SL on wrong side of entry (${bias} entry=${entry} sl=${sl})`,
        entry: null, sl: null, tp1: null, tp2: null,
        tokens: resp.usage?.output_tokens || 0, ms: Date.now() - startedAt,
      }
    }
    const result = {
      minionId,
      name: m.name,
      role: m.role,
      icon: m.icon,
      bias,
      conviction,
      report: parsed.report || '',
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      entry,
      sl,
      tp1,
      tp2: Number(parsed.tp2) || null,
      invalidation: parsed.invalidation || null,
      tokens: resp.usage?.output_tokens || 0,
      ms: Date.now() - startedAt,
    }
    // Carry translation fields for non-English minions
    if (parsed.translated_report) {
      result.original_report = parsed.report
      result.translated_report = parsed.translated_report
      result.original_language = parsed.original_language || m.lang || null
    }
    return result
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
    // Use streaming + finalMessage to avoid timeout on long Opus reasoning
    const stream = await client.messages.stream({
      model: SYNTH_MODEL,
      max_tokens: SYNTH_MAX_TOKENS,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    const resp = await stream.finalMessage()
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

/**
 * Run deep analysis on a single symbol using parallel minion agents + synthesis.
 *
 * @param {import('@anthropic-ai/sdk').default} client - Anthropic client instance
 * @param {string} symbol - e.g. "EURUSD"
 * @param {{ autoTradeThreshold?: number }} options
 * @returns {Promise<{ symbol: string, dispatched: string[], reports: Array, synthesis: object, usage: { output_tokens: number } }>}
 */
export async function runAnalysis(client, symbol, options = {}) {
  symbol = (symbol || '').toUpperCase().trim()
  const threshold = Number(options.autoTradeThreshold) || 8
  const sessionContext = getSessionContext()

  // 1. Dispatch minions for this symbol
  const minionIds = dispatch(symbol)
  const startedAt = Date.now()

  // 2. Run all minions in parallel with per-minion timeout (30s)
  const MINION_TIMEOUT_MS = 30_000
  const minionResults = await Promise.all(
    minionIds.map(id =>
      Promise.race([
        runMinion(client, id, symbol, sessionContext),
        new Promise(resolve => setTimeout(() => resolve({
          minionId: id, name: MINIONS[id]?.name, role: MINIONS[id]?.role, icon: MINIONS[id]?.icon,
          bias: 'skip', conviction: 0, report: `Timeout after ${MINION_TIMEOUT_MS / 1000}s`,
          entry: null, sl: null, tp1: null, tp2: null, tokens: 0, ms: MINION_TIMEOUT_MS,
        }), MINION_TIMEOUT_MS))
      ])
    )
  )
  const reports = minionResults.filter(Boolean)

  // 3. Synthesise
  const synthesis = await runSynthesis(client, symbol, reports, threshold)

  const totalTokens = reports.reduce((sum, r) => sum + (r.tokens || 0), 0) + (synthesis.tokens || 0)

  return {
    symbol,
    dispatched: minionIds,
    reports,
    synthesis,
    ms: Date.now() - startedAt,
    usage: { output_tokens: totalTokens },
  }
}
