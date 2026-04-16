// Telegram Feed API — fetches messages from configured Telegram channels
// using the bot token already stored in the strategy store.
//
// Actions:
//   - discover: Lists channels/groups the bot has access to
//   - fetch:    Gets recent messages from specified channels
//
// Uses Telegram Bot API directly — no external SDK needed.

const TG_API = 'https://api.telegram.org'

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

async function tgGet(botToken, method, params = {}) {
  const url = new URL(`${TG_API}/bot${botToken}/${method}`)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
  const data = await res.json()
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`)
  return data.result
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const { action, botToken } = body

  if (!botToken) {
    return res.status(400).json({ error: 'botToken required' })
  }

  try {
    if (action === 'discover') {
      // Get updates to discover channels the bot can see
      const updates = await tgGet(botToken, 'getUpdates', { limit: 100 })
      const seen = new Map()
      for (const u of updates) {
        const msg = u.message || u.channel_post || u.edited_channel_post
        if (!msg?.chat) continue
        const chat = msg.chat
        if (!seen.has(chat.id)) {
          seen.set(chat.id, {
            chatId: chat.id,
            title: chat.title || '',
            username: chat.username || '',
            type: chat.type,
          })
        }
      }
      const channels = [...seen.values()].filter(c =>
        c.type === 'channel' || c.type === 'supergroup' || c.type === 'group',
      )
      return res.status(200).json({ channels })
    }

    // Verify a channel by @username — uses getChat to check if bot can access it
    if (action === 'verify') {
      const { username } = body
      if (!username) return res.status(400).json({ error: 'username required' })
      const chatId = username.startsWith('@') ? username : `@${username}`
      try {
        const chat = await tgGet(botToken, 'getChat', { chat_id: chatId })
        return res.status(200).json({
          ok: true,
          channel: {
            chatId: chat.id,
            title: chat.title || '',
            username: chat.username || '',
            type: chat.type,
            memberCount: chat.member_count || null,
            description: chat.description ? chat.description.slice(0, 200) : '',
          },
        })
      } catch (e) {
        // Bot might not be a member — check if channel exists publicly
        return res.status(200).json({
          ok: false,
          error: e.message,
          hint: 'Add your bot as a member/admin of this channel, then try again.',
        })
      }
    }

    if (action === 'fetch') {
      const { channels = [] } = body
      if (!Array.isArray(channels) || channels.length === 0) {
        return res.status(200).json({ messages: [] })
      }

      // Get recent updates — the bot must be a member of these channels
      const updates = await tgGet(botToken, 'getUpdates', { limit: 100 })

      const messages = []
      for (const u of updates) {
        const msg = u.message || u.channel_post || u.edited_channel_post
        if (!msg?.text) continue
        const chat = msg.chat || {}
        const chatName = chat.username || chat.title || ''

        // Match against requested channels (case-insensitive)
        const match = channels.some(ch => {
          const lower = ch.toLowerCase().replace(/^@/, '')
          return (
            (chat.username && chat.username.toLowerCase() === lower) ||
            (chat.title && chat.title.toLowerCase() === lower)
          )
        })
        if (!match) continue

        messages.push({
          channel: chatName,
          text: msg.text.slice(0, 500), // cap length
          date: msg.date ? msg.date * 1000 : null,
          messageId: msg.message_id,
        })
      }

      // Sort by date descending
      messages.sort((a, b) => (b.date || 0) - (a.date || 0))

      return res.status(200).json({ messages: messages.slice(0, 50) })
    }

    return res.status(400).json({ error: `unknown action: ${action || '(none)'}` })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'telegram-feed failed' })
  }
}
