// ---------------------------------------------------------------------------
// agent/services/risk.js — Pre-trade Risk Manager
// ---------------------------------------------------------------------------
// Pure deterministic gate that runs between Analyst `auto_trade: true` and
// cTrader. Enforces daily loss limit, consecutive-loss cooldown, open-position
// cap, R:R floor, SL distance floor, currency-exposure cap, instrument-tier
// gating, equity-aware per-trade sizing, and Kelly scaling.
// NO LLM calls — this is auditable and must never depend on model output.
// ---------------------------------------------------------------------------
// Equity-aware mode: when `account_balance_usd` is set in agent_state, the
// daily loss limit is derived from `dailyLossPct` and position size is derived
// from `perTradeRiskPct` × balance ÷ USD-per-lot. When balance is unset we
// fall back to the absolute `dailyLossLimit` and honour `requestedVolume`.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { usdLossPerLot, tierForBalance, notionalUsd } from '../lib/contracts.js'
import { correlationVeto } from './correlation.js'
import { liveCorrelationVeto, loadStoredMatrix, loadCorrelationMatrixConfig } from './correlation-matrix.js'
import { minRrFor } from './strategies.js'

export const DEFAULT_RISK_CONFIG = {
  dailyLossLimit: 300,             // USD. Absolute fallback when balance unset.
  dailyLossPct: 0.03,              // 3% of balance — preferred when balance set.
  // Per-trade risk (owner: "push default risk to 5% or absolute amount").
  // Size AGGRESSIVELY on the now-proven combos, with an ALGO HARD CAP as the
  // safety layer. The effective $ budget per trade is:
  //   base    = perTradeRiskUsd (if > 0) else balance × perTradeRiskPct
  //   ceiling = min(balance × maxRiskCapPct, maxRiskUsd?)
  //   budget  = min(base, ceiling) × drawdown-de-risk factor
  perTradeRiskPct: 0.05,           // 5% of balance per trade (aggressive)
  perTradeRiskUsd: null,           // absolute $ risk/trade; when > 0, overrides the pct
  maxRiskCapPct: 0.05,             // hard ceiling — never risk more than this % of balance
  maxRiskUsd: null,                // optional absolute $ ceiling per trade
  // Anti-tilt: when realized PnL over the last window is down more than
  // deriskTriggerPct of balance, scale the budget by deriskMult — a losing run
  // sizes DOWN automatically instead of compounding at 5%.
  deriskOnDrawdown: true,
  deriskWindowHours: 24,
  deriskTriggerPct: 0.05,          // down >5% in the window → de-risk
  deriskMult: 0.5,                 // …to half size until it recovers
  minLotSize: 0.01,                // Broker minimum lot size.
  maxConsecutiveLosses: 3,         // After N losses in a row → cooldown.
  cooldownMinutes: 60,             // Cool-off window after hitting the streak.
  symbolCooldownMinutes: 240,      // Per-symbol lock after ANY closed trade on
                                   // that symbol (freqtrade "CooldownPeriod").
                                   // Stops instant re-entry into the same
                                   // broken level after a stop-out.
  maxOpenPositions: 5,             // Hard cap on concurrent positions.
  equityStopPct: null,             // Daily-drawdown EQUITY STOP: when today's
                                   // realized PnL breaches -(balance × pct),
                                   // the loop closes every open bot position
                                   // and disarms autotrade (the dailyLossPct
                                   // veto only blocks NEW trades). null =
                                   // same threshold as dailyLossPct.
  minRR: 1.5,                      // TP must be ≥ minRR × SL distance.
  minSLDistancePct: 0.15,          // SL must be ≥ this % from entry (stops too
                                   // tight get swept by noise).
  maxSpreadFracOfSL: 0.25,         // Microstructure gate: the live bid/ask
                                   // spread is a cost paid at entry. If it
                                   // exceeds this fraction of the SL distance,
                                   // the R:R the signal was approved on is
                                   // fiction — veto (doc_reference/
                                   // microstructure-frequent-trading-notes.md).
                                   // 0 disables the check.
  maxCurrencyExposure: 2,          // Net long/short exposure to any one ccy.
  maxClusterExposure: 2,           // Net directional exposure to any one
                                   // correlation cluster (gold/USD, US
                                   // equity, crude…). 0 disables the check.
  minTradesForKelly: 30,           // Below this → use default volume.
  kellyFraction: 0.25,             // Quarter-Kelly for drawdown control.
  allowNegativeExpectancyOverride: false, // If false, negative expectancy vetoes.
  // Account leverage (e.g. 200 = 1:200). Used to check margin headroom so the
  // risk manager doesn't approve a position that eats your available margin.
  // Override via POST /actions/balance { leverage: 500 }.
  leverage: 100,
  maxMarginUsagePct: 0.5,          // Max % of balance locked in margin.
  // Instrument universe: empty = everything allowed. Put symbols here to veto
  // them regardless of balance (e.g. ["BTCUSD"] to temporarily disable crypto).
  // Tier is just a label for the dashboard — the real equity gate is
  // `insufficient_equity` below, which vetoes when the risk budget cannot
  // support 0.01 lot on the proposed SL distance.
  blockedSymbols: [],
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

/**
 * Read the configured account balance (USD) from agent_state, or null when
 * unset. Any non-positive or malformed value is treated as unset.
 */
export function getAccountBalance(db) {
  const raw = getState(db, 'account_balance_usd')
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * Read the configured account leverage (e.g. 200 → 1:200). Falls back to the
 * config default when unset or malformed. Leverage ≤0 is ignored.
 */
export function getAccountLeverage(db, config) {
  const raw = getState(db, 'account_leverage')
  if (raw == null) return config.leverage
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return config.leverage
  return n
}

/**
 * Compute margin required for a proposed position (in the account's deposit
 * currency, approximated as USD). Returns { notional, marginRequired }.
 */
export function requiredMargin(symbol, volumeLots, price, leverage, rates = null) {
  const notional = notionalUsd(symbol, volumeLots, price, rates)
  const marginRequired = notional / Math.max(1, leverage)
  return { notional, marginRequired }
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
// Equity-aware sizing
// ---------------------------------------------------------------------------

/**
 * Compute the lot size that risks `perTradeRiskPct` of the account balance
 * given the SL distance for this symbol.
 *
 * volume = (balance × riskPct) ÷ (slDistance × contractSize)
 *
 * Returns { volume, usdRisk, note }. `volume` is rounded down to 2dp; callers
 * should veto if it falls below the minimum lot size.
 */
export function computeRiskBasedVolume(balance, symbol, slDistance, riskPct, entryPrice, rates = null) {
  const budget = balance * riskPct
  const usdPerLot = usdLossPerLot(symbol, slDistance, entryPrice, rates)
  if (!Number.isFinite(usdPerLot) || usdPerLot <= 0) {
    return { volume: 0, usdRisk: 0, note: 'usd_per_lot_unknown' }
  }
  const raw = budget / usdPerLot
  // Round down to 2dp so we never exceed the risk budget.
  const volume = Math.floor(raw * 100) / 100
  const usdRisk = volume * usdPerLot
  return {
    volume,
    usdRisk: Number(usdRisk.toFixed(2)),
    note: `risk_budget=$${budget.toFixed(2)} usd_per_lot=$${usdPerLot.toFixed(2)}`,
  }
}

/**
 * The effective $ risk budget for one trade after the algo layers: absolute-$
 * override → pct, capped by the hard ceiling(s), scaled by the drawdown
 * de-risk factor. Pure.
 */
export function riskBudgetUsd(balance, cfg, ddFactor = 1) {
  if (!(balance > 0)) return 0
  const base = Number(cfg.perTradeRiskUsd) > 0 ? Number(cfg.perTradeRiskUsd) : balance * (cfg.perTradeRiskPct ?? 0)
  const ceilings = [balance * (Number.isFinite(cfg.maxRiskCapPct) ? cfg.maxRiskCapPct : Infinity)]
  if (Number(cfg.maxRiskUsd) > 0) ceilings.push(Number(cfg.maxRiskUsd))
  const capped = Math.min(base, ...ceilings)
  const f = Number.isFinite(ddFactor) ? ddFactor : 1
  return Math.max(0, capped * f)
}

/**
 * Anti-tilt de-risk multiplier: 1 normally, or cfg.deriskMult when realized net
 * PnL over the last cfg.deriskWindowHours is worse than −(balance × trigger).
 */
export function drawdownDeriskFactor(db, balance, cfg) {
  if (!cfg?.deriskOnDrawdown || !(balance > 0)) return 1
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND closed_at >= datetime('now', ?)`
    ).get(`-${Math.max(1, Math.round(cfg.deriskWindowHours || 24))} hours`)
    const pnl = row?.pnl ?? 0
    return pnl <= -(balance * (cfg.deriskTriggerPct ?? 1)) ? (cfg.deriskMult ?? 1) : 1
  } catch { return 1 }
}

/**
 * Live conversion table from the scan's freshest closes: { SYMBOL: price }.
 * The USD majors on the watchlist double as cross-pair conversion rates
 * (GBPUSD → GBP→USD, USDJPY → JPY→USD …). Empty when no scan has run yet —
 * crosses then veto honestly until the first scan lands (≤5 minutes).
 */
export function scanRates(db) {
  try {
    const parsed = JSON.parse(getState(db, 'last_scan_results') || 'null')
    const rates = {}
    for (const sc of parsed?.scans || []) {
      const p = Number(sc?.price)
      if (Number.isFinite(p) && p > 0 && sc?.symbol) rates[String(sc.symbol).toUpperCase()] = p
    }
    return rates
  } catch { return {} }
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
  const balance = getAccountBalance(db)
  const leverage = getAccountLeverage(db, config)
  const checks = { balance, leverage }

  // ---- 1. Daily loss limit ------------------------------------------------
  // Prefer % of balance when set; fall back to absolute USD cap.
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
  const effectiveDailyCap = balance != null
    ? balance * config.dailyLossPct
    : config.dailyLossLimit
  checks.daily_cap_usd = Number(effectiveDailyCap.toFixed(2))
  if (todayPnl <= -Math.abs(effectiveDailyCap)) {
    return veto(
      `daily_loss_limit_hit pnl=${todayPnl.toFixed(2)} limit=${effectiveDailyCap.toFixed(2)}`,
      checks, proposal,
    )
  }

  // ---- 2. Consecutive-loss cooldown --------------------------------------
  // maxConsecutiveLosses 0 = breaker OFF (owner 2026-07-17: "cooldown pause
  // is for humans"). The daily loss cap remains the hard machine backstop.
  const streakLimit = Number(config.maxConsecutiveLosses) || 0
  const recentClosed = streakLimit > 0
    ? db
        .prepare(
          `SELECT net_pnl, closed_at FROM trades
           WHERE status = 'closed' AND closed_at IS NOT NULL
           ORDER BY closed_at DESC LIMIT ?`
        )
        .all(streakLimit)
    : []
  let streak = 0
  for (const t of recentClosed) {
    if ((t.net_pnl || 0) < 0) streak++
    else break
  }
  checks.loss_streak = streak
  if (streakLimit > 0 && streak >= streakLimit) {
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
    .prepare(`
      SELECT mp.symbol, mp.side, mp.entry_price, mp.strategy AS strategy,
             mp.last_check_action AS lastCheckAction, mp.last_check_at AS lastCheckAt,
             t.opened_at, COALESCE(t.label_strategy, t.strategy) AS tradeStrategy
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.status = 'active'
    `)
    .all()
  checks.open_positions = openPositions.length
  if (openPositions.length >= config.maxOpenPositions) {
    return veto(`max_positions=${openPositions.length}/${config.maxOpenPositions}`, checks, proposal)
  }

  // ---- 4. No duplicate on same symbol ------------------------------------
  const existingSameSymbol = openPositions.find(p => p.symbol === proposal.symbol)
  if (existingSameSymbol) {
    // Owner: "show evidence of your veto ... what was the last strategy used
    // to open-trade, and why you veto." The veto now names the actual
    // blocking position — side, entry, WHICH STRATEGY opened it, when — so a
    // repeated veto is a full audit line, not an unexplained no. All fields
    // parse back out in src/lib/veto-words.js; the leading `existing_side=`
    // stays first for back-compat with anything matching on it alone.
    const stratOf = existingSameSymbol.strategy || existingSameSymbol.tradeStrategy || 'na'
    return veto(
      `duplicate_symbol existing_side=${existingSameSymbol.side} entry=${existingSameSymbol.entry_price ?? 'na'} opened=${existingSameSymbol.opened_at ?? 'na'} strat=${stratOf} lastcheck=${existingSameSymbol.lastCheckAt ?? 'na'}`,
      checks, proposal,
    )
  }

  // ---- 4b. Per-symbol re-entry cooldown -----------------------------------
  // A signal zone persists after knocking us out, so without this the very
  // next loop re-enters the same broken level. Locks the symbol for
  // symbolCooldownMinutes after its most recent closed trade.
  if (config.symbolCooldownMinutes > 0) {
    const lastClosed = db
      .prepare(
        `SELECT closed_at FROM trades
         WHERE status = 'closed' AND symbol = ? AND closed_at IS NOT NULL
         ORDER BY closed_at DESC LIMIT 1`
      )
      .get(proposal.symbol)
    if (lastClosed?.closed_at) {
      const unlockAt = new Date(lastClosed.closed_at).getTime() + config.symbolCooldownMinutes * 60_000
      if (unlockAt > Date.now()) {
        const mins = Math.ceil((unlockAt - Date.now()) / 60_000)
        checks.symbol_cooldown_wait = mins
        return veto(`symbol_cooldown wait=${mins}m`, checks, proposal)
      }
    }
  }

  // ---- 5. Blocked-symbol gate (opt-in per-config) -------------------------
  // No hardcoded instrument universe — you get whatever your balance supports
  // on 0.01 lot (enforced by the `insufficient_equity` check below). The tier
  // label is still attached for dashboard context.
  if (balance != null) {
    checks.tier = tierForBalance(balance).name
  }
  const blocked = Array.isArray(config.blockedSymbols) ? config.blockedSymbols : []
  if (blocked.some(s => String(s).toUpperCase() === proposal.symbol.toUpperCase())) {
    return veto(`symbol_blocked ${proposal.symbol}`, checks, proposal)
  }

  // ---- 6. R:R floor -------------------------------------------------------
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
      // Per-strategy floor: a high-win-rate mean-reversion strategy runs a
      // small R:R on purpose, so it declares a lower floor than the global 1.5.
      const rrFloor = minRrFor(proposal.strategy, config.minRR)
      if (rr < rrFloor) {
        return veto(`bad_rr ${rr.toFixed(2)}<${rrFloor}`, checks, proposal)
      }
    }
  }

  // ---- 7. SL distance floor (as % of entry) -------------------------------
  const slPct = (slDistance / Math.abs(entry)) * 100
  checks.sl_pct = Number(slPct.toFixed(3))
  if (slPct < config.minSLDistancePct) {
    return veto(`sl_too_tight ${slPct.toFixed(3)}%<${config.minSLDistancePct}%`, checks, proposal)
  }

  // ---- 8. Currency-exposure cap ------------------------------------------
  const exposure = netExposure(openPositions, proposal)
  checks.exposure = exposure
  for (const [ccy, v] of Object.entries(exposure)) {
    if (Math.abs(v) > config.maxCurrencyExposure) {
      return veto(`overexposed_${ccy}=${v}`, checks, proposal)
    }
  }

  // ---- 8b. Correlation cap -----------------------------------------------
  // Owner: "did you check pair and correlation?" Currency exposure only
  // catches SHARED currency legs; this catches instruments that move
  // together WITHOUT one (gold vs USDJPY, WTI vs Brent, US indices).
  //
  // Two layers: the LIVE-computed matrix (owner: "I want the live-computed
  // version") is preferred when fresh — it counts how many held positions
  // are highly correlated with the proposal in the same directional-risk
  // sense and vetoes the (maxCorrelated+1)th stacked bet. The curated
  // ±1-beta clusters are the always-on floor for when the matrix is
  // missing/stale (fresh boot, a symbol not yet in it).
  const liveCfg = loadCorrelationMatrixConfig(db)
  if (liveCfg.on) {
    const live = liveCorrelationVeto(openPositions, proposal, loadStoredMatrix(db), liveCfg, Date.now())
    if (live) {
      checks.correlation = live
      return veto(`correlated_live=${live.stacked.length} thr=${live.threshold} with=${live.stacked.map(s => `${s.symbol}@${s.corr}`).join('|')}`, checks, proposal)
    }
  }
  if (config.maxClusterExposure > 0) {
    const corr = correlationVeto(openPositions, proposal, config.maxClusterExposure)
    if (corr) {
      checks.correlation = corr
      return veto(`correlated_${corr.cluster}=${corr.net} cap=${corr.cap} with=${corr.others.join('|') || 'none'}`, checks, proposal)
    }
  }

  // ---- 9. Equity-aware position sizing -----------------------------------
  // When balance is known, derive the lot size from the per-trade risk
  // budget; veto when even the minimum lot size would exceed that budget.
  // requestedVolume is an OPTIONAL per-symbol cap (watchlist "Max lots"):
  // absent/null means UNCAPPED — the dynamic risk-based size IS the size
  // (owner 2026-07-17: the old hardcoded 0.01 fallback was silently
  // compressing every trade below the configured risk budget). Without a
  // balance the risk formula can't run, so no-cap falls back to minLotSize.
  const reqVol = Number(proposal.requestedVolume)
  const hasCap = Number.isFinite(reqVol) && reqVol > 0
  let sizingFloor = hasCap ? reqVol : config.minLotSize
  let sizingNote = null
  if (balance != null) {
    // Live rates for cross-pair sizing (GBPJPY loss is in JPY; convert via
    // USDJPY from the scan's freshest closes) — the whole watchlist of USD
    // majors doubles as the conversion table.
    // Algo-capped, drawdown-aware budget → effective risk fraction for sizing.
    const ddFactor = drawdownDeriskFactor(db, balance, config)
    const budget = riskBudgetUsd(balance, config, ddFactor)
    const effRiskPct = budget / balance
    const risked = computeRiskBasedVolume(balance, proposal.symbol, slDistance, effRiskPct, entry, scanRates(db))
    checks.risk_budget = Number(budget.toFixed(2))
    checks.risk_pct_effective = Number(effRiskPct.toFixed(4))
    if (ddFactor < 1) checks.derisked = { factor: ddFactor, window_h: config.deriskWindowHours }
    checks.risk_based_volume = risked.volume
    checks.risk_based_usd = risked.usdRisk
    if (risked.volume < config.minLotSize) {
      return veto(
        `insufficient_equity min_lot=${config.minLotSize} computed=${risked.volume} ${risked.note}`,
        checks, proposal,
      )
    }
    // Risk-based size, reduced by the per-symbol cap only when one is set.
    sizingFloor = hasCap ? Math.min(risked.volume, reqVol) : risked.volume
    sizingNote = hasCap && reqVol < risked.volume ? `${risked.note} · capped_at_max_lots=${reqVol}` : risked.note
  }

  // ---- 10. Kelly sizing --------------------------------------------------
  const latestStats = db
    .prepare(`SELECT * FROM performance_snapshots ORDER BY computed_at DESC LIMIT 1`)
    .get()
  const { volume: kellyVol, note: kellyNote } = kellyVolume(
    latestStats,
    sizingFloor,
    config
  )
  checks.kelly_volume = kellyVol
  if (kellyVol === 0 && !config.allowNegativeExpectancyOverride) {
    return veto(`negative_expectancy ${kellyNote}`, checks, proposal)
  }
  // Never ship below broker minimum.
  const finalVolume = Math.max(config.minLotSize, kellyVol || sizingFloor)

  // ---- 11. Margin-headroom gate ------------------------------------------
  // Ensure the position (plus existing open positions' margin) doesn't exceed
  // `maxMarginUsagePct` of balance. Only enforced when balance is set.
  if (balance != null) {
    const { notional, marginRequired } = requiredMargin(
      proposal.symbol, finalVolume, entry, leverage, scanRates(db),
    )
    checks.notional_usd = Number(notional.toFixed(2))
    checks.margin_required_usd = Number(marginRequired.toFixed(2))
    const marginCap = balance * config.maxMarginUsagePct
    checks.margin_cap_usd = Number(marginCap.toFixed(2))
    if (marginRequired > marginCap) {
      return veto(
        `insufficient_margin required=${marginRequired.toFixed(2)} cap=${marginCap.toFixed(2)} leverage=${leverage}`,
        checks, proposal,
      )
    }
  }

  const combinedNote = sizingNote ? `${sizingNote} · ${kellyNote}` : kellyNote
  return {
    approved: true,
    adjusted_volume: finalVolume,
    sizing_note: combinedNote,
    checks,
  }
}

function veto(reason, checks) {
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
