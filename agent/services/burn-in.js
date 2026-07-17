// ---------------------------------------------------------------------------
// agent/services/burn-in.js — micro-quant track-record engine.
//
// Owner orders (2026-07-17): timeframes must be SOPHISTICATED and DYNAMIC —
// "not just # minutes": chosen per symbol from live market volume and
// condition, spanning minutes → hours (the days lane stays with the organic
// backtested combos). Target: ≥200 completed trades in 2 days.
//
// Per candidate symbol, each 5-minute cycle:
// 1. READ the market: relative 1-minute volume (relVol), ATR% on 5m and 1h,
//    1h momentum — one batched bar fetch.
// 2. PICK the operating plan (pickPlan, pure + tested):
//      hot volume + real 5m range   → 5m entries, ~12 min time cap
//      above-average volume         → 15m entries, ~30 min cap
//      quiet but trending/volatile 1h → 1h entries, ~2 h cap
//      quiet drift                  → 30m entries, ~45 min cap
//    Direction = momentum of the CHOSEN timeframe; SL = 1×ATR(chosen TF)
//    floored above minSLDistancePct; TP = 1.6×SL (clears minRR 1.5).
// 3. PACE toward the target (pacePlan, pure + tested): completed burn-in
//    trades since arming vs the linear schedule to targetTrades in
//    windowDays — behind → more symbols per cycle + shorter per-symbol
//    cooldowns; ahead → throttle back. The plan's own cooldown also scales
//    with volume (busy symbols retry sooner).
//
// Unchanged hard rules: size pinned 0.01–0.05; every order goes through the
// FULL autoTrade path (market gate, risk gate, spread gate, exec engine);
// runs only while autotrade is armed; /pause, Kill all and the equity stop
// all stop it; the fast monitor closes the time caps within ~a minute.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { atrFromBars } from './profit-keeper.js'
import { relVolFromBars } from './fast-monitor.js'

export const DEFAULT_BURN_IN = {
  on: false,
  lots: 0.01,          // hard size pin — the sample must be cheap
  maxPerCycle: 4,      // base new positions per 5-min loop (pacing adjusts)
  targetTrades: 200,   // completed round-trips the pacing steers toward…
  windowDays: 2,       // …within this window from arming
  startedAt: null,     // stamped by POST /actions/burn-in on arming
}

export function loadBurnInConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'burn_in_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      const cfg = { ...DEFAULT_BURN_IN, ...parsed }
      cfg.lots = Math.min(0.05, Math.max(0.01, Number(cfg.lots) || 0.01))
      cfg.maxPerCycle = Math.min(8, Math.max(1, Math.round(Number(cfg.maxPerCycle) || 4)))
      cfg.targetTrades = Math.min(500, Math.max(10, Math.round(Number(cfg.targetTrades) || 200)))
      cfg.windowDays = Math.min(7, Math.max(1, Number(cfg.windowDays) || 2))
      cfg.startedAt = typeof cfg.startedAt === 'string' ? cfg.startedAt : null
      return cfg
    }
  } catch { /* corrupt state — defaults */ }
  return { ...DEFAULT_BURN_IN }
}

/**
 * Market-condition → operating plan. Pure and unit-tested.
 * @param {{relVol:number, atrPct5m:number, atrPct1h:number, mom1hPct:number}} m
 *   relVol   — last closed 1m volume ÷ prior average (NaN = unknown)
 *   atrPct5m — ATR(14) on 5m ÷ price; atrPct1h — same on 1h
 *   mom1hPct — (close − close[3 bars ago]) ÷ close[3 bars ago] on 1h
 * @returns {{tf:string, capMin:number, cooldownMin:number, regime:string}}
 */
export function pickPlan(m = {}) {
  const relVol = Number(m.relVol)
  const atr5 = Number(m.atrPct5m) || 0
  const atr1h = Number(m.atrPct1h) || 0
  const mom = Math.abs(Number(m.mom1hPct) || 0)
  // Hot tape: volume well above average AND the 5m bars actually move —
  // micro scalps, fastest recycle.
  if (relVol >= 1.5 && atr5 >= 0.0004) return { tf: '5m', capMin: 12, cooldownMin: 20, regime: 'hot' }
  // Active tape: above-average volume — short intraday swings.
  if (relVol >= 1.0) return { tf: '15m', capMin: 30, cooldownMin: 30, regime: 'active' }
  // Quiet volume but the hour is trending or wide — ride the hour.
  if (mom >= 0.001 || atr1h >= 0.002) return { tf: '1h', capMin: 120, cooldownMin: 60, regime: 'trending' }
  // Dead drift — middle timeframe, longest cooldown.
  return { tf: '30m', capMin: 45, cooldownMin: 90, regime: 'quiet' }
}

