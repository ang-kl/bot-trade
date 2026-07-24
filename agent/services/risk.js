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
import { evaluateGlobalGuards } from './global-guards.js'
import { newsWindowEvent, cachedEventsSync } from './news-calendar.js'
import { getSwapInfo } from './symbol-hours.js'

/**
 * Carry-cost check (pure apart from the sync symbol_hours read). Returns
 * null when swap data is unknown (never a block), otherwise
 * { detail, vetoReason? } — vetoReason set when the proposal's side pays a
 * nightly swap below `maxNegative` (broker points per lot per night).
 */
export function evaluateCarryCost(db, proposal, maxNegative) {
  const info = getSwapInfo(db, proposal.symbol)
  if (!info) return null
  const side = String(proposal.side || '')
  const isLong = side === 'long' || side === 'BUY' || side === 'buy'
  const sideSwap = isLong ? info.swapLong : info.swapShort
  if (sideSwap == null || !Number.isFinite(Number(sideSwap))) return null
  const detail = `${isLong ? 'long' : 'short'} swap ${sideSwap} pts/night (limit ${maxNegative})`
  if (Number(sideSwap) < maxNegative) {
    return { detail, vetoReason: `negative_carry: ${isLong ? 'swapLong' : 'swapShort'} ${sideSwap} pts/night < ${maxNegative}` }
  }
  return { detail }
}

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
  minTradesForKelly: 30,           // Below this → use default volume (skip Kelly).
  allowNegativeExpectancyOverride: false, // If false, negative expectancy vetoes.
  // Account leverage (e.g. 200 = 1:200). Used to check margin headroom so the
  // risk manager doesn't approve a position that eats your available margin.
  // Override via POST /actions/balance { leverage: 500 }.
  leverage: 100,
  maxMarginUsagePct: 0.5,          // Max % of balance locked in margin.
  // Broker-side spike protection (owner 2026-07-24): stop trigger method for
  // entry orders' SL. null = broker default (TRADE — touch-triggered, spike-
  // sensitive). 'OPPOSITE' | 'DOUBLE_TRADE' | 'DOUBLE_OPPOSITE' make the
  // broker require the other side of the spread / a confirming quote before
  // firing the stop — the tick-speed remedy for sub-3s wick sweeps.
  stopTriggerMethod: null,
  // News-window entry gate (owner-approved 2026-07-24): veto NEW entries
  // whose symbol's currencies have a scheduled release inside the window —
  // most sub-3s FX spikes are timed prints, and news spreads widen exactly
  // when stops are most touchable. Uses the CACHED calendar only (sync, no
  // network in the trade path); no data = no block. Default OFF.
  newsGateEnabled: false,
  newsGateMinBefore: 15,           // minutes before the release
  newsGateMinAfter: 15,            // minutes after it
  newsGateImpacts: ['High'],       // add 'Medium' to widen coverage
  // Carry-cost gate (approved data-plan item 3): veto NEW entries whose
  // side pays a nightly swap worse than the threshold — swing entries on
  // heavy-negative-carry instruments bleed even when the price thesis is
  // right. Rates come from the broker's own ProtoOASymbol (cached in
  // symbol_hours by the hours refresh, points per lot per night). Unknown
  // swap = no block, never a stuck veto. Default OFF.
  carryGateEnabled: false,
  carryMaxNegativeSwapPoints: null, // e.g. -10 vetoes when the side's swap < −10 pts/night; null = gate stays a no-op even when enabled
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
/**
 * The FX trading day opens at 17:00 America/New_York (owner sign-off
 * 2026-07-24: "move the loss-cap anchor too" — matching the dashboard's
 * FX-day cutoff). DST-aware via Node's tz database: the distance since the
 * last 17:00 NY wall-clock is subtracted from `nowMs`.
 *
 * @param {number} [nowMs]
 * @returns {number} epoch ms of the most recent FX day open
 */
export function fxDayOpenMs(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs))
  const get = (t) => Number(parts.find(p => p.type === t)?.value)
  const min = (get('hour') % 24) * 60 + get('minute')
  const anchorMin = 17 * 60
  const sinceMin = min >= anchorMin ? min - anchorMin : min + 24 * 60 - anchorMin
  return nowMs - sinceMin * 60_000 - get('second') * 1000 - (nowMs % 1000)
}

