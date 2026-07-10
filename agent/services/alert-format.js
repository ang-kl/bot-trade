// Analysis-alert formatter — owner feedback: "why 8 decimal places, give me
// more insights and how you want me to decide, and what time market close."
// Pure formatting + deterministic context. No LLM, no network.

import { isSymbolMarketOpen, categoriseSymbol } from '../lib/sessions.js'

// Kill float noise: 0.5757097999999999 → 0.57571. Precision by price scale
// (FX 5dp, JPY-style 3dp, indices/stocks 1-2dp) — display only; order
// placement rounds separately against the broker's own digits.
// Owner's display rule: never more than 4 decimals, coarser as price grows.
export function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  const dp = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 10 ? 3 : 4
  let out = n.toFixed(dp)
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return out
}

// Owner's trading rule: don't fight the broker over decimals — 2-3dp for
// normal prices, whole-number indices round to TENS (JPN225 68,826.77 →
// 68,830). brokerDigits still caps the precision ceiling.
export function tradePrice(v, brokerDigits = 5) {
  const n = Number(v)
  if (!Number.isFinite(n)) return n
  const a = Math.abs(n)
  if (a >= 5000) return Math.round(n / 10) * 10
  if (a >= 1000) return Math.round(n)
  const dp = Math.min(brokerDigits, a >= 100 ? 2 : a >= 10 ? 3 : 4)
  return Number(n.toFixed(dp))
}

function marketLine(symbol) {
  const state = isSymbolMarketOpen(symbol)
  if (!state.open) return `🕐 market CLOSED — ${state.reason}`
  const cat = categoriseSymbol(symbol)
  if (cat === 'crypto') return '🕐 market open 24/7'
  if (cat === 'stock' || cat === 'index') return '🕐 exchange session open (closes 20:55 UTC weekdays)'
  return '🕐 FX/CFD market open (weekend close Fri 21:00 UTC)'
}

/**
 * Rich, decision-oriented alert. Structure:
 *   headline → the setup in words → the numbers (clean) → what the BOT will
 *   do → what the HUMAN can do → market hours.
 */
export function formatAnalysisAlert(db, { sym, synth, signal, armed = {}, newsLines = [] }) {
  const bias = synth.consensus_bias?.toUpperCase() || '?'
  const emoji = synth.consensus_bias === 'long' ? '📈' : synth.consensus_bias === 'short' ? '📉' : '📊'
  const conv = synth.overall_conviction ?? 0
  const entry = Number(synth.entry)
  const sl = Number(synth.sl)
  const tp = Number(synth.tp1)
  const rr = Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp) && Math.abs(entry - sl) > 0
    ? Math.round((Math.abs(tp - entry) / Math.abs(entry - sl)) * 100) / 100
    : null
  const riskPct = Number.isFinite(entry) && Number.isFinite(sl) && entry !== 0
    ? Math.round(Math.abs(entry - sl) / entry * 10000) / 100
    : null

  const tf = signal?.timeframe || synth.timeframe || null
  const tfArmed = armed.matrix
    ? (armed.matrix[sym] || []).includes(tf)
    : (armed.tfs || []).includes(tf)
  const willAct = armed.autotrade && tfArmed && conv >= 8

  const lines = [
    `${emoji} ${sym} ${bias} — conviction ${conv}/10${tf ? ` on ${tf}` : ''}`,
    synth.synthesis || '',
    ``,
    `Entry ${fmtPrice(entry)} · SL ${fmtPrice(sl)} · TP ${fmtPrice(tp)}${rr != null ? ` · R:R ${rr}` : ''}${riskPct != null ? ` · risk ${riskPct}% of price` : ''}`,
    ``,
    willAct
      ? `🤖 BOT WILL ACT: ${tf} is armed and conviction clears the 8/10 bar — the risk gate is the last word.`
      : `🤖 Bot will NOT act: ${!armed.autotrade ? 'autotrade is off' : !tfArmed ? `${tf || 'this timeframe'} is not armed for ${sym}` : `conviction ${conv}/10 is below the 8/10 bar`}.`,
    `🧭 Your options: do nothing (default) · /arm fib_618_fade ${sym} ${tf || '<tf>'} to arm this combo · /pause to stop the bot · /chart ${sym} ${tf || '1h'} to see it drawn.`,
    `📏 How to read conviction: 6-7 = zone touched but shallow, most fail; 8+ = deep in the zone, the only grade the bot trades.`,
    marketLine(sym),
    ...(newsLines.length ? ['', '📰 Nearby scheduled news (ForexFactory):', ...newsLines] : []),
  ]
  return lines.filter(l => l !== undefined).join('\n')
}
