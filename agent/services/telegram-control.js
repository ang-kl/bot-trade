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

//   /chart   — /chart <SYMBOL> [tf=1h] [+ai]: render a self-contained HTML
//              chart (candles + default overlays) and send it as a document
//              with a plain-words annotation caption. '+ai' adds the optional
//              Gemini commentary (GEMINI_API_KEY only — never Anthropic).

import fs from 'node:fs'
import path from 'node:path'
import { getState, setState } from '../db.js'

const TG_API = 'https://api.telegram.org'

// Telegram hard-caps document captions at 1024 chars.
const TG_CAPTION_MAX = 1024

/**
 * Heavy lifting for /chart, split out with injectable deps so tests need no
 * network and no sibling modules (indicators/chart-render/annotate are lazy).
 *
 * args: the text AFTER "/chart", e.g. "EURUSD 4h +ai".
 * Returns { ok, reply } — reply is only set when nothing was sent (errors);
 * on success the document itself (with caption) is the answer.
 */
export async function handleChartCommand(db, creds, args, deps = {}) {
  // --- arg parsing: SYMBOL [tf] [+ai], order-tolerant for the flag ---
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean)
  const wantAi = tokens.some(t => t.toLowerCase() === '+ai')
  const rest = tokens.filter(t => t.toLowerCase() !== '+ai')
  const symbol = (rest[0] || '').toUpperCase()
  const timeframe = rest[1] || '1h' // default per contract
  if (!symbol) return { ok: false, reply: 'Usage: /chart <SYMBOL> [timeframe] [+ai] — e.g. /chart EURUSD 4h +ai' }

  try {
    // --- symbol resolution (polite reply on unknown, never a throw) ---
    const getSymbolMap = deps.getSymbolMap ?? (await import('../lib/ctrader-creds.js')).getSymbolMap
    const symbolId = getSymbolMap(db)[symbol]
    if (!symbolId) return { ok: false, reply: `Sorry, I don't know the symbol "${symbol}". /status shows what's being watched.` }

    // --- bars (300, drop nothing here — annotate uses closed bars itself) ---
    const fetchBars = deps.fetchBars ?? (async () => {
      const { wsGetTrendbarsBatch } = await import('../lib/ctrader-ws.js')
      const byPeriod = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, [timeframe], 300, 60_000)
      return byPeriod[timeframe] || []
    })
    const bars = await fetchBars({ symbol, symbolId, timeframe })
    if (!bars?.length) return { ok: false, reply: `No bars came back for ${symbol} ${timeframe} — market data may be unavailable right now.` }

    // --- default overlays, server-computed so the doc matches the app ---
    const ind = deps.indicators ?? await import('../lib/indicators.js')
    const overlays = {
      sma20: ind.smaSeries(bars, 20),
      sma50: ind.smaSeries(bars, 50),
      sma200: ind.smaSeries(bars, 200),
      vwap: ind.vwapSeries(bars, 0),
      fvg: ind.findFvgZones(bars),
      vp: ind.volumeProfile(bars, { type: 'session' }),
    }

    // --- annotation (deterministic plain words) + optional Gemini line ---
    const annotateMod = deps.annotate ?? await import('./annotate.js')
    const annotation = await annotateMod.buildAnnotation(db, { symbol, timeframe, bars, overlays })
    let commentary = null
    if (wantAi && process.env.GEMINI_API_KEY) {
      commentary = await annotateMod.geminiCommentary(annotation.lines, { symbol, timeframe }) // null on any failure
    }

    // --- render + save under the persistent reports folder ---
    const render = deps.renderChartHtml ?? (await import('../lib/chart-render.js')).renderChartHtml
    const dirFn = deps.reportsDir ?? (await import('../lib/backtest-report.js')).reportsDir
    const dir = dirFn()
    fs.mkdirSync(dir, { recursive: true })
    // serial = 1 + highest existing chart-* serial, zero-padded — stable
    // across restarts because it is derived from the folder contents.
    const serial = 1 + fs.readdirSync(dir)
      .map(n => n.match(/^chart-.*-(\d+)\.html$/)?.[1])
      .filter(Boolean)
      .reduce((m, n) => Math.max(m, Number(n)), 0)
    const filename = `chart-${symbol}-${timeframe}-${String(serial).padStart(3, '0')}.html`
    const html = render({ symbol, timeframe, bars, overlays, annotation: { ...annotation, commentary }, filename })
    fs.writeFileSync(path.join(dir, filename), html)

    // --- caption: annotation lines (+ai commentary), hard-capped at 1024 ---
    const caption = [
      `${symbol} ${timeframe} — ${bars.length} bars`,
      ...annotation.lines,
      ...(commentary ? ['', `AI: ${commentary}`] : []),
    ].join('\n').slice(0, TG_CAPTION_MAX)

    const send = deps.sendDocument ?? sendTelegramDocument
    await send({ filename, buffer: Buffer.from(html, 'utf8'), caption })
    return { ok: true, reply: null, filename, caption }
  } catch (err) {
    return { ok: false, reply: `Chart failed: ${err.message}` }
  }
}

