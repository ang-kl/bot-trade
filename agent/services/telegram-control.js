// Telegram two-way control — the owner's travel console.
// Long-polls getUpdates once per loop cycle (no webhook: Railway restarts
// would orphan it) and answers a fixed command set. ONLY the owner's chat
// id may command the bot; every accepted command lands in action_log.
//
//   /status  — loop phase, armed strategies+matrix, pending orders,
//              open positions, balance, last error
//   /pause   — scan + autotrade OFF (pending orders at the broker remain;
//              they expire on their own GTD)
//   /resume  — scan + autotrade back ON
//   /killall — pause + cancel every working pending order (positions are
//              NOT closed — closing real positions from a chat command is
//              a bigger hammer than travel needs; the app's Kill all does that)
//   /pending — list working pending orders
//   /help    — this list

import { getState, setState } from '../db.js'

const TG_API = 'https://api.telegram.org'

async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`)
  return data.result
}

function ownerChatId() {
  return String(process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '')
}

function fmtStatus(db) {
  const on = (k, dflt) => (getState(db, k) ?? dflt)
  let matrix = {}
  try { matrix = JSON.parse(getState(db, 'pending_matrix_json') || '{}') } catch { /* show empty */ }
  let strategies = []
  try { strategies = JSON.parse(getState(db, 'enabled_strategies_json') || '["fib_618_fade"]') } catch { /* default */ }
  const pend = db.prepare("SELECT symbol, timeframe FROM pending_orders WHERE status = 'working'").all()
  const pos = db.prepare("SELECT symbol, side FROM monitored_positions WHERE status = 'active'").all()
  return [
    `🤖 bot-trade status`,
    `phase: ${on('loop_phase', 'idle')}`,
    `scan: ${on('scan_enabled', 'true') !== 'false' ? 'ON' : 'OFF'} · autotrade: ${on('autotrade_enabled', 'false') === 'true' ? 'ON' : 'OFF'} · pending mode: ${on('pending_mode_enabled', 'false') === 'true' ? 'ON' : 'OFF'}`,
    `strategies: ${strategies.join(', ') || 'none'}`,
    `pending armed: ${Object.entries(matrix).map(([s, t]) => `${s}(${t.join('/')})`).join(' ') || '—'}`,
    `working pending orders: ${pend.map(p => `${p.symbol} ${p.timeframe}`).join(', ') || 'none'}`,
    `open positions: ${pos.map(p => `${p.symbol} ${String(p.side).toUpperCase()}`).join(', ') || 'flat'}`,
    `balance: $${Number(getState(db, 'account_balance_usd')) || '?'}`,
    `last error: ${on('last_loop_error', 'none')}`,
  ].join('\n')
}

/**
 * One poll pass — called once per loop cycle. Never throws (a Telegram
 * outage must not touch trading). Returns how many commands were handled.
 */
export async function pollTelegramCommands(db, deps = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 0
  const owner = ownerChatId()
  if (!owner) return 0
  let handled = 0
  try {
    const offset = Number(getState(db, 'tg_update_offset')) || 0
    const updates = await tg('getUpdates', { offset: offset + 1, timeout: 0, allowed_updates: ['message'] })
    for (const u of updates) {
      setState(db, 'tg_update_offset', String(u.update_id))
      const msg = u.message
      if (!msg?.text) continue
      if (String(msg.chat?.id) !== owner) continue // strangers are ignored silently
      const cmd = msg.text.trim().split(/[@\s]/)[0].toLowerCase()
      let reply = null
      if (cmd === '/status') {
        reply = fmtStatus(db)
      } else if (cmd === '/pause') {
        setState(db, 'scan_enabled', 'false')
        setState(db, 'autotrade_enabled', 'false')
        reply = '⏸ Paused — scan + autotrade OFF. Broker-side pending orders remain and expire on their own. /resume to restart.'
      } else if (cmd === '/resume') {
        setState(db, 'scan_enabled', 'true')
        setState(db, 'autotrade_enabled', 'true')
        reply = '▶️ Resumed — scan + autotrade ON.'
      } else if (cmd === '/pending') {
        const rows = db.prepare("SELECT symbol, timeframe, level, expires_at FROM pending_orders WHERE status = 'working'").all()
        reply = rows.length
          ? rows.map(r => `⏳ ${r.symbol} ${r.timeframe} @ ${r.level} (expires ${r.expires_at}Z)`).join('\n')
          : 'No working pending orders.'
      } else if (cmd === '/killall') {
        setState(db, 'scan_enabled', 'false')
        setState(db, 'autotrade_enabled', 'false')
        let cancelled = 0
        const rows = db.prepare("SELECT id, symbol, order_id FROM pending_orders WHERE status = 'working'").all()
        if (rows.length && deps.cancelOrder && deps.creds?.ready) {
          for (const r of rows) {
            try {
              await deps.cancelOrder(deps.creds, { orderId: r.order_id })
              db.prepare("UPDATE pending_orders SET status = 'cancelled', note = 'telegram /killall' WHERE id = ?").run(r.id)
              cancelled++
            } catch { /* reconcile pass will resync the stragglers */ }
          }
        }
        reply = `🛑 Killed — paused everything, cancelled ${cancelled}/${rows.length} pending order(s). Open POSITIONS are untouched (close those in cTrader or the app).`
      } else if (cmd === '/help' || cmd === '/start') {
        reply = 'Commands: /status /pause /resume /pending /killall /help'
      }
      if (reply) {
        handled++
        try {
          db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
            .run('TG', cmd, JSON.stringify({ from: 'telegram' }))
        } catch { /* logging never blocks */ }
        await tg('sendMessage', { chat_id: owner, text: reply })
      }
    }
  } catch { /* telegram down — trading must not care */ }
  return handled
}

/** Fire-and-forget owner notification (used by the pending manager). */
export async function notifyOwner(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  const owner = ownerChatId()
  if (!owner) return
  try { await tg('sendMessage', { chat_id: owner, text }) } catch { /* best effort */ }
}
