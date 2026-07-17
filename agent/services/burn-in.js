// ---------------------------------------------------------------------------
// agent/services/burn-in.js — track-record burn-in mode.
//
// Owner order (2026-07-17): "run 30 forex pairs today and the whole
// watchlist for the next two days — keep trading them and micro-close
// within minutes to build a credible historical log of strategies and
// filters." The bot has one deliberate fill and zero completed organic
// trades; sizing decisions need a sample.
//
// What this does, every loop cycle while armed:
// - picks up to `maxPerCycle` enabled watchlist symbols with no open bot
//   position and no recent burn-in attempt (cooldown-aware, so the Order
//   log isn't flooded with repeat vetoes)
// - direction = 1h momentum (last close vs previous); SL = 1×ATR(14) on 1h
//   (floored at minSLDistancePct × price so the risk gate can't veto the
//   geometry); TP = 1.6 × SL distance (clears minRR 1.5)
// - places the order THROUGH autoTrade() — market-hours gate, risk gate,
//   spread gate, sizing, exec engine, structured label, monitored_positions.
//   Nothing mocked: every attempt lands in the Order log (source 'burnin').
// - `time_cap_minutes` (default 20) makes the monitor close each position
//   within minutes — the completed round-trips ARE the track record.
//
// Deliberate limits:
// - size is HARD-PINNED to `lots` (default 0.01) regardless of the dynamic
//   sizing — the whole point of the sample is to measure expectancy before
//   risking real size.
// - the master switches still rule: burn-in runs only while autotrade is
//   armed; /pause, /killall and the equity stop all stop it.
// - maxOpenPositions in the risk config caps concurrency as usual.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { atrFromBars } from './profit-keeper.js'

export const DEFAULT_BURN_IN = {
  on: false,
  lots: 0.01,          // hard size pin — the sample must be cheap
  timeCapMinutes: 20,  // monitor closes the position after this
  maxPerCycle: 3,      // new positions per 5-min loop
  cooldownMinutes: 60, // per-symbol pause between burn-in attempts
}

export function loadBurnInConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'burn_in_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      const cfg = { ...DEFAULT_BURN_IN, ...parsed }
      cfg.lots = Math.min(0.05, Math.max(0.01, Number(cfg.lots) || 0.01))
      cfg.timeCapMinutes = Math.min(240, Math.max(5, Number(cfg.timeCapMinutes) || 20))
      cfg.maxPerCycle = Math.min(10, Math.max(1, Math.round(Number(cfg.maxPerCycle) || 3)))
      cfg.cooldownMinutes = Math.min(24 * 60, Math.max(10, Number(cfg.cooldownMinutes) || 60))
      return cfg
    }
  } catch { /* corrupt state — defaults */ }
  return { ...DEFAULT_BURN_IN }
}

function log(...args) {
  console.log('[burn-in]', ...args)
}

/**
 * One burn-in pass. Deps injectable for tests:
 * { autoTrade, wsGetTrendbarsBatch, loadRiskConfig, now }.
 * @returns {{skipped?:string, attempted:number, placed:number, summary?:string}}
 */
export async function runBurnIn(db, creds, deps = {}) {
  const cfg = loadBurnInConfig(db)
  if (!cfg.on) return { skipped: 'off', attempted: 0, placed: 0 }
  if (getState(db, 'autotrade_enabled') !== 'true') return { skipped: 'autotrade off', attempted: 0, placed: 0 }
  if (!creds?.ready) return { skipped: 'no creds', attempted: 0, placed: 0 }

  const autoTrade = deps.autoTrade ?? (await import('../loop.js')).autoTrade
  const wsGetTrendbarsBatch = deps.wsGetTrendbarsBatch ?? (await import('../lib/ctrader-ws.js')).wsGetTrendbarsBatch
  const now = deps.now ?? (() => Date.now())

  // Enabled watchlist, minus symbols with an open bot position.
  let watch = []
  try {
    watch = JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]')
      .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
      .filter(w => w.enabled !== false && !w.force_skip)
      .map(w => w.symbol)
  } catch { /* empty */ }
  if (watch.length === 0) return { skipped: 'empty watchlist', attempted: 0, placed: 0 }

  const open = new Set(
    db.prepare(`SELECT symbol FROM monitored_positions WHERE status = 'active'`).all().map(r => r.symbol),
  )

  // Per-symbol attempt cooldown — burn-in must not hammer the same symbol
  // (or flood the Order log with repeat cooldown vetoes) every 5 minutes.
  let last = {}
  try { last = JSON.parse(getState(db, 'burn_in_last_json') || '{}') || {} } catch { last = {} }
  const cooledOff = (sym) => (now() - (Number(last[sym]) || 0)) >= cfg.cooldownMinutes * 60_000

  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}

  const queue = watch.filter(s => !open.has(s) && cooledOff(s) && symbolMap[String(s).toUpperCase()])
    .slice(0, cfg.maxPerCycle)
  if (queue.length === 0) return { skipped: 'nothing due', attempted: 0, placed: 0 }

  // Geometry floor: the risk gate vetoes stops tighter than minSLDistancePct.
  let minSlPct = 0.0015
  try {
    const { loadRiskConfig } = deps.risk ?? await import('./risk.js')
    minSlPct = Number(loadRiskConfig(db).minSLDistancePct) || minSlPct
  } catch { /* default floor */ }

  let attempted = 0
  let placed = 0
  const notes = []
  for (const symbol of queue) {
    attempted++
    last[symbol] = now()
    try {
      const symbolId = symbolMap[String(symbol).toUpperCase()]
      const byTf = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1h'], 30, 20_000)
      const bars = (byTf['1h'] || []).slice(0, -1) // closed bars only
      if (bars.length < 16) { notes.push(`${symbol}: thin bars`); continue }
      const lastBar = bars[bars.length - 1]
      const prevBar = bars[bars.length - 2]
      const entry = lastBar.c
      const bias = lastBar.c >= prevBar.c ? 'long' : 'short'
      const dir = bias === 'long' ? 1 : -1
      const atr = atrFromBars(bars, 14)
      // SL: 1×ATR, floored so minSLDistancePct can't veto (20% headroom).
      const slDist = Math.max(atr || 0, entry * minSlPct * 1.2)
      if (!(slDist > 0)) { notes.push(`${symbol}: no volatility read`); continue }
      const synth = {
        consensus_bias: bias,
        entry,
        sl: entry - dir * slDist,
        tp1: entry + dir * slDist * 1.6, // RR 1.6 clears the minRR 1.5 gate
        strategy: 'burnin',
        overall_conviction: 8,
        timeframe: '1h',
        time_cap_minutes: cfg.timeCapMinutes,
        synthesis: `BURN-IN track-record trade — 1h momentum ${bias}, 1×ATR stop, closes in ≤${cfg.timeCapMinutes}m.`,
        invalidation_trigger: null,
        source: 'burnin',
      }
      // Full real path: market gate → risk gate → spread gate → exec engine.
      const result = await autoTrade(db, symbol, synth, { maxVolume: cfg.lots }, null)
      if (result) { placed++; log(`${symbol}: ${result.side} ${cfg.lots} placed (time cap ${cfg.timeCapMinutes}m)`) }
    } catch (err) {
      notes.push(`${symbol}: ${err.message}`)
      log(`${symbol}: failed — ${err.message}`)
    }
  }
  setState(db, 'burn_in_last_json', JSON.stringify(last))
  return {
    attempted,
    placed,
    notes,
    summary: `attempted=${attempted} placed=${placed}${notes.length ? ` notes=${notes.join(' · ')}` : ''}`,
  }
}
