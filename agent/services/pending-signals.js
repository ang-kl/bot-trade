// ---------------------------------------------------------------------------
// agent/services/pending-signals.js
//
// Owner (2026-07-20): "do you separate which one you would trade based on
// market open? and which one will trade later when example NY opens?"
//
// Before this, a hot signal on a symbol whose OWN market was closed (a
// stock/index outside NYSE hours, a soft/grain outside its exchange window,
// FX/metal/commodity over the weekend) was simply vetoed and forgotten —
// loop.js's comment said "the scan will fire it again", which only held true
// if the rotating scanner happened to re-visit that exact symbol on a later
// cycle while it was STILL hot. With 59 symbols scanned ~15 at a time, that
// wasn't a real guarantee.
//
// This queue makes it explicit: autoTrade() calls queuePendingSignal() the
// moment it defers a signal for a closed market, and runPendingSignals()
// (a loop.js phase, every cycle) re-checks each queued symbol. The instant
// its market reopens, the queued row is resolved against a FRESH re-scan —
// never the stale price from when the market was shut — through the exact
// same gate chain (dispatchSymbolSignal) a live signal goes through. If the
// zone no longer holds, or the bias flipped, the row is dropped as expired,
// not fired blind.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'

// Queue horizon scales with the signal's own timeframe — a 1w/1mo fade is
// still a live thesis after a few closed days; a 15m scalp isn't worth
// re-checking a week later. Floored at 3 days (a Friday-evening FX/metal
// signal needs to survive the full weekend close), capped at 21 (don't
// queue a stale idea forever just because its timeframe is huge).
export function expiryMsFor(timeframe) {
  const bar = tfMs(timeframe) || 3_600_000
  return Math.min(Math.max(bar * 8, 3 * 86_400_000), 21 * 86_400_000)
}

/**
 * Queue a signal autoTrade() just deferred because the symbol's market is
 * closed. One live 'pending' row per symbol — a fresher closed-market read
 * of the same zone replaces the older one instead of piling up duplicates.
 */
export function queuePendingSignal(db, symbol, synth, marketReason, now = Date.now()) {
  if (!synth?.consensus_bias || synth.consensus_bias === 'skip') return
  const timeframe = synth.timeframe || null
  const expiresAt = new Date(now + expiryMsFor(timeframe)).toISOString()
  db.prepare(`DELETE FROM pending_signals WHERE symbol = ? AND status = 'pending'`).run(symbol)
  db.prepare(`
    INSERT INTO pending_signals (symbol, bias, conviction, strategy, timeframe, market_reason, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(symbol, synth.consensus_bias, synth.overall_conviction ?? null, synth.strategy ?? null, timeframe, marketReason ?? null, expiresAt)
}

/**
 * Re-check every queued signal. Runs every loop cycle regardless of scan
 * rotation — deps injectable for tests: { isSymbolMarketOpen, scanSymbolFib,
 * dispatchSymbolSignal, getSymbolMap, now }.
 */
export async function runPendingSignals(db, creds, deps = {}) {
  const rows = db.prepare(`SELECT * FROM pending_signals WHERE status = 'pending'`).all()
  if (rows.length === 0) return { checked: 0, fired: 0, expired: 0 }

  const now = deps.now ?? (() => Date.now())
  const nowMs = now()
  const resolve = (id, status, note) => db.prepare(
    `UPDATE pending_signals SET status = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?`,
  ).run(status, note ?? null, id)

  // TTL sweep — a queued signal past its horizon is dropped regardless of
  // market state; the thesis is presumed stale by then.
  let expired = 0
  const live = []
  for (const row of rows) {
    if (row.expires_at && Date.parse(row.expires_at) <= nowMs) {
      resolve(row.id, 'expired', 'ttl_elapsed')
      expired++
    } else {
      live.push(row)
    }
  }
  if (live.length === 0) return { checked: rows.length, fired: 0, expired }
  if (!creds?.ready) return { checked: rows.length, fired: 0, expired } // no broker link — retry next cycle

  const isOpen = deps.isSymbolMarketOpen ?? (await import('./symbol-hours.js')).isSymbolOpenCached
  const openRows = live.filter(row => isOpen(db, row.symbol, new Date(nowMs)).open)
  if (openRows.length === 0) return { checked: rows.length, fired: 0, expired }

  const scanSymbolFib = deps.scanSymbolFib ?? (await import('./fib-strategy.js')).scanSymbolFib
  const dispatchSymbolSignal = deps.dispatchSymbolSignal ?? (await import('../loop.js')).dispatchSymbolSignal
  const prepareStatements = deps.prepareStatements ?? (await import('../loop.js')).prepareStatements
  const getSymbolMap = deps.getSymbolMap ?? (await import('../lib/ctrader-creds.js')).getSymbolMap
  const symbolMap = getSymbolMap(db)
  const s = prepareStatements(db)

  let watch = []
  try {
    watch = JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]')
      .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
  } catch { /* empty */ }

  let fired = 0
  for (const row of openRows) {
    const symbolId = symbolMap[String(row.symbol).toUpperCase()]
    if (!symbolId) { resolve(row.id, 'expired', 'symbolId_unknown'); expired++; continue }
    try {
      const { signal, error } = await scanSymbolFib(creds, row.symbol, symbolId, {})
      if (error) continue // transient fetch failure — leave pending, retry next cycle
      if (!signal || signal.bias !== row.bias) {
        resolve(row.id, 'expired', signal ? `bias_flipped_to_${signal.bias}` : 'zone_no_longer_valid')
        expired++
        continue
      }
      const result = await dispatchSymbolSignal(db, s, watch, row.symbol, signal)
      if (result.fired) {
        resolve(row.id, 'fired', `${signal.timeframe}@${signal.entry}`)
        fired++
      } else {
        resolve(row.id, 'expired', 'reopened_but_not_placed (gate/risk declined)')
        expired++
      }
    } catch (err) {
      resolve(row.id, 'expired', `retry_failed: ${err.message}`)
      expired++
    }
  }
  return { checked: rows.length, fired, expired }
}
