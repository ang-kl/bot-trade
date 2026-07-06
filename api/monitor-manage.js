// Server-side trade monitor management.
// Stores monitored positions so they survive browser refresh/close.
// For true persistence across server restarts, deploy server/ctrader-monitor.js
// as a long-running process (Railway, VPS, etc.).
//
// Actions:
//   register  — add a position to monitor
//   list      — get all monitored positions
//   cancel    — stop monitoring a position
//   check     — run Claude health check on a position (calls /api/monitor internally)
//   check-all — run Claude health checks on all active positions

import Anthropic from '@anthropic-ai/sdk'
import { getSessionContext } from './_lib/sessions.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 768

// In-memory store — survives within a single serverless instance.
// For Vercel, a cold start resets this. The browser re-registers on load.
// For a persistent server, this holds indefinitely.
const tracked = new Map()

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

function recordSummary(rec) {
  return {
    id: rec.id,
    symbol: rec.symbol,
    side: rec.side,
    entry: rec.entry,
    sl: rec.sl,
    tp: rec.tp,
    volume: rec.volume,
    thesis: rec.thesis,
    placedAt: rec.placedAt,
    status: rec.status,
    lastCheck: rec.lastCheck,
    lastCheckAt: rec.lastCheckAt,
    registeredAt: rec.registeredAt,
    elapsedMs: Date.now() - rec.placedAt,
  }
}

// Claude health-check prompt (same as api/monitor.js but inline for independence)
function buildCheckPrompt(rec, sessionContext) {
  const holdMs = Date.now() - rec.placedAt
  const holdMin = Math.round(holdMs / 60_000)
  const holdLabel = holdMin < 60 ? `${holdMin}m` : `${Math.floor(holdMin / 60)}h ${holdMin % 60}m`

  return `You are the Monitor Agent on a prop trading desk. You manage open positions.
Your job: decide if the original thesis still holds, and recommend action.

## Open position
Symbol: ${rec.symbol}
Side: ${rec.side}
Entry: ${rec.entry}
Stop loss: ${rec.sl || 'none'}
Take profit: ${rec.tp || 'none'}
Original thesis: ${rec.thesis || 'not recorded'}
Time in trade: ${holdLabel}

## Market context
${sessionContext}
UTC: ${new Date().toISOString()}

## Your options
1. HOLD — thesis intact, let it ride
2. TIGHTEN_SL — move stop loss to lock in profit (specify new SL price)
3. SCALE_OUT — take partial profit (specify %)
4. EXIT — thesis broken or risk event, close at market
5. ADD — thesis strengthened, scale in (specify price)

Be honest. If the trade is working, say HOLD. Don't over-manage.
If price is moving against the thesis, consider EXIT early rather than waiting for SL.

Return ONLY valid JSON:
{
  "action": "HOLD" | "TIGHTEN_SL" | "SCALE_OUT" | "EXIT" | "ADD",
  "new_sl": <price or null>,
  "scale_pct": <percent to close or null>,
  "add_price": <price or null>,
  "reasoning": "<20-40 words, what you see and why this action>",
  "thesis_status": "intact" | "weakening" | "broken",
  "urgency": "low" | "medium" | "high"
}`
}

async function runCheck(rec) {
  const apiKey = process.env.ANTHROPIC_MAP_KEY_API
  if (!apiKey) throw new Error('ANTHROPIC_MAP_KEY_API missing')

  const client = new Anthropic({ apiKey })
  const sessionContext = getSessionContext()
  const prompt = buildCheckPrompt(rec, sessionContext)

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = (resp?.content || []).filter(p => p?.type === 'text').map(p => p.text).join('').trim()
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  const parsed = JSON.parse(clean)

  return { ...parsed, at: new Date().toISOString(), usage: resp.usage || null }
}