/**
 * The FX day open as a "YYYY-MM-DD HH:MM:SS" UTC string for closed_at
 * comparisons (the REPLACE(closed_at,'T',' ') form both writers sort
 * correctly against).
 */
export function fxDayStartSql(nowMs = Date.now()) {
  return new Date(fxDayOpenMs(nowMs)).toISOString().slice(0, 19).replace('T', ' ')
}

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
export function getAccountBalance(db, accountId = null) {
  // M1c: per-account balance seam. When a worker passes an account id, its
  // `acct:<id>:account_balance_usd` value (stamped by the loop's balance
  // refresh) wins; the legacy global key remains the fallback so the
  // single-account era behaves identically.
  if (accountId != null) {
    const scoped = Number(getState(db, `acct:${accountId}:account_balance_usd`))
    if (Number.isFinite(scoped) && scoped > 0) return scoped
  }
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
export function getAccountLeverage(db, config, accountId = null) {
  if (accountId != null) {
    const scoped = Number(getState(db, `acct:${accountId}:account_leverage`))
    if (Number.isFinite(scoped) && scoped > 0) return scoped
  }
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

// Broker snapshot fresher than this still counts as truth; older falls back
// to the local estimate. The monitor refreshes it every ~30s, so 5 minutes
// of grace only matters across agent restarts / broker-route hiccups.
const BROKER_MARGIN_MAX_AGE_MS = 5 * 60_000

/**
 * Portfolio margin status — BROKER TRUTH FIRST. cTrader reports each open
 * position's real margin (summed into broker_snapshot_cache_json.account
 * .health.usedMargin by /actions/broker-positions, refreshed ~30s by the
 * monitor); our own requiredMargin() sum is only an estimate that drifts
 * from the broker (owner 2026-07-24: estimated used margin sat 28% above
 * the cap while the pipeline kept strategizing trades that could never
 * pass). Falls back to the estimate only when the snapshot is missing or
 * stale — never silently, `source` says which figure was used.
 *
 * Returns { usedMargin, cap, headroom, source: 'broker'|'estimate' },
 * or null when balance is unknown (margin checks are skipped then, same
 * as the gate itself).
 */
export function portfolioMarginStatus(db, config, { balance, leverage, openPositions = null, rates = null } = {}) {
  if (!(balance > 0)) return null
  let usedMargin = null
  let source = 'broker'
  try {
    const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
    const bm = snap?.account?.health?.usedMargin
    const ageMs = snap?.fetchedAt ? Date.now() - Date.parse(snap.fetchedAt) : Infinity
    if (Number.isFinite(bm) && bm >= 0 && ageMs < BROKER_MARGIN_MAX_AGE_MS) usedMargin = bm
  } catch { /* unreadable snapshot → estimate */ }
  if (usedMargin == null) {
    source = 'estimate'
    usedMargin = 0
    // M1 scoping: margin is a per-account quantity. NOTE the broker-truth
    // branch above reads the SELECTED account's snapshot — per-account
    // snapshots arrive with M2's workers; until then callers evaluating a
    // non-selected account get the estimate path via this filter.
    const acct = getState(db, 'ctrader_account_id') || null
    const rows = openPositions ?? db.prepare(`
      SELECT mp.symbol, mp.entry_price, t.volume AS volume
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.status = 'active'
        AND (mp.account_id = ? OR mp.account_id IS NULL OR ? IS NULL)
    `).all(acct, acct)
    for (const p of rows) {
      if (!(Number(p.volume) > 0) || !(Number(p.entry_price) > 0)) continue
      try {
        usedMargin += requiredMargin(p.symbol, Number(p.volume), Number(p.entry_price), leverage, rates).marginRequired || 0
      } catch { /* skip a row we can't price — never block sizing on one bad row */ }
    }
  }
  const cap = balance * config.maxMarginUsagePct
  return { usedMargin, cap, headroom: cap - usedMargin, source }
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
export function drawdownDeriskFactor(db, balance, cfg, accountId = null) {
  if (!cfg?.deriskOnDrawdown || !(balance > 0)) return 1
  try {
    // M1 scoping: the anti-tilt window looks at THIS account's realized
    // P&L, not the whole book (NULL legacy rows count everywhere).
    const acct = accountId != null ? String(accountId) : (getState(db, 'ctrader_account_id') || null)
    const row = db.prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND closed_at >= datetime('now', ?)
         AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
    ).get(`-${Math.max(1, Math.round(cfg.deriskWindowHours || 24))} hours`, acct, acct)
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
  // Positive expectancy on the strategy's OWN record → ship the full
  // risk-budgeted size. Kelly is a VETO here, not a down-sizer: the 5% algo cap
  // already bounds the budget and the drawdown-derisk already halves it in a
  // slump. The prior `kelly * kellyFraction * 4` reduced to full Kelly, then
  // HAIRCUT proven strategies below the budget while unproven (<30-trade,
  // kelly-skipped) ones shipped the full 5% — sizing ran backwards to
  // conviction. A proven strategy now gets the same budget its edge earned.
  return { volume: defaultVolume, note: `kelly=${kelly.toFixed(3)} ok` }
}

/**
 * Per-strategy live performance for the Kelly / expectancy gate. Using the
 * GLOBAL performance snapshot let ONE losing strategy (fib) veto EVERY
 * strategy for "negative expectancy" — even proven ones with their own edge.
 * This scopes expectancy to the proposal's OWN record, so a strategy with too
 * few trades returns a small total_trades and kellyVolume SKIPS (default size)
 * instead of vetoing. Shape matches performance_snapshots columns.
 */
export function strategyPerfStats(db, strategyKey, windowDays = 30) {
  if (!strategyKey) return null
  try {
    return db.prepare(
      `SELECT COUNT(*) AS total_trades,
              AVG(CASE WHEN net_pnl > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
              AVG(CASE WHEN net_pnl > 0 THEN net_pnl END) AS avg_win,
              AVG(CASE WHEN net_pnl <= 0 THEN net_pnl END) AS avg_loss
       FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND COALESCE(label_strategy, strategy) = ?
         AND closed_at >= datetime('now', ?)`
    ).get(strategyKey, `-${Math.max(1, Math.round(windowDays))} days`)
  } catch { return null }
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
  // M1 scoped reads: every per-account query below filters to the account
  // this proposal is FOR (proposal.accountId when a worker passes one, else
  // the selected account), NULL-tolerantly — legacy unstamped rows count
  // for every account, which only makes guards stricter, never looser.
  // In the single-account era (backfill stamped everything to the one
  // account) this is behaviour-identical to the previous global queries.
  const acct = proposal.accountId != null ? String(proposal.accountId) : (getState(db, 'ctrader_account_id') || null)
  // M1c: balance/leverage resolve per-account too (acct:<id>: keys when
  // stamped, legacy global keys otherwise) so caps size off the right equity.
  const balance = getAccountBalance(db, acct)
  const leverage = getAccountLeverage(db, config, acct)
  const checks = { balance, leverage, account_id: acct }

  // ---- 0. 5A global capital protection -----------------------------------
  // Portfolio-wide guards evaluated across ALL accounts' rows before any
  // per-account rule: a global halt, a portfolio daily-loss cap, and a total
  // open-position cap. Asymmetric by design — this layer can only ADD a
  // veto, never loosen a per-account one. All knobs default OFF (no
  // global_guards_json → no-op).
  const gg = evaluateGlobalGuards(db)
  Object.assign(checks, gg.checks)
  if (!gg.ok) return veto(gg.reason, checks, proposal)

  // ---- 0b. News-window entry gate (config-gated, default OFF) -------------
  // Pure in-memory check against the cached calendar — microseconds, no
  // network. Missing/stale data means no block, never a stuck veto.
  if (config.newsGateEnabled) {
    const ev = newsWindowEvent(cachedEventsSync(db), proposal.symbol, Date.now(), {
      minBefore: Number(config.newsGateMinBefore) || 15,
      minAfter: Number(config.newsGateMinAfter) || 15,
      impacts: Array.isArray(config.newsGateImpacts) && config.newsGateImpacts.length
        ? config.newsGateImpacts : ['High'],
    })
    if (ev) {
      checks.news_window = `${ev.country} ${ev.title} @ ${new Date(ev.t).toISOString()}`
      return veto(`news_window: ${ev.impact} ${ev.country} ${ev.title}`, checks, proposal)
    }
  }

  // ---- 0c. Carry-cost gate (config-gated, default OFF) --------------------
  // Side-aware nightly swap check against the broker rates cached in
  // symbol_hours. Sync DB read only. Unknown/missing swap data = no block.
  // (null threshold must NOT coerce to 0 — Number(null) === 0 would veto
  // every negative-swap side; same bug class the perf-ledger tests caught.)
  if (config.carryGateEnabled && config.carryMaxNegativeSwapPoints != null
    && Number.isFinite(Number(config.carryMaxNegativeSwapPoints))) {
    const cc = evaluateCarryCost(db, proposal, Number(config.carryMaxNegativeSwapPoints))
    if (cc) {
      checks.carry_cost = cc.detail
      if (cc.vetoReason) return veto(cc.vetoReason, checks, proposal)
    }
  }

  // ---- 1. Daily loss limit ------------------------------------------------
  // Prefer % of balance when set; fall back to absolute USD cap.
  // Day anchor = FX day open, 17:00 NY (owner sign-off 2026-07-24) — was
  // UTC midnight. Format-proof timestamp comparison — REAL BUG caught by
  // the M1 contamination test (2026-07-24): closeTradeRow writes closed_at
  // via SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (space), while this
  // query compared against toISOString() → "YYYY-MM-DDTHH:…". The space
  // (0x20) sorts BEFORE 'T' (0x54), so every production-closed trade of
  // the day compared LESS-THAN the day-start string and was silently
  // EXCLUDED from the daily-loss sum — the daily cap was blind to them.
  // Normalizing the 'T' away makes both formats compare correctly.
  const dayStartSql = fxDayStartSql()
  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
       WHERE status = 'closed' AND REPLACE(closed_at, 'T', ' ') >= ?
         AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
    )
    .get(dayStartSql, acct, acct)
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
             AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
           ORDER BY closed_at DESC LIMIT ?`
        )
        .all(acct, acct, streakLimit)
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
             t.opened_at, t.volume AS volume, COALESCE(t.label_strategy, t.strategy) AS tradeStrategy
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.status = 'active'
        AND (mp.account_id = ? OR mp.account_id IS NULL OR ? IS NULL)
    `)
    .all(acct, acct)
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

  // ---- 10. Kelly sizing (PER-STRATEGY expectancy) ------------------------
  // Scope expectancy to the proposal's OWN strategy so a losing strategy can't
  // veto a proven one (fib's losses were blocking RSI-2/VP for "negative
  // expectancy"). An UNLABELLED proposal has no strategy record to judge, so it
  // SKIPS the Kelly veto (sizes by the risk budget) rather than inheriting the
  // GLOBAL snapshot — that global fallback re-introduced the exact bug this
  // section fixes (the whole-book aggregate is negative by design, so one loser
  // vetoed everything). All the other gates (drawdown, exposure, min-RR,
  // min-SL, margin) still apply to unlabelled proposals.
  const latestStats = proposal.strategy
    ? strategyPerfStats(db, proposal.strategy)
    : null
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

  // ---- 11. Margin-headroom gate (AGGREGATE, shrink-to-fit) ---------------
  // The new position PLUS the margin already locked by every open position
  // must not exceed `maxMarginUsagePct` of balance. This used to check only the
  // single new trade against the cap — so 16 trades each passed in isolation
  // while COLLECTIVELY locking ~79% of equity and margin-calling the account
  // (owner hit exactly this: 16 open, margin level 126% vs 50% stop-out). Now
  // the cap is a true PORTFOLIO ceiling, which is what its comment always
  // claimed. Only enforced when balance is set.
  //
  // Owner (2026-07-22): "why do we need such a big lot size when realistically
  // cannot trade" — this used to compute the FULL risk/Kelly size, discover
  // it was e.g. 6x over the remaining margin headroom, and discard the whole
  // trade. That's wasted sizing work, not a wasted trade: whatever headroom
  // IS left can usually still take a smaller, correctly-margined position.
  // Margin scales linearly with volume for a fixed price, so shrink
  // proportionally to whatever fits, floor it to the broker's 0.01-lot
  // granularity (computeRiskBasedVolume's own rounding), and only veto
  // outright when even the minimum lot size doesn't fit — i.e. when
  // shrinking would produce nothing tradeable, not merely something smaller.
  let volume = finalVolume
  if (balance != null) {
    const rates = scanRates(db)
    let { notional, marginRequired } = requiredMargin(
      proposal.symbol, volume, entry, leverage, rates,
    )
    // Margin already committed — broker truth when the snapshot is fresh,
    // the per-row estimate otherwise (see portfolioMarginStatus).
    const pm = portfolioMarginStatus(db, config, { balance, leverage, openPositions, rates })
    const usedMargin = pm.usedMargin
    const marginCap = pm.cap
    const headroom = pm.headroom
    checks.margin_used_usd = Number(usedMargin.toFixed(2))
    checks.margin_cap_usd = Number(marginCap.toFixed(2))
    checks.margin_source = pm.source

    if (headroom <= 0) {
      // Existing positions alone already consume the whole cap — no amount
      // of shrinking the NEW trade helps, so there's nothing to compute.
      checks.margin_required_usd = Number(marginRequired.toFixed(2))
      checks.margin_total_usd = Number((usedMargin + marginRequired).toFixed(2))
      return veto(
        `insufficient_margin total=${(usedMargin + marginRequired).toFixed(2)} (used=${usedMargin.toFixed(2)} + new=${marginRequired.toFixed(2)}) cap=${marginCap.toFixed(2)} leverage=${leverage} · no headroom left to shrink into`,
        checks, proposal,
      )
    }

    if (marginRequired > headroom) {
      // Shrink proportionally to whatever margin IS available, floored to
      // the same 0.01-lot granularity computeRiskBasedVolume uses.
      const shrunk = Math.floor(volume * (headroom / marginRequired) * 100) / 100
      if (shrunk < config.minLotSize) {
        checks.margin_required_usd = Number(marginRequired.toFixed(2))
        checks.margin_total_usd = Number((usedMargin + marginRequired).toFixed(2))
        return veto(
          `insufficient_margin total=${(usedMargin + marginRequired).toFixed(2)} (used=${usedMargin.toFixed(2)} + new=${marginRequired.toFixed(2)}) cap=${marginCap.toFixed(2)} leverage=${leverage} · shrunk_to=${shrunk} below min_lot=${config.minLotSize}`,
          checks, proposal,
        )
      }
      const before = volume
      volume = shrunk
      ;({ notional, marginRequired } = requiredMargin(proposal.symbol, volume, entry, leverage, rates))
      checks.margin_shrink = { from: before, to: volume, reason: 'margin_headroom' }
      sizingNote = sizingNote ? `${sizingNote} · shrunk_for_margin=${before}->${volume}` : `shrunk_for_margin=${before}->${volume}`
    }

    checks.notional_usd = Number(notional.toFixed(2))
    checks.margin_required_usd = Number(marginRequired.toFixed(2))
    checks.margin_total_usd = Number((usedMargin + marginRequired).toFixed(2))
  }

  const combinedNote = sizingNote ? `${sizingNote} · ${kellyNote}` : kellyNote
  return {
    approved: true,
    adjusted_volume: volume,
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
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    proposal.symbol,
    proposal.side,
    result.approved ? 1 : 0,
    result.veto_reason || null,
    JSON.stringify(result.checks || {}),
    JSON.stringify(proposal),
    // M1 provenance: which account this decision was evaluated FOR — the
    // proposal's own account when the caller carries one, else the
    // currently-selected account (identical in the single-account era).
    proposal.accountId != null ? String(proposal.accountId) : (getState(db, 'ctrader_account_id') || null),
    new Date().toISOString()
  )
}
