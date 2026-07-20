// ---------------------------------------------------------------------------
// agent/services/guardian.js — tick-driven position guardian.
//
// Owner (2026-07-20): "attention should be proportional to risk, not the
// clock." The main loop wakes every 5 minutes and the fast monitor every
// 30s — between ticks, nobody watches, and a spike can tag a TP zone and
// reverse unseen. The guardian closes that gap:
//
// - Subscribes to LIVE spot ticks for every symbol with an OPEN position
//   (bot-tracked or adopted). Flat symbols cost nothing.
// - On a significant move (default ≥ 0.05% since the last evaluation), it
//   immediately runs the existing, tested guard sweeps — trade guards
//   (TP ladder partials, break-even, trailing) and the profit keeper —
//   instead of waiting for the next loop. No new decision logic: the same
//   rules, fired by price instead of by schedule.
// - Single-flight with a short cooldown so a tick storm can't stampede the
//   broker API; the 5-minute loop remains the guaranteed backstop.
//
// A 30s maintenance tick keeps the subscription honest: re-reads the open
// set, reconnects dropped sockets, beats the `guardian` heartbeat. Toggle:
// agent_state `guardian` ('true' default; 'false' disables).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

/** Pure: is this move big enough to wake the guards? */
export function significantMove(prevPrice, price, minPct = 0.05) {
  if (!(prevPrice > 0) || !(price > 0)) return false
  return Math.abs((price - prevPrice) / prevPrice) * 100 >= minPct
}

/** Symbols with open positions → their broker symbolIds (via symbol_id_map). */
export function watchedSymbolIds(db) {
  let map = {}
  try { map = JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { map = {} }
  let rows = []
  try {
    rows = db.prepare(`SELECT DISTINCT UPPER(symbol) AS s FROM monitored_positions WHERE status = 'active'`).all()
  } catch { rows = [] }
  const ids = []
  for (const r of rows) {
    const id = map[r.s]
    if (id) ids.push({ symbol: r.s, symbolId: Number(id) })
  }
  return ids.sort((a, b) => a.symbolId - b.symbolId)
}

export function startGuardian(db, getCreds, deps = {}) {
  const maintMs = deps.maintMs ?? 30_000
  const cooldownMs = deps.cooldownMs ?? 2_500
  let stream = null
  let streamKey = ''          // which symbolId set the open stream covers
  let lastEval = new Map()    // symbolId → price at last guard evaluation
  let sweeping = false
  let lastSweepAt = 0
  let stopped = false

  const teardown = () => {
    try { stream?.close() } catch { /* already closed */ }
    stream = null
    streamKey = ''
  }

  const sweep = async (creds, why) => {
    const now = Date.now()
    if (sweeping || now - lastSweepAt < cooldownMs) return
    sweeping = true
    lastSweepAt = now
    try {
      const tg = await import('./trade-guard.js')
      const pk = await import('./profit-keeper.js')
      const g = await tg.runTradeGuards(db, creds).catch(err => ({ error: err.message }))
      const p = await pk.runProfitKeeper(db, creds).catch(err => ({ error: err.message }))
      const acted = (g?.slMoves || 0) + (g?.partialCloses || 0) + (p?.slMoves || 0) + (p?.closes || 0) + (p?.scaleOuts || 0)
      if (acted > 0) console.log(`[guardian] ${why} → ${acted} guard action(s)`)
    } catch (err) {
      console.error('[guardian] sweep failed:', err.message)
    } finally {
      sweeping = false
    }
  }

  const onTick = (creds) => (tick) => {
    const price = tick.bid != null && tick.ask != null ? (tick.bid + tick.ask) / 2 : tick.bid ?? tick.ask
    if (!(price > 0)) return
    const minPct = Number(getState(db, 'guardian_move_pct')) || 0.05
    const prev = lastEval.get(tick.symbolId)
    if (prev == null) { lastEval.set(tick.symbolId, price); return }
    if (!significantMove(prev, price, minPct)) return
    lastEval.set(tick.symbolId, price)
    sweep(creds, `move on symbol ${tick.symbolId}`)
  }

  const maintain = async () => {
    let err = null
    try {
      const creds = getCreds(db)
      const enabled = (getState(db, 'guardian') || 'true') !== 'false'
      if (!creds?.ready || !enabled) { teardown(); return }
      const watched = watchedSymbolIds(db)
      const key = watched.map(w => w.symbolId).join(',')
      if (key !== streamKey || (!stream && key)) {
        teardown()
        if (key) {
          const { wsStreamSpots } = await import('../lib/ctrader-ws.js')
          stream = await wsStreamSpots(
            creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
            watched.map(w => w.symbolId),
            onTick(creds),
            () => { stream = null; streamKey = '' }, // dropped → next maintenance tick reconnects
          )
          streamKey = key
          lastEval = new Map()
          console.log(`[guardian] watching ticks on ${watched.map(w => w.symbol).join(', ')}`)
        }
      }
    } catch (e) {
      err = e
      teardown() // rebuilt next tick
      console.error('[guardian] maintenance failed:', e.message)
    }
    try {
      const hb = await import('./heartbeat.js')
      hb.beat(db, 'guardian', { ok: !err, error: err?.message ?? null })
    } catch { /* observability only */ }
  }

  const t = setInterval(() => { if (!stopped) maintain() }, maintMs)
  t.unref?.()
  setTimeout(() => maintain(), 3_000) // first attach shortly after boot
  return () => { stopped = true; clearInterval(t); teardown() }
}
