// Telegram Bot API integration for trade alerts.
// Actions: send-alert, test-connection, get-updates (to find chat ID).

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const botToken = body.botToken || process.env.TELEGRAM_BOT_TOKEN
  const chatId = body.chatId || process.env.TELEGRAM_CHAT_ID

  if (!botToken) return res.status(400).json({ error: 'Telegram bot token required. Set TELEGRAM_BOT_TOKEN or pass botToken.' })

  // --- Test connection ---
  if (body.action === 'test-connection') {
    try {
      const me = await tgPost(botToken, 'getMe', {})
      return res.status(200).json({
        ok: true,
        botName: me.first_name,
        botUsername: me.username,
      })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }

  // --- Get updates (to find chat ID) ---
  if (body.action === 'get-updates') {
    try {
      const updates = await tgPost(botToken, 'getUpdates', { limit: 10 })
      const chats = []
      const seen = new Set()
      for (const u of updates) {
        const chat = u.message?.chat
        if (chat && !seen.has(chat.id)) {
          seen.add(chat.id)
          chats.push({
            chatId: chat.id,
            type: chat.type,
            title: chat.title || null,
            firstName: chat.first_name || null,
            username: chat.username || null,
          })
        }
      }
      return res.status(200).json({ ok: true, chats })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }

  // --- Send alert ---
  if (body.action === 'send-alert') {
    if (!chatId) return res.status(400).json({ error: 'chatId required' })

    let text = ''
    if (body.alertType === 'scan' && Array.isArray(body.scans)) {
      text = formatScanAlert(body.scans, body.deskNote, body.session)
    } else if (body.alertType === 'trade' && body.trade) {
      text = formatTradeAlert(body.trade)
    } else if (body.text) {
      text = body.text
    } else {
      return res.status(400).json({ error: 'alertType (scan/trade) with data, or text required' })
    }

    try {
      const msg = await tgPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      })
      return res.status(200).json({ ok: true, messageId: msg.message_id })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // --- Send test message ---
  if (body.action === 'send-test') {
    if (!chatId) return res.status(400).json({ error: 'chatId required' })
    try {
      const msg = await tgPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text: '\u26A1 *bot-trade* - Alert connection test successful!\n_Your alerts will appear here._',
        parse_mode: 'Markdown',
      })
      return res.status(200).json({ ok: true, messageId: msg.message_id })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: test-connection, get-updates, send-alert, send-test' })
}