/** Multipart upload of an HTML buffer to the owner chat via sendDocument. */
async function sendTelegramDocument({ filename, buffer, caption }) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const form = new FormData()
  form.append('chat_id', ownerChatId())
  form.append('caption', caption.slice(0, TG_CAPTION_MAX))
  form.append('document', new Blob([buffer], { type: 'text/html' }), filename)
  const res = await fetch(`${TG_API}/bot${token}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json()
  if (!data.ok) throw new Error(data.description || 'Telegram sendDocument failed')
  return data.result
}

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
      } else if (cmd === '/autopilot') {
        const arg = msg.text.trim().split(/\s+/)[1]?.toLowerCase()
        if (['off', 'suggest', 'auto'].includes(arg)) {
          setState(db, 'autopilot_mode', arg)
          reply = `🧭 Autopilot mode: ${arg}${arg === 'auto' ? ' — arms/disarms within the daily change cap; LIVE accounts get suggestions only.' : ''}`
        } else {
          reply = `Autopilot is ${getState(db, 'autopilot_mode') || 'off'}. Use: /autopilot off | suggest | auto`
        }
      } else if (cmd === '/arm') {
        // /arm <strategy> <SYMBOL> <tf> — accept an autopilot suggestion by thumb
        const [, strat, sym, tf] = msg.text.trim().split(/\s+/)
        if (!strat || !sym || !tf) {
          reply = 'Usage: /arm <strategy> <SYMBOL> <timeframe> — e.g. /arm ema_pullback GBPUSD 12h'
        } else {
          const read = (k) => { try { return JSON.parse(getState(db, k) || 'null') } catch { return null } }
          const enabled = new Set(read('enabled_strategies_json') || ['fib_618_fade'])
          enabled.add(strat)
          setState(db, 'enabled_strategies_json', JSON.stringify([...enabled]))
          const matrix = read('autotrade_matrix_json') || {}
          matrix[sym.toUpperCase()] = [...new Set([...(matrix[sym.toUpperCase()] || []), tf])]
          setState(db, 'autotrade_matrix_json', JSON.stringify(matrix))
          reply = `✅ armed ${strat} on ${sym.toUpperCase()} ${tf}. /status to review, /pause to stop everything.`
        }
      } else if (cmd === '/chart') {
        // /chart <SYMBOL> [tf] [+ai] — sends an HTML chart document; a text
        // reply only comes back when something went wrong (or usage help).
        const args = msg.text.trim().split(/\s+/).slice(1).join(' ')
        const res = await handleChartCommand(db, deps.creds, args, deps.chartDeps || {})
        reply = res.reply
        if (res.ok) {
          // Document already sent with its caption — log the action here
          // because the shared reply path below only fires on a text reply.
          handled++
          try {
            db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
              .run('TG', cmd, JSON.stringify({ from: 'telegram', filename: res.filename }))
          } catch { /* logging never blocks */ }
        }
      } else if (cmd === '/news') {
        const symArg = msg.text.trim().split(/\s+/)[1]
        const { newsLinesFor } = await import('./news-calendar.js')
        const lines = await newsLinesFor(db, symArg || 'EURUSD')
        reply = lines.length
          ? `📰 ${symArg ? symArg.toUpperCase() : 'EURUSD'} — scheduled news (±24h):\n${lines.join('\n')}`
          : 'No high/medium-impact scheduled news in the window (or the feed is unreachable).'
      } else if (cmd === '/help' || cmd === '/start') {
        reply = 'Commands: /status /pause /resume /pending /killall /chart <SYM> [tf] [+ai] /autopilot [off|suggest|auto] /arm <strategy> <SYM> <tf> /help'
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