// Send Telegram alert for monitor events
async function sendTelegramMonitorAlert(rec, check) {
  const botToken = rec.telegramBotToken
  const chatId = rec.telegramChatId
  if (!botToken || !chatId) return

  const urgencyEmoji = { low: '', medium: '\u26A0\uFE0F', high: '\uD83D\uDED1' }
  const emoji = urgencyEmoji[check.urgency] || ''
  const msg = [
    `${emoji} *MONITOR: ${rec.symbol}*`,
    `Action: *${check.action}*`,
    `Thesis: ${check.thesis_status}`,
    `${check.reasoning}`,
    check.new_sl ? `New SL: ${check.new_sl}` : '',
  ].filter(Boolean).join('\n')

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    })
  } catch { /* best-effort */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const action = body.action

  // ── Register ──
  if (action === 'register') {
    if (!body.symbol) return res.status(400).json({ error: 'symbol required' })
    const id = `${body.symbol}-${Date.now()}`
    const rec = {
      id,
      symbol: body.symbol,
      side: body.side || 'BUY',
      entry: body.entry || null,
      sl: body.sl || null,
      tp: body.tp || null,
      volume: body.volume || 0.01,
      thesis: body.thesis || '',
      placedAt: body.placedAt || Date.now(),
      status: 'monitoring',
      lastCheck: null,
      lastCheckAt: null,
      registeredAt: Date.now(),
      telegramBotToken: body.telegramBotToken || null,
      telegramChatId: body.telegramChatId || null,
    }
    tracked.set(id, rec)
    return res.status(200).json({ ok: true, id, position: recordSummary(rec) })
  }

  // ── List ──
  if (action === 'list') {
    const positions = [...tracked.values()]
      .filter(r => r.status === 'monitoring')
      .map(recordSummary)
    return res.status(200).json({ positions, total: positions.length })
  }

  // ── List all (including cancelled/stopped) ──
  if (action === 'list-all') {
    const positions = [...tracked.values()].map(recordSummary)
    return res.status(200).json({ positions, total: positions.length })
  }

  // ── Cancel ──
  if (action === 'cancel') {
    const rec = tracked.get(body.id)
    if (!rec) return res.status(404).json({ error: 'position not found' })
    rec.status = 'cancelled'
    return res.status(200).json({ ok: true, position: recordSummary(rec) })
  }

  // ── Check one position ──
  if (action === 'check') {
    const rec = tracked.get(body.id)
    if (!rec) return res.status(404).json({ error: 'position not found' })
    if (rec.status !== 'monitoring') {
      return res.status(200).json({ ok: false, reason: 'not monitoring', position: recordSummary(rec) })
    }
    try {
      const result = await runCheck(rec)
      rec.lastCheck = result
      rec.lastCheckAt = Date.now()
      // Alert on non-HOLD actions
      if (result.action !== 'HOLD') {
        await sendTelegramMonitorAlert(rec, result)
      }
      return res.status(200).json({ ok: true, check: result, position: recordSummary(rec) })
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'check failed' })
    }
  }

  // ── Check all active positions ──
  if (action === 'check-all') {
    const active = [...tracked.values()].filter(r => r.status === 'monitoring')
    if (active.length === 0) {
      return res.status(200).json({ checked: 0, results: [] })
    }
    const results = []
    let totalTokens = 0
    for (const rec of active) {
      try {
        const result = await runCheck(rec)
        rec.lastCheck = result
        rec.lastCheckAt = Date.now()
        if (result.usage?.output_tokens) totalTokens += result.usage.output_tokens
        if (result.action !== 'HOLD') {
          await sendTelegramMonitorAlert(rec, result)
        }
        results.push({ id: rec.id, symbol: rec.symbol, check: result })
      } catch (e) {
        results.push({ id: rec.id, symbol: rec.symbol, error: e?.message })
      }
    }
    return res.status(200).json({
      checked: results.length,
      results,
      totalTokens,
    })
  }

  return res.status(400).json({ error: `unknown action: ${action}` })
}
