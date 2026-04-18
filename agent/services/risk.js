// ---------------------------------------------------------------------------
// agent/services/risk.js — Pre-trade Risk Manager
// ---------------------------------------------------------------------------
// Pure deterministic gate that runs between Analyst `auto_trade: true` and
// cTrader. Enforces daily loss limit, consecutive-loss cooldown, open-position
// cap, R:R floor, SL distance floor, currency-exposure cap, and Kelly sizing.
// NO LLM calls — this is auditable and must never depend on model output.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DEFAULT_RISK_CONFIG = {
  dailyLossLimit: 300,             // USD. Absolute realised loss today triggers kill.
  maxConsecutiveLosses: 3,         // After N losses in a row → cooldown.
  cooldownMinutes: 60,             // Cool-off window after hitting the streak.
  maxOpenPositions: 5,             // Hard cap on concurrent positions.
  minRR: 1.5,                      // TP must be ≥ minRR × SL distance.
  minSLDistancePct: 0.15,          // SL must be ≥ this % from entry (stops too
                                   // tight get swept by noise).
  maxCurrencyExposure: 2,          // Net long/short exposure to any one ccy.
  minTradesForKelly: 30,           // Below this → use default volume.
  kellyFraction: 0.25,             // Quarter-Kelly for drawdown control.
  allowNegativeExpectancyOverride: false, // If false, negative expectancy vetoes.
}

/**
 * Load risk config from agent_state JSON, merging over DEFAULT_RISK_CONFIG.
 */
export function loadRiskConfig(db) {
  const raw = getState(db, 'risk_config_json')
  if (!raw) return { ...DEFAULT_RISK_CONFIG }
  try {
    return { ...DEFAULT_RISK_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_RISK_CONFIG }
  }
}

// ---------------------------------------------------------------------------
// Currency-exposure helpers
// ---------------------------------------------------------------------------

/**
 * Decompose a trade into per-currency legs.
 *   EURUSD long  → { EUR: +1, USD: -1 }
 *   XAUUSD short → { XAU: -1, USD: +1 }
 *   US30 long    → { US30: +1 }  (indices treated as single unit)
 */
export function currencyLegs(symbol, side) {
  const sym = (symbol || '').toUpperCase()
  const isLong = side === 'long' || side === 'BUY' || side === 'buy'
  const sign = isLong ? 1 : -1

  // FX pairs and metals vs USD — 6-char code, split 3+3
  if (sym.length === 6 && /^[A-Z]{6}$/.test(sym)) {
    return { [sym.slice(0, 3)]: sign, [sym.slice(3, 6)]: -sign }
  }
  // Everything else (indices, commodities, single-name) — treat as one leg
  return { [sym]: sign }
}

/**
 * Net per-currency exposure across positions + a proposed trade.
 */
export function netExposure(positions, proposal) {
  const exposure = {}
  const add = (legs) => {
    for (const [k, v] of Object.entries(legs)) {
      exposure[k] = (exposure[k] || 0) + v
    }
  }
  for (const p of positions) add(currencyLegs(p.symbol, p.side))
  if (proposal) add(currencyLegs(proposal.symbol, proposal.side))
  return exposure
}

// ---------------------------------------------------------------------------
// Kelly sizing
// ---------------------------------------------------------------------------

/**
 * Compute a Kelly-scaled volume. Returns the volume to use, or 0 if
 * expectancy is negative or inputs are invalid.
 */
export function kellyVolume(stats, defaultVolume, config) {
  if (!stats || !stats.total_trades || stats.total_trades < config.minTradesForKelly) {
    return { volume: defaultVolume, note: `kelly_skipped_sample=${stats?.total_trades || 0}` }
  }
  const winRate = stats.win_rate || 0
  const avgWin = Math.abs(stats.avg_win || 0)
  const avgLoss = Math.abs(stats.avg_loss || 0)
  if (avgLoss === 0 || winRate <= 0) {
    return { volume: defaultVolume, note: 'kelly_unstable_inputs' }
  }
  const b = avgWin / avgLoss
  const kelly = winRate - (1 - winRate) / b
  if (kelly <= 0) {
    return { volume: 0, note: `kelly_negative=${kelly.toFixed(3)}` }
  }
  const scale = Math.min(1, kelly * config.kellyFraction * 4)
  const scaled = Math.max(0.01, Math.round(defaultVolume * scale * 100) / 100)
  return { volume: scaled, note: `kelly=${kelly.toFixed(3)} scale=${scale.toFixed(2)}` }
}

// ---------------------------------------------------------------------------
// Main gate
// ---------------------------------------------------------------------------

/**
 * Evaluate a proposed trade against all risk rules.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{symbol:string, side:string, entry:number, sl:number, tp1?:number,
 *          requestedVolume:number, strategy?:string, conviction?:number}} proposal
 * @param {object} [configOverride] — optional config, defaults to loadRiskConfig(db)
 * @returns {{approved:boolean, veto_reason?:string, adjusted_volume:number,
 *           checks:object, sizing_note?:string}}
 */
