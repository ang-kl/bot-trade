// ---------------------------------------------------------------------------
// agent/services/annotate.js — deterministic plain-words chart reading.
//
// buildAnnotation is 100% deterministic maths — NO LLM. The ONLY optional
// LLM in the whole app is geminiCommentary below, gated on GEMINI_API_KEY
// (owner rule: Gemini only, never Anthropic) and NEVER auto-invoked — a
// caller must explicitly ask (commentary:true / '+ai').
// ---------------------------------------------------------------------------

import { STRATEGY_REGISTRY, enabledStrategies } from './strategies.js'

const last = (arr) => {
  if (!Array.isArray(arr)) return null
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]
  return null
}
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toFixed(2) : Number(n.toPrecision(6))) : '?')

/**
 * Plain-words deterministic read of the chart.
 * @param {object} db — for enabledStrategies (null → all registry strategies noted as untested)
 * @param {object} p — {symbol, timeframe, bars, overlays, getState?}
 * @returns {{lines: string[]}}
 */
// `symbol` is accepted per the caller contract but the deterministic read is symbol-agnostic.
export function buildAnnotation(db, { timeframe, bars, overlays = {}, getState = null }) {
  const lines = []
  const price = bars.length ? bars[bars.length - 1].c : null

  // SMA stack — words for the trend, no colour references.
  const s20 = last(overlays.sma20), s50 = last(overlays.sma50), s200 = last(overlays.sma200)
  if (s20 != null && s50 != null && s200 != null) {
    if (s20 > s50 && s50 > s200) lines.push(`SMA stack bullish: 20 above 50 above 200 (${fmt(s20)} / ${fmt(s50)} / ${fmt(s200)}).`)
    else if (s20 < s50 && s50 < s200) lines.push(`SMA stack bearish: 20 below 50 below 200 (${fmt(s20)} / ${fmt(s50)} / ${fmt(s200)}).`)
    else lines.push(`SMA stack mixed: 20=${fmt(s20)}, 50=${fmt(s50)}, 200=${fmt(s200)} — no clean trend order.`)
  }

  // Price vs vwap / avwap.
  for (const [key, label] of [['vwap', 'VWAP'], ['avwap', 'anchored VWAP']]) {
    const v = last(overlays[key])
    if (v != null && price != null) {
      const pct = ((price - v) / v) * 100
      lines.push(`Price ${price >= v ? 'above' : 'below'} ${label} ${fmt(v)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%).`)
    }
  }

  // Unfilled FVGs: count + nearest to price.
  if (Array.isArray(overlays.fvg)) {
    const open = overlays.fvg.filter(z => z.filledIdx == null)
    if (open.length === 0) lines.push('No unfilled fair-value gaps.')
    else {
      let nearest = open[0], best = Infinity
      for (const z of open) {
        const mid = (z.top + z.bottom) / 2
        const d = price != null ? Math.abs(price - mid) : 0
        if (d < best) { best = d; nearest = z }
      }
      lines.push(`${open.length} unfilled fair-value gap${open.length > 1 ? 's' : ''}; nearest is ${nearest.dir} at ${fmt(nearest.bottom)}–${fmt(nearest.top)}.`)
    }
  }

  // Volume profile: POC / VAH / VAL relative to price.
  const vp = overlays.vp
  if (vp && vp.pocPrice != null && price != null) {
    const where = price > vp.vahPrice ? 'above the value area' : price < vp.valPrice ? 'below the value area' : 'inside the value area'
    lines.push(`Volume POC ${fmt(vp.pocPrice)}, value area ${fmt(vp.valPrice)}–${fmt(vp.vahPrice)}; price is ${where}.`)
  }

  // Per-enabled-strategy one-liner: each compute runs on CLOSED bars (drop
  // the forming last bar, same convention as the scanner). Each call is
  // try/caught so one broken strategy can't sink the annotation.
  const closed = bars.slice(0, -1)
  let strats = []
  try { strats = db && getState ? enabledStrategies(db, getState) : STRATEGY_REGISTRY.filter(s => s.defaultOn) } catch { strats = [] }
  for (const s of strats) {
    try {
      const sig = s.compute(closed, timeframe, {})
      if (sig) lines.push(`${s.name}: ${sig.side || sig.bias || 'setup'} signal${sig.entry != null ? ` near ${fmt(sig.entry)}` : ''}.`)
      else lines.push(`${s.name}: no setup.`)
    } catch { lines.push(`${s.name}: no setup.`) }
  }

  return { lines }
}

/**
 * OPTIONAL Gemini commentary on the deterministic lines. Returns null when
 * GEMINI_API_KEY is unset or on ANY failure — callers must be null-safe.
 * One call, temperature 0.3, ~120-word cap. Never Anthropic (owner rule).
 */
export async function geminiCommentary(annotationLines, { symbol, timeframe } = {}) {
  if (!process.env.GEMINI_API_KEY) return null
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
    const prompt = `You are a trading assistant. In at most 120 words of plain prose, summarise this deterministic chart reading for ${symbol || 'the symbol'} on the ${timeframe || ''} timeframe. Do not invent levels not listed.\n\n${(annotationLines || []).join('\n')}`
    const resp = await fetch(url, {
      method: 'POST',
      // Key travels in a header, not the URL — query strings leak into logs.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 256 },
      }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } catch { return null }
}
