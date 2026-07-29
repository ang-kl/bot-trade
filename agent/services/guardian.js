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
//
// Owner (2026-07-26): "when market volume spike, check immediately" — for a
// FLAT watchlist symbol (no open position), the SCAN phase only reaches it
// once every few 5-min loops (selectScanBatch rotates ~15 fresh symbols per
// run). A spike on a symbol deep in that rotation just waits its turn. Since
// this stream is already subscribed and push-based (no extra polling cost
// per tick), it also covers the ENABLED watchlist, not just held positions:
// a spike on a flat symbol doesn't run a guard sweep (nothing to guard) —
// it flags the symbol via scan_priority_symbols_json so the next SCAN phase
// bumps it to the front of the rotation instead of waiting. Toggle:
// agent_state `spike_scan_priority` ('true' default; 'false' reverts to
// held-only subscription, the pre-2026-07-26 behaviour).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { readTradableUnion } from './watchlists.js'
import { isSpikeMove, SPIKE_PCT_PER_MIN } from './fast-monitor.js'

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

/** Enabled watchlist symbols (autopilot's universe, falling back to the legacy
 * watchlist — same source loop.js's SCAN PHASE reads) with a known symbolId. */
export function watchlistSymbolIds(db) {
  let map = {}
  try { map = JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { map = {} }
  // The spot stream must cover the UNION of every enabled account's list.
  // Scoping it to one account would leave another account's instruments
  // untick'd while that account was still holding positions in them.
  let list = []
  try { list = readTradableUnion(db) } catch { list = [] }
  const ids = []
  for (const entry of list) {
    if (!entry?.symbol || entry.enabled === false || entry.force_skip) continue
    const sym = entry.symbol
    const id = map[sym]
    if (id) ids.push({ symbol: sym, symbolId: Number(id) })
  }
  return ids.sort((a, b) => a.symbolId - b.symbolId)
}

const SCAN_PRIORITY_STATE_KEY = 'scan_priority_symbols_json'
const SCAN_PRIORITY_TTL_MS = 15 * 60_000 // stale if the loop never consumes it

/** Flag one symbol for the next SCAN phase to bump ahead of its rotation turn. */
export function flagScanPriority(db, symbol) {
  try {
    const raw = JSON.parse(getState(db, SCAN_PRIORITY_STATE_KEY) || '{}')
    const map = raw && typeof raw === 'object' ? raw : {}
    map[String(symbol).toUpperCase()] = Date.now()
    setState(db, SCAN_PRIORITY_STATE_KEY, JSON.stringify(map))
  } catch { /* a missed flag just waits for its ordinary rotation turn */ }
}

/**
 * Read and CLEAR symbols flagged for priority scanning — consumed once by
 * the SCAN phase each loop, so a symbol that spiked and got covered doesn't
 * keep jumping the queue forever. Never throws.
 */
export function takeScanPrioritySymbols(db, ttlMs = SCAN_PRIORITY_TTL_MS) {
  try {
    const raw = JSON.parse(getState(db, SCAN_PRIORITY_STATE_KEY) || '{}')
    const map = raw && typeof raw === 'object' ? raw : {}
    const now = Date.now()
    const symbols = Object.entries(map).filter(([, at]) => now - Number(at) < ttlMs).map(([sym]) => sym)
    setState(db, SCAN_PRIORITY_STATE_KEY, '{}')
    return symbols
  } catch { return [] }
}

export function startGuardian(db, getCreds, deps = {}) {
  const maintMs = deps.maintMs ?? 30_000
  const cooldownMs = deps.cooldownMs ?? 2_500
  let stream = null
  let streamKey = ''          // which symbolId set the open stream covers
  let lastEval = new Map()    // symbolId → price at last guard evaluation
  let lastEvalAt = new Map()  // symbolId → ms, watchlist-only spike timing
  let heldIds = new Set()     // symbolIds with an open position — guard sweep vs spike-flag branch
  let symbolById = new Map()  // symbolId → symbol string, for flagging
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
    if (heldIds.has(tick.symbolId)) {
      const minPct = Number(getState(db, 'guardian_move_pct')) || 0.05
      const prev = lastEval.get(tick.symbolId)
      if (prev == null) { lastEval.set(tick.symbolId, price); return }
      if (!significantMove(prev, price, minPct)) return
      lastEval.set(tick.symbolId, price)
      sweep(creds, `move on symbol ${tick.symbolId}`)
      return
    }
    // Flat watchlist symbol — nothing to guard, but a fast enough move is
    // the same leading "this symbol just got busy" signal fast-monitor uses
    // for open positions. Flag it so the SCAN phase bumps it ahead of its
    // ordinary rotation turn instead of waiting.
    const now = Date.now()
    const prevPrice = lastEval.get(tick.symbolId)
    const prevAt = lastEvalAt.get(tick.symbolId)
    if (prevPrice != null && prevAt != null && isSpikeMove(prevPrice, prevAt, price, now, SPIKE_PCT_PER_MIN)) {
      const sym = symbolById.get(tick.symbolId)
      if (sym) flagScanPriority(db, sym)
    }
    lastEval.set(tick.symbolId, price)
    lastEvalAt.set(tick.symbolId, now)
  }

  const maintain = async () => {
    let err = null
    try {
      const creds = getCreds(db)
      const enabled = (getState(db, 'guardian') || 'true') !== 'false'
      if (!creds?.ready || !enabled) { teardown(); return }
      const held = watchedSymbolIds(db)
      const spikePriorityOn = (getState(db, 'spike_scan_priority') || 'true') !== 'false'
      const watchlist = spikePriorityOn ? watchlistSymbolIds(db) : []
      const combined = new Map()
      for (const w of held) combined.set(w.symbolId, w)
      for (const w of watchlist) if (!combined.has(w.symbolId)) combined.set(w.symbolId, w)
      const watched = [...combined.values()].sort((a, b) => a.symbolId - b.symbolId)
      const key = watched.map(w => w.symbolId).join(',')
      // Recomputed every pass regardless of whether the stream itself needs
      // rebuilding: a symbol can move from watchlist-only to held (a new
      // position opens on it) without the COMBINED id set changing at all,
      // and that reclassification must still take effect on the next tick.
      heldIds = new Set(held.map(w => w.symbolId))
      symbolById = new Map(watched.map(w => [w.symbolId, w.symbol]))
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
          lastEvalAt = new Map()
          console.log(`[guardian] watching ticks on ${watched.map(w => w.symbol).join(', ')} (${held.length} held, ${watched.length - held.length} watchlist-only)`)
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

  // `stopped` is a SHUTDOWN flag, not a re-entrancy one — maintain() awaits a
  // websocket handshake, so a connect slower than maintMs let a second copy
  // start, tear down the stream the first was about to install, and open
  // another (duplicate streams, each with its own heartbeat timer, both
  // mutating streamKey). sweep() has had a proper guard all along; this is
  // the same discipline for maintain().
  let maintaining = false
  const maintainOnce = async () => {
    if (stopped || maintaining) return
    maintaining = true
    try { await maintain() } finally { maintaining = false }
  }
  const t = setInterval(maintainOnce, maintMs)
  t.unref?.()
  setTimeout(maintainOnce, 3_000) // first attach shortly after boot
  return () => { stopped = true; clearInterval(t); teardown() }
}