export function evaluateTrade(db, proposal, configOverride) {
  const config = configOverride || loadRiskConfig(db)
  const checks = {}

  // ---- 1. Daily loss limit ------------------------------------------------
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayStartISO = dayStart.toISOString()
  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
       WHERE status = 'closed' AND closed_at >= ?`
    )
    .get(dayStartISO)
  const todayPnl = todayRow?.pnl || 0
  checks.daily_pnl = todayPnl
  if (todayPnl <= -Math.abs(config.dailyLossLimit)) {
    return veto(`daily_loss_limit_hit pnl=${todayPnl.toFixed(2)} limit=${config.dailyLossLimit}`, checks, proposal)
  }

  // ---- 2. Consecutive-loss cooldown --------------------------------------
  const recentClosed = db
    .prepare(
      `SELECT net_pnl, closed_at FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT ?`
    )
    .all(config.maxConsecutiveLosses)
  let streak = 0
  for (const t of recentClosed) {
    if ((t.net_pnl || 0) < 0) streak++
    else break
  }
  checks.loss_streak = streak
  if (streak >= config.maxConsecutiveLosses) {
    const lastCloseAt = recentClosed[0]?.closed_at
    const cooldownEndsAt = lastCloseAt
      ? new Date(new Date(lastCloseAt).getTime() + config.cooldownMinutes * 60_000)
      : null
    if (cooldownEndsAt && cooldownEndsAt > new Date()) {
      const mins = Math.ceil((cooldownEndsAt - new Date()) / 60_000)
      return veto(`loss_streak_cooldown streak=${streak} wait=${mins}m`, checks, proposal)
    }
  }

  // ---- 3. Max open positions ---------------------------------------------
  const openPositions = db
    .prepare(`SELECT symbol, side FROM monitored_positions WHERE status = 'active'`)
    .all()
  checks.open_positions = openPositions.length
  if (openPositions.length >= config.maxOpenPositions) {
    return veto(`max_positions=${openPositions.length}/${config.maxOpenPositions}`, checks, proposal)
  }

  // ---- 4. No duplicate on same symbol ------------------------------------
  const existingSameSymbol = openPositions.find(p => p.symbol === proposal.symbol)
  if (existingSameSymbol) {
    return veto(`duplicate_symbol existing_side=${existingSameSymbol.side}`, checks, proposal)
  }

  // ---- 5. R:R floor -------------------------------------------------------
  if (proposal.entry == null || proposal.sl == null) {
    return veto('missing_entry_or_sl', checks, proposal)
  }
  const entry = Number(proposal.entry)
  const sl = Number(proposal.sl)
  if (!Number.isFinite(entry) || !Number.isFinite(sl)) {
    return veto('missing_entry_or_sl', checks, proposal)
  }
  const slDistance = Math.abs(entry - sl)
  checks.sl_distance = slDistance
  if (slDistance === 0) {
    return veto('sl_at_entry', checks, proposal)
  }
  // Round RR to 2 decimals for comparison so "1.50" equals the floor 1.5 —
  // float math produces 1.4999... which would spuriously veto.
  if (proposal.tp1 != null) {
    const tp1 = Number(proposal.tp1)
    if (Number.isFinite(tp1)) {
      const tpDistance = Math.abs(tp1 - entry)
      const rr = Math.round((tpDistance / slDistance) * 100) / 100
      checks.rr = rr
      if (rr < config.minRR) {
        return veto(`bad_rr ${rr.toFixed(2)}<${config.minRR}`, checks, proposal)
      }
    }
  }

  // ---- 6. SL distance floor (as % of entry) -------------------------------
  const slPct = (slDistance / Math.abs(entry)) * 100
  checks.sl_pct = Number(slPct.toFixed(3))
  if (slPct < config.minSLDistancePct) {
    return veto(`sl_too_tight ${slPct.toFixed(3)}%<${config.minSLDistancePct}%`, checks, proposal)
  }

  // ---- 7. Currency-exposure cap ------------------------------------------
  const exposure = netExposure(openPositions, proposal)
  checks.exposure = exposure
  for (const [ccy, v] of Object.entries(exposure)) {
    if (Math.abs(v) > config.maxCurrencyExposure) {
      return veto(`overexposed_${ccy}=${v}`, checks, proposal)
    }
  }

  // ---- 8. Kelly sizing ----------------------------------------------------
  const latestStats = db
    .prepare(`SELECT * FROM performance_snapshots ORDER BY computed_at DESC LIMIT 1`)
    .get()
  const { volume: kellyVol, note: sizingNote } = kellyVolume(
    latestStats,
    proposal.requestedVolume,
    config
  )
  checks.kelly_volume = kellyVol
  if (kellyVol === 0 && !config.allowNegativeExpectancyOverride) {
    return veto(`negative_expectancy ${sizingNote}`, checks, proposal)
  }

  return {
    approved: true,
    adjusted_volume: kellyVol || proposal.requestedVolume,
    sizing_note: sizingNote,
    checks,
  }
}

function veto(reason, checks, proposal) {
  return {
    approved: false,
    veto_reason: reason,
    adjusted_volume: 0,
    checks,
  }
}

/**
 * Persist a risk evaluation to the risk_events audit table.
 */
export function persistRiskEvent(db, proposal, result) {
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    proposal.symbol,
    proposal.side,
    result.approved ? 1 : 0,
    result.veto_reason || null,
    JSON.stringify(result.checks || {}),
    JSON.stringify(proposal),
    new Date().toISOString()
  )
}