/**
 * Pace controller toward targetTrades within the window. Pure and tested.
 * deficit = trades the linear schedule says should already be done − actual.
 * @returns {{maxPerCycle:number, cooldownScale:number, expected:number}}
 */
export function pacePlan({ targetTrades, windowMs, elapsedMs, completed, baseMaxPerCycle }) {
  const base = Math.max(1, Number(baseMaxPerCycle) || 4)
  if (!targetTrades || !windowMs || !(elapsedMs >= 0)) return { maxPerCycle: base, cooldownScale: 1, expected: 0 }
  const expected = Math.round(targetTrades * Math.min(1, elapsedMs / windowMs))
  const deficit = expected - (Number(completed) || 0)
  if (deficit >= 20) return { maxPerCycle: Math.min(8, base + 3), cooldownScale: 0.4, expected }
  if (deficit >= 8) return { maxPerCycle: Math.min(8, base + 2), cooldownScale: 0.6, expected }
  if (deficit >= 3) return { maxPerCycle: Math.min(8, base + 1), cooldownScale: 0.8, expected }
  if (deficit <= -10) return { maxPerCycle: Math.max(1, base - 2), cooldownScale: 1.5, expected }
  return { maxPerCycle: base, cooldownScale: 1, expected }
}

function log(...args) {
  console.log('[burn-in]', ...args)
}

const PLAN_TFS = ['1m', '5m', '15m', '30m', '1h']

/**
 * One burn-in pass. Deps injectable for tests:
 * { autoTrade, wsGetTrendbarsBatch, risk, now }.
 */
