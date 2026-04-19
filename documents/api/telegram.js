// Telegram bot alerts — fire-and-forget push notifications that broadcast
// to every device the user is logged into Telegram on.
//
// Setup (user side):
//   1. Talk to @BotFather in Telegram → /newbot → save the token
//   2. Talk to @userinfobot → save your chat ID
//   3. Start a chat with YOUR new bot (required — bots can't DM you first)
//   4. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Vercel env vars
//
// API:
//   POST /api/telegram { message: string, parseMode?: 'Markdown'|'HTML' }
//   Returns { ok: true } on success, { error: '...' } otherwise.
//
// Also supports GET /api/telegram?action=health — returns whether env vars
// are configured. Used by the Settings panel to show green/red dot.

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  // Health check — safe to call from anywhere, doesn't leak secrets
  if (req.method === 'GET' && req.query.action === 'health') {
    return res.status(200).json({
      configured: !!(token && chatId),
      hasToken: !!token,
      hasChatId: !!chatId,
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!token || !chatId) {
    return res.status(503).json({
      error: 'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Vercel env vars.',
    })
  }

  const { message, parseMode = 'Markdown', silent = false } = req.body || {}
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) is required' })
  }

  // Telegram has a 4096-char hard limit on message text. Truncate with
  // a marker so we never silently drop content.
  const MAX_LEN = 4000
  const text = message.length > MAX_LEN
    ? message.slice(0, MAX_LEN) + '\n…(truncated)'
    : message

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_notification: silent,
      }),
    })

    const data = await tgRes.json()
    if (!tgRes.ok || !data.ok) {
      return res.status(500).json({
        error: `Telegram API error: ${data.description || tgRes.statusText || 'unknown'}`,
        telegramResponse: data,
      })
    }

    return res.status(200).json({ ok: true, messageId: data.result?.message_id })
  } catch (err) {
    return res.status(500).json({ error: `Telegram fetch failed: ${err.message}` })
  }
}
