// Telegram service — extracted from api/telegram.js
// Standalone business logic, no HTTP handler.
// Uses env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID directly.

import { readFileSync } from 'node:fs'

const TG_API = 'https://api.telegram.org'

async function tgPost(botToken, method, payload) {
  const res = await fetch(`${TG_API}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`)
  return data.result
}

function formatScanAlert(scans, deskNote, session) {
  const lines = []
  lines.push('\u26A1 *bot-trade Scanner Alert*')
  lines.push('')
  if (session) lines.push(`\u23F0 ${session}`)
  lines.push('')

  const setups = scans.filter(s => s.bias !== 'skip' && s.bias !== 'neutral')
  const skipped = scans.filter(s => s.bias === 'skip' || s.bias === 'neutral')

  if (setups.length > 0) {
    lines.push(`*${setups.length} setup${setups.length > 1 ? 's' : ''} found:*`)
    lines.push('')
    for (const s of setups) {
      const arrow = s.bias === 'long' ? '\u25B2' : s.bias === 'short' ? '\u25BC' : '\u25CF'
      const conf = s.confidence ? ` (${s.confidence}/10)` : ''
      lines.push(`${arrow} *${s.symbol}* - ${s.bias.toUpperCase()}${conf}`)
      if (s.thesis) lines.push(`  _${s.thesis}_`)
      if (s.timeframe) lines.push(`  Timeframe: ${s.timeframe}`)
      if (s.key_levels && s.key_levels !== 'watching') lines.push(`  Levels: ${s.key_levels}`)
      lines.push('')
    }
  }

  if (skipped.length > 0) {
    lines.push(`_Skipped: ${skipped.map(s => s.symbol).join(', ')}_`)
    lines.push('')
  }

  if (deskNote) {
    lines.push(`*Desk note:* ${deskNote}`)
    lines.push('')
  }

  lines.push(`_${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore' })} SGT_`)
  return lines.join('\n')
}

function formatTradeAlert(trade) {
  const arrow = trade.side === 'long' || trade.side === 'BUY' ? '\u25B2' : '\u25BC'
  const lines = []
  lines.push(`${arrow} *${trade.action || 'TRADE'}* ${trade.symbol}`)
  if (trade.entry) lines.push(`Entry: ${trade.entry}`)
  if (trade.stopLoss) lines.push(`SL: ${trade.stopLoss}`)
  if (trade.takeProfit) lines.push(`TP: ${trade.takeProfit}`)
  if (trade.message) lines.push(`_${trade.message}_`)
  lines.push(`_${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore' })} SGT_`)
  return lines.join('\n')
}

function getToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN env var not set')
  return token
}

function getChatId() {
  // TELEGRAM_OWNER_CHAT_ID is the canonical name; TELEGRAM_CHAT_ID kept as a
  // fallback for older deployments.
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID
  if (!chatId) throw new Error('TELEGRAM_OWNER_CHAT_ID env var not set')
  return chatId
}

/**
 * Send a formatted scan alert to Telegram.
 *
 * @param {Array} scans - Array of scan result objects
 * @param {string} deskNote - Desk note text
 * @param {string} session - Session context string
 * @returns {Promise<{ ok: true, messageId: number }>}
 */
export async function sendScanAlert(scans, deskNote, session) {
  const botToken = getToken()
  const chatId = getChatId()
  const text = formatScanAlert(scans, deskNote, session)
  const msg = await tgPost(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  })
  return { ok: true, messageId: msg.message_id }
}

/**
 * Send a formatted trade alert to Telegram.
 *
 * @param {{ symbol: string, side: string, action?: string, entry?: number, stopLoss?: number, takeProfit?: number, message?: string }} trade
 * @returns {Promise<{ ok: true, messageId: number }>}
 */
export async function sendTradeAlert(trade) {
  const botToken = getToken()
  const chatId = getChatId()
  const text = formatTradeAlert(trade)
  const msg = await tgPost(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  })
  return { ok: true, messageId: msg.message_id }
}

/**
 * Send a raw text message to Telegram.
 *
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<{ ok: true, messageId: number }>}
 */
// Footer stamped onto every message — which build sent it, at a glance.
let _version = null
function versionFooter() {
  if (_version === null) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
      const [maj, min, patch] = String(pkg.version || '0.0.0').split('.')
      _version = `${maj}.${min}.${String(patch).padStart(3, '0')}`
    } catch { _version = '' }
  }
  return _version ? `\n\n_bot-trade v${_version}_` : ''
}

export async function sendMessage(text, opts = {}) {
  const botToken = getToken()
  const chatId = getChatId()
  const msg = await tgPost(botToken, 'sendMessage', {
    chat_id: chatId,
    text: text + versionFooter(),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    // Inline keyboard (owner 2026-07-24: one-tap Chart/Arm/TradingView on
    // signal alerts). Shape: [[{text, url|callback_data}, …], …].
    ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
  })
  return { ok: true, messageId: msg.message_id }
}

/**
 * Send a FILE to the owner (multipart sendDocument) — used by the daily
 * journal's HTML attachment. `content` is a string or Buffer; `mime`
 * defaults to HTML.
 */
export async function sendDocument(filename, content, caption = '', mime = 'text/html') {
  const botToken = getToken()
  const chatId = getChatId()
  const form = new FormData()
  form.append('chat_id', chatId)
  if (caption) form.append('caption', caption)
  form.append('document', new Blob([content], { type: mime }), filename)
  const res = await fetch(`${TG_API}/bot${botToken}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) throw new Error(`telegram sendDocument failed: ${data.description || res.status}`)
  return { ok: true, messageId: data.result?.message_id }
}