export async function runBurnIn(db, creds, deps = {}) {
  const cfg = loadBurnInConfig(db)
  if (!cfg.on) return { skipped: 'off', attempted: 0, placed: 0 }
  if (getState(db, 'autotrade_enabled') !== 'true') return { skipped: 'autotrade off', attempted: 0, placed: 0 }
  if (!creds?.ready) return { skipped: 'no creds', attempted: 0, placed: 0 }

  const autoTrade = deps.autoTrade ?? (await import('../loop.js')).autoTrade
  const wsGetTrendbarsBatch = deps.wsGetTrendbarsBatch ?? (await import('../lib/ctrader-ws.js')).wsGetTrendbarsBatch
  const now = deps.now ?? (() => Date.now())

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

  // Pace toward the target: completed burn-in round-trips since arming.
  const startedMs = cfg.startedAt ? Date.parse(cfg.startedAt) : NaN
  const completed = cfg.startedAt
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE label_strategy = 'burnin' AND status = 'closed' AND closed_at >= ?`
      ).get(cfg.startedAt).n
    : 0
  const pace = pacePlan({
    targetTrades: cfg.targetTrades,
    windowMs: cfg.windowDays * 86_400_000,
    elapsedMs: Number.isFinite(startedMs) ? Math.max(0, now() - startedMs) : 0,
    completed,
    baseMaxPerCycle: cfg.maxPerCycle,
  })

  let last = {}
  try { last = JSON.parse(getState(db, 'burn_in_last_json') || '{}') || {} } catch { last = {} }

  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}

  // Candidates: MARKET OPEN (a closed exchange must not produce a veto row
  // every cycle — owner saw CORN/COCOA flooding the Order log), no open
  // position, mapped, and (volume-scaled) cooled off. The exact cooldown is
  // plan-dependent, so pre-filter with the SHORTEST possible cooldown and
  // re-check per symbol after the plan is known.
  // Market-open gate: broker-truth schedule (symbol_hours) with the
  // sessions.js heuristic as fallback; tests may inject their own.
  let isOpen = deps.isSymbolMarketOpen
  if (!isOpen) {
    const { isSymbolOpenCached } = await import('./symbol-hours.js')
    isOpen = (s) => isSymbolOpenCached(db, s)
  }
  const minCooldownMs = 20 * 60_000 * pace.cooldownScale
  const queue = watch
    .filter(s => !open.has(s) && symbolMap[String(s).toUpperCase()])
    .filter(s => isOpen(s).open)
    .filter(s => now() - (Number(last[s]) || 0) >= minCooldownMs)
    .slice(0, pace.maxPerCycle * 2) // headroom: plan cooldowns may drop some

  if (queue.length === 0) {
    return { skipped: 'nothing due', attempted: 0, placed: 0, completed, expected: pace.expected }
  }

  let minSlPct = 0.0015
  try {
    const { loadRiskConfig } = deps.risk ?? await import('./risk.js')
    minSlPct = Number(loadRiskConfig(db).minSLDistancePct) || minSlPct
  } catch { /* default floor */ }

  let attempted = 0
  let placed = 0
  const notes = []
  for (const symbol of queue) {
    if (placed >= pace.maxPerCycle) break
    try {
      const symbolId = symbolMap[String(symbol).toUpperCase()]
      const byTf = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, PLAN_TFS, 40, 20_000)
      const closed = (tf) => (byTf[tf] || []).slice(0, -1)
      const bars1h = closed('1h')
      const bars5m = closed('5m')
      if (bars1h.length < 16 || bars5m.length < 16) { notes.push(`${symbol}: thin bars`); continue }
      const px1h = bars1h[bars1h.length - 1].c

      // Market read → plan.
      const relVol = relVolFromBars(byTf['1m'] || [])
      const atrPct5m = (atrFromBars(bars5m, 14) || 0) / (bars5m[bars5m.length - 1].c || 1)
      const atrPct1h = (atrFromBars(bars1h, 14) || 0) / (px1h || 1)
      const mom1hPct = bars1h.length >= 4 ? (px1h - bars1h[bars1h.length - 4].c) / bars1h[bars1h.length - 4].c : 0
      const plan = pickPlan({ relVol, atrPct5m, atrPct1h, mom1hPct })

      // Plan-specific (volume-scaled) cooldown re-check.
      const cooldownMs = plan.cooldownMin * 60_000 * pace.cooldownScale
      if (now() - (Number(last[symbol]) || 0) < cooldownMs) continue
      attempted++
      last[symbol] = now()

      const bars = closed(plan.tf)
      if (bars.length < 16) { notes.push(`${symbol}: thin ${plan.tf} bars`); continue }
      const lastBar = bars[bars.length - 1]
      const refBar = bars[bars.length - 4] || bars[bars.length - 2]
      const entry = lastBar.c
      const bias = lastBar.c >= refBar.c ? 'long' : 'short'
      const dir = bias === 'long' ? 1 : -1
      const atr = atrFromBars(bars, 14)
      const slDist = Math.max(atr || 0, entry * minSlPct * 1.2)
      if (!(slDist > 0)) { notes.push(`${symbol}: no volatility read`); continue }

      const synth = {
        consensus_bias: bias,
        entry,
        sl: entry - dir * slDist,
        tp1: entry + dir * slDist * 1.6, // RR 1.6 clears the minRR 1.5 gate
        strategy: 'burnin',
        overall_conviction: 8,
        timeframe: plan.tf,
        time_cap_minutes: plan.capMin,
        synthesis: `BURN-IN micro-quant — ${plan.regime} tape (relVol ${Number.isFinite(relVol) ? relVol.toFixed(2) : '?'}): ${plan.tf} ${bias}, 1×ATR stop, closes in ≤${plan.capMin}m.`,
        invalidation_trigger: null,
        source: 'burnin',
      }
      const result = await autoTrade(db, symbol, synth, { maxVolume: cfg.lots }, null)
      if (result) {
        placed++
        log(`${symbol}: ${result.side} ${cfg.lots} [${plan.regime}/${plan.tf}] cap ${plan.capMin}m (pace ${completed}/${pace.expected} of ${cfg.targetTrades})`)
      }
    } catch (err) {
      notes.push(`${symbol}: ${err.message}`)
      log(`${symbol}: failed — ${err.message}`)
    }
  }
  setState(db, 'burn_in_last_json', JSON.stringify(last))
  return {
    attempted,
    placed,
    completed,
    expected: pace.expected,
    maxPerCycle: pace.maxPerCycle,
    notes,
    summary: `attempted=${attempted} placed=${placed} pace=${completed}/${pace.expected} of ${cfg.targetTrades} mpc=${pace.maxPerCycle}${notes.length ? ` notes=${notes.slice(0, 4).join(' · ')}` : ''}`,
  }
}
